import { createHash, randomBytes } from "node:crypto";
import { createSqlClient, getDatabaseUrl } from "@mba/db";
import { Elysia } from "elysia";

type SqlClient = ReturnType<typeof createSqlClient>;

export type InvitesConfig = {
  databaseUrl: string;
};

type SessionUser = { id: string };
type WorkspaceAccess = { id: string; name: string; role: WorkspaceRole };
type WorkspaceRole = "owner" | "admin" | "member";
type InviteRole = "admin" | "member";
type InviteRow = {
  id: string;
  workspaceId: string;
  role: InviteRole;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};
type MemberRow = {
  id: string;
  workspaceId: string;
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  joinedAt: Date;
};

const sessionCookieName = "mba_session";
const inviteTokenBytes = 32;

function defaultInvitesConfig(partial: Partial<InvitesConfig> = {}): InvitesConfig {
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

function cleanInviteRole(value: unknown): InviteRole | null {
  return value === "admin" || value === "member" ? value : null;
}

function cleanMemberRole(value: unknown): WorkspaceRole | null {
  return value === "owner" || value === "admin" || value === "member" ? value : null;
}

function canInvite(actorRole: WorkspaceRole, inviteRole: InviteRole): boolean {
  return actorRole === "owner" || (actorRole === "admin" && inviteRole === "member");
}

function canChangeRole(actorRole: WorkspaceRole, targetRole: WorkspaceRole): boolean {
  return actorRole === "owner" && targetRole !== "owner";
}

function canRemoveMember(actorRole: WorkspaceRole, targetRole: WorkspaceRole): boolean {
  if (targetRole === "owner") {
    return false;
  }
  return actorRole === "owner" || (actorRole === "admin" && targetRole === "member");
}

function serializeInvite(row: InviteRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    role: row.role,
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString()
  };
}

function serializeMember(row: MemberRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    email: row.email,
    name: row.name,
    role: row.role,
    joinedAt: row.joinedAt.toISOString()
  };
}

