import { createHash } from "node:crypto";
import { AuditLogService, createSqlClient, getDatabaseUrl } from "@mba/db";
import type { AuditLogEntry } from "@mba/shared";
import { Elysia } from "elysia";

type SqlClient = ReturnType<typeof createSqlClient>;

export type AuditRoutesConfig = {
  databaseUrl: string;
};

type SessionUser = { id: string };
type WorkspaceAccess = { id: string };

const sessionCookieName = "mba_session";

function defaultAuditConfig(partial: Partial<AuditRoutesConfig> = {}): AuditRoutesConfig {
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

async function withClient<T>(config: AuditRoutesConfig, run: (client: SqlClient) => Promise<T>): Promise<T> {
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

  const [session] = await client<{ user_id: string }[]>`
    select sessions.user_id
    from sessions
    inner join users on users.id = sessions.user_id
    where sessions.session_token_hash = ${hashValue(sessionToken)}
      and sessions.invalidated_at is null
      and sessions.expires_at > now()
      and users.disabled_at is null
    limit 1
  `;

  return session ? { id: session.user_id } : null;
}

async function selectWorkspaceAccess(client: SqlClient, userId: string, workspaceId: string): Promise<WorkspaceAccess | null> {
  const [workspace] = await client<WorkspaceAccess[]>`
    select workspaces.id
    from workspaces
    inner join workspace_members on workspace_members.workspace_id = workspaces.id
    where workspace_members.user_id = ${userId}
      and workspaces.id = ${workspaceId}
      and workspaces.soft_deleted_at is null
    limit 1
  `;

  return workspace ?? null;
}

export function createAuditRoutes(partialConfig: Partial<AuditRoutesConfig> = {}) {
  const config = defaultAuditConfig(partialConfig);
  const auditService = new AuditLogService(config.databaseUrl);

  return new Elysia().get("/workspaces/:workspaceId/audit-log", async ({ request, params }) => withClient(config, async (client) => {
    const user = await getSessionUser(client, request);
    if (!user) {
      return jsonResponse({ error: { code: "auth.required" } }, { status: 401 });
    }

    const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
    if (!workspace) {
      return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
    }

    const auditLog: AuditLogEntry[] = await auditService.listWorkspace(workspace.id);
    return jsonResponse({ auditLog });
  }));
}
