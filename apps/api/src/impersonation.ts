import { createHash } from "node:crypto";
import { appendAuditLogWithClient, createSqlClient, getDatabaseUrl } from "@mba/db";
import { Elysia } from "elysia";

type SqlClient = ReturnType<typeof createSqlClient>;

export type ImpersonationRoutesConfig = {
  databaseUrl: string;
};

type SessionUser = {
  id: string;
  sessionId: string;
  systemAdminId: string | null;
  systemRole: "system_admin" | "system_owner" | null;
};

type WorkspaceAccess = {
  id: string;
  role: string;
};

const sessionCookieName = "mba_session";

function defaultImpersonationConfig(partial: Partial<ImpersonationRoutesConfig> = {}): ImpersonationRoutesConfig {
  return { databaseUrl: partial.databaseUrl ?? getDatabaseUrl() };
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readableCookie(value: string | null, name: string): string | null {
  if (!value) {
    return null;
  }

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.match(new RegExp(`(?:^|; )${escaped}=([^;]+)`))?.[1] ?? null;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...init.headers }
  });
}

function parseJsonObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  return body as Record<string, unknown>;
}

function cleanReason(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 500 ? trimmed : null;
}

async function withClient<T>(config: ImpersonationRoutesConfig, run: (client: SqlClient) => Promise<T>): Promise<T> {
  const client = createSqlClient(config.databaseUrl);
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function getSessionUser(client: SqlClient, request: Request): Promise<SessionUser | null> {
  const sessionToken = readableCookie(request.headers.get("cookie"), sessionCookieName);
  if (!sessionToken) {
    return null;
  }

  const [session] = await client<{
    session_id: string;
    user_id: string;
    system_admin_id: string | null;
    system_role: "system_admin" | "system_owner" | null;
  }[]>`
    select sessions.id as session_id,
      sessions.user_id,
      system_admins.id as system_admin_id,
      system_admins.role::text as system_role
    from sessions
    inner join users on users.id = sessions.user_id
    left join system_admins on system_admins.user_id = sessions.user_id
      and system_admins.disabled_at is null
    where sessions.session_token_hash = ${hashValue(sessionToken)}
      and sessions.invalidated_at is null
      and sessions.expires_at > now()
      and users.disabled_at is null
    limit 1
  `;

  return session
    ? {
        id: session.user_id,
        sessionId: session.session_id,
        systemAdminId: session.system_admin_id,
        systemRole: session.system_role
      }
    : null;
}

async function requireSystemAdmin(client: SqlClient, request: Request): Promise<SessionUser | Response> {
  const user = await getSessionUser(client, request);
  if (!user) {
    return jsonResponse({ error: { code: "auth.required" } }, { status: 401 });
  }

  return user.systemRole ? user : jsonResponse({ error: { code: "admin.permission_denied" } }, { status: 403 });
}

async function selectWorkspaceAccess(client: SqlClient, userId: string, workspaceId: string): Promise<WorkspaceAccess | null> {
  const [workspace] = await client<WorkspaceAccess[]>`
    select workspaces.id,
      workspace_members.role::text as role
    from workspaces
    inner join workspace_members on workspace_members.workspace_id = workspaces.id
    where workspaces.id = ${workspaceId}
      and workspace_members.user_id = ${userId}
      and workspaces.soft_deleted_at is null
    limit 1
  `;

  return workspace ?? null;
}

async function writeImpersonationAudit(
  client: SqlClient,
  request: Request,
  user: SessionUser,
  workspaceId: string,
  eventType: "impersonation.start" | "impersonation.stop",
  targetId: string,
  reason: string,
  impersonationSessionId: string
) {
  await appendAuditLogWithClient(client, {
    workspaceId,
    eventType,
    targetType: "impersonation",
    targetId,
    result: "succeeded",
    metadata: {
      reason,
      adminActorUserId: user.id,
      effectiveActorUserId: targetId,
      impersonationSessionId
    },
    context: {
      actorType: "user",
      actorUserId: user.id,
      effectiveActorUserId: targetId,
      systemAdminId: user.systemAdminId,
      impersonationSessionId,
      requestId: request.headers.get("x-request-id"),
      sessionId: user.sessionId,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: request.headers.get("user-agent"),
      impersonationReason: reason
    }
  });
}

export function createImpersonationRoutes(partialConfig: Partial<ImpersonationRoutesConfig> = {}) {
  const config = defaultImpersonationConfig(partialConfig);

  return new Elysia()
    .post("/admin/impersonation/start", async ({ request, body }) => withClient(config, async (client) => {
      const user = await requireSystemAdmin(client, request);
      if (user instanceof Response) {
        return user;
      }

      const payload = parseJsonObject(body);
      const targetUserId = typeof payload.targetUserId === "string" ? payload.targetUserId : null;
      const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : null;
      const reason = cleanReason(payload.reason);

      if (!targetUserId || !workspaceId || !reason) {
        return jsonResponse({ error: { code: "impersonation.reason_required" } }, { status: 400 });
      }

      const workspace = await selectWorkspaceAccess(client, targetUserId, workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const existing = await client<{ id: string }[]>`
        select id
        from impersonation_sessions
        where admin_session_id = ${user.sessionId}
          and ended_at is null
        limit 1
      `;
      if (existing[0]) {
        await client`
          update impersonation_sessions
          set ended_at = now()
          where id = ${existing[0].id}
        `;
      }

      const [session] = await client<{
        id: string;
        started_at: Date;
      }[]>`
        insert into impersonation_sessions (admin_session_id, admin_user_id, target_user_id, reason)
        values (${user.sessionId}, ${user.id}, ${targetUserId}, ${reason})
        returning id, started_at
      `;
      if (!session) {
        return jsonResponse({ error: { code: "impersonation.start_failed" } }, { status: 500 });
      }

      await writeImpersonationAudit(client, request, user, workspaceId, "impersonation.start", targetUserId, reason, session.id);

      return jsonResponse({
        impersonation: {
          active: true,
          adminUserId: user.id,
          targetUserId,
          workspaceId,
          reason,
          startedAt: session.started_at.toISOString(),
          impersonationSessionId: session.id
        }
      }, { status: 201 });
    }))
    .post("/admin/impersonation/stop", async ({ request }) => withClient(config, async (client) => {
      const user = await requireSystemAdmin(client, request);
      if (user instanceof Response) {
        return user;
      }

      const [active] = await client<{
        id: string;
        target_user_id: string;
        reason: string;
        workspace_id: string | null;
      }[]>`
        select impersonation_sessions.id,
          impersonation_sessions.target_user_id,
          impersonation_sessions.reason,
          coalesce(
            sessions.active_workspace_id,
            (
              select workspace_members.workspace_id
              from workspace_members
              where workspace_members.user_id = impersonation_sessions.target_user_id
              order by case workspace_members.role
                when 'owner' then 1
                when 'admin' then 2
                else 3
              end,
              workspace_members.created_at asc
              limit 1
            )
          ) as workspace_id
        from impersonation_sessions
        inner join sessions on sessions.id = impersonation_sessions.admin_session_id
        where impersonation_sessions.admin_session_id = ${user.sessionId}
          and impersonation_sessions.ended_at is null
        limit 1
      `;

      if (!active) {
        return jsonResponse({ impersonation: null });
      }

      await client`
        update impersonation_sessions
        set ended_at = now()
        where id = ${active.id}
      `;

      if (active.workspace_id) {
        await writeImpersonationAudit(client, request, user, active.workspace_id, "impersonation.stop", active.target_user_id, active.reason, active.id);
      }

      return jsonResponse({ impersonation: null });
    }));
}