async function withClient<T>(config: InvitesConfig, run: (client: SqlClient) => Promise<T>): Promise<T> {
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

async function requireSession(client: SqlClient, request: Request): Promise<SessionUser | Response> {
  const user = await getSessionUser(client, request);
  return user ?? jsonResponse({ error: { code: "auth.required" } }, { status: 401 });
}

async function selectWorkspaceAccess(client: SqlClient, userId: string, workspaceId: string): Promise<WorkspaceAccess | null> {
  const [workspace] = await client<WorkspaceAccess[]>`
    select workspaces.id,
      workspaces.name,
      workspace_members.role::text as role
    from workspaces
    inner join workspace_members on workspace_members.workspace_id = workspaces.id
    where workspace_members.user_id = ${userId}
      and workspaces.id = ${workspaceId}
      and workspaces.soft_deleted_at is null
    limit 1
  `;

  return workspace ?? null;
}

async function selectMember(client: SqlClient, workspaceId: string, memberId: string): Promise<MemberRow | null> {
  const [member] = await client<MemberRow[]>`
    select workspace_members.id,
      workspace_members.workspace_id as "workspaceId",
      workspace_members.user_id as "userId",
      users.email,
      users.name,
      workspace_members.role::text as role,
      workspace_members.joined_at as "joinedAt"
    from workspace_members
    inner join users on users.id = workspace_members.user_id
    where workspace_members.id = ${memberId}
      and workspace_members.workspace_id = ${workspaceId}
    limit 1
  `;

  return member ?? null;
}

export function createInviteRoutes(partialConfig: Partial<InvitesConfig> = {}) {
  const config = defaultInvitesConfig(partialConfig);

  return new Elysia()
    .get("/workspaces/:workspaceId/invites", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (workspace.role === "member") {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const rows = await client<InviteRow[]>`
        select id,
          workspace_id as "workspaceId",
          role::text as role,
          expires_at as "expiresAt",
          used_at as "usedAt",
          revoked_at as "revokedAt",
          created_at as "createdAt"
        from invites
        where workspace_id = ${workspace.id}
        order by created_at desc
      `;

      return jsonResponse({ invites: rows.map(serializeInvite) });
    }))
    .post("/workspaces/:workspaceId/invites", async ({ request, params, body }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const payload = parseJsonObject(body);
      const role = cleanInviteRole(payload.role);
      if (!role) {
        return jsonResponse({ error: { code: "invite.role_invalid" } }, { status: 400 });
      }
      if (!canInvite(workspace.role, role)) {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const token = randomBytes(inviteTokenBytes).toString("base64url");
      const [created] = await client<InviteRow[]>`
        insert into invites (workspace_id, role, token_hash, created_by_user_id, expires_at)
        values (${workspace.id}, ${role}, ${hashValue(token)}, ${user.id}, now() + interval '7 days')
        returning id,
          workspace_id as "workspaceId",
          role::text as role,
          expires_at as "expiresAt",
          used_at as "usedAt",
          revoked_at as "revokedAt",
          created_at as "createdAt"
      `;

      if (!created) {
        return jsonResponse({ error: { code: "invite.create_failed" } }, { status: 500 });
      }

      return jsonResponse({ invite: serializeInvite(created), token }, { status: 201 });
    }))
    .post("/workspaces/:workspaceId/invites/:inviteId/revoke", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (workspace.role === "member") {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const [updated] = await client<InviteRow[]>`
        update invites
        set revoked_at = coalesce(revoked_at, now())
        where id = ${params.inviteId}
          and workspace_id = ${workspace.id}
        returning id,
          workspace_id as "workspaceId",
          role::text as role,
          expires_at as "expiresAt",
          used_at as "usedAt",
          revoked_at as "revokedAt",
          created_at as "createdAt"
      `;

      return updated ? jsonResponse({ invite: serializeInvite(updated) }) : jsonResponse({ error: { code: "invite.not_found" } }, { status: 404 });
    }))
    .get("/invites/:token", async ({ params }) => withClient(config, async (client) => {
      const [invite] = await client<{ workspace_name: string; role: InviteRole }[]>`
        select workspaces.name as workspace_name,
          invites.role::text as role
        from invites
        inner join workspaces on workspaces.id = invites.workspace_id
        where invites.token_hash = ${hashValue(params.token)}
          and invites.revoked_at is null
          and invites.used_at is null
          and invites.expires_at > now()
          and workspaces.soft_deleted_at is null
        limit 1
      `;

      return invite
        ? jsonResponse({ workspaceName: invite.workspace_name, role: invite.role })
        : jsonResponse({ error: { code: "invite.not_found" } }, { status: 404 });
    }))
    .post("/invites/:token/accept", async ({ request, params, body }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const payload = parseJsonObject(body);
      if (payload.confirm !== true) {
        return jsonResponse({ error: { code: "invite.confirmation_required" } }, { status: 400 });
      }

      const result = await client.begin(async (transaction) => {
        const [invite] = await transaction<{ id: string; workspace_id: string; role: InviteRole }[]>`
          select invites.id,
            invites.workspace_id,
            invites.role::text as role
          from invites
          inner join workspaces on workspaces.id = invites.workspace_id
          where invites.token_hash = ${hashValue(params.token)}
            and invites.revoked_at is null
            and invites.used_at is null
            and invites.expires_at > now()
            and workspaces.soft_deleted_at is null
          for update of invites
          limit 1
        `;
        if (!invite) {
          return null;
        }

        const [member] = await transaction<MemberRow[]>`
          insert into workspace_members (workspace_id, user_id, role, invited_by_user_id)
          values (${invite.workspace_id}, ${user.id}, ${invite.role}, ${user.id})
          on conflict (workspace_id, user_id) do update
          set role = excluded.role,
            updated_at = now()
          returning id,
            workspace_id as "workspaceId",
            user_id as "userId",
            (select email from users where id = ${user.id}) as email,
            (select name from users where id = ${user.id}) as name,
            role::text as role,
            joined_at as "joinedAt"
        `;

        await transaction`
          update invites
          set used_at = now(), used_by_user_id = ${user.id}
          where id = ${invite.id}
            and workspace_id = ${invite.workspace_id}
        `;

        return member ?? null;
      });

      return result ? jsonResponse({ member: serializeMember(result) }) : jsonResponse({ error: { code: "invite.not_found" } }, { status: 404 });
    }))
    .get("/workspaces/:workspaceId/members", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const rows = await client<MemberRow[]>`
        select workspace_members.id,
          workspace_members.workspace_id as "workspaceId",
          workspace_members.user_id as "userId",
          users.email,
          users.name,
          workspace_members.role::text as role,
          workspace_members.joined_at as "joinedAt"
        from workspace_members
        inner join users on users.id = workspace_members.user_id
        where workspace_members.workspace_id = ${workspace.id}
        order by workspace_members.joined_at asc
      `;

      return jsonResponse({ members: rows.map(serializeMember) });
    }))
    .patch("/workspaces/:workspaceId/members/:memberId/role", async ({ request, params, body }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const payload = parseJsonObject(body);
      const role = cleanMemberRole(payload.role);
      if (!role || role === "owner") {
        return jsonResponse({ error: { code: "member.role_invalid" } }, { status: 400 });
      }

      const target = await selectMember(client, workspace.id, params.memberId);
      if (!target) {
        return jsonResponse({ error: { code: "member.not_found" } }, { status: 404 });
      }
      if (!canChangeRole(workspace.role, target.role)) {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const [updated] = await client<MemberRow[]>`
        update workspace_members
        set role = ${role}, updated_at = now()
        where id = ${target.id}
          and workspace_id = ${workspace.id}
          and role <> 'owner'
        returning id,
          workspace_id as "workspaceId",
          user_id as "userId",
          (select email from users where id = workspace_members.user_id) as email,
          (select name from users where id = workspace_members.user_id) as name,
          role::text as role,
          joined_at as "joinedAt"
      `;

      return updated ? jsonResponse({ member: serializeMember(updated) }) : jsonResponse({ error: { code: "member.not_found" } }, { status: 404 });
    }))
    .delete("/workspaces/:workspaceId/members/:memberId", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const target = await selectMember(client, workspace.id, params.memberId);
      if (!target) {
        return jsonResponse({ error: { code: "member.not_found" } }, { status: 404 });
      }
      if (!canRemoveMember(workspace.role, target.role)) {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      await client`
        delete from workspace_members
        where id = ${target.id}
          and workspace_id = ${workspace.id}
          and role <> 'owner'
      `;

      return jsonResponse({ ok: true });
    }))
    .post("/workspaces/:workspaceId/ownership-transfer", async ({ request, params, body }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (workspace.role !== "owner") {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const payload = parseJsonObject(body);
      const targetMemberId = typeof payload.memberId === "string" ? payload.memberId : null;
      if (!targetMemberId) {
        return jsonResponse({ error: { code: "ownership.target_required" } }, { status: 400 });
      }

      const result = await client.begin(async (transaction) => {
        const [target] = await transaction<{ id: string; role: WorkspaceRole }[]>`
          select id, role::text as role
          from workspace_members
          where id = ${targetMemberId}
            and workspace_id = ${workspace.id}
          for update
          limit 1
        `;
        if (!target || target.role !== "admin") {
          return null;
        }

        await transaction`
          update workspace_members
          set role = 'admin', updated_at = now()
          where workspace_id = ${workspace.id}
            and user_id = ${user.id}
            and role = 'owner'
        `;
        await transaction`
          update workspace_members
          set role = 'owner', updated_at = now()
          where workspace_id = ${workspace.id}
            and id = ${target.id}
            and role = 'admin'
        `;

        const [ownerCount] = await transaction<{ count: string }[]>`
          select count(*)::text as count
          from workspace_members
          where workspace_id = ${workspace.id}
            and role = 'owner'
        `;
        if (ownerCount?.count !== "1") {
          throw new Error("workspace.owner_invariant_failed");
        }

        return target.id;
      });

      if (!result) {
        return jsonResponse({ error: { code: "ownership.target_invalid" } }, { status: 400 });
      }

      const members = await client<MemberRow[]>`
        select workspace_members.id,
          workspace_members.workspace_id as "workspaceId",
          workspace_members.user_id as "userId",
          users.email,
          users.name,
          workspace_members.role::text as role,
          workspace_members.joined_at as "joinedAt"
        from workspace_members
        inner join users on users.id = workspace_members.user_id
        where workspace_members.workspace_id = ${workspace.id}
        order by workspace_members.joined_at asc
      `;

      return jsonResponse({ members: members.map(serializeMember) });
    }));
}
