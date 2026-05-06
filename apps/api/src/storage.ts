import { createHash } from "node:crypto";
import { createSqlClient, getDatabaseUrl } from "@mba/db";
import { provisionWorkspaceStorageWithClient } from "@mba/storage";
import { Elysia } from "elysia";

type SqlClient = ReturnType<typeof createSqlClient>;

export type StorageConfig = {
  databaseUrl: string;
};

type SessionUser = { id: string };
type WorkspaceAccess = { id: string; role: string; onboardingStep: string; storageStatus: string };
type StorageRow = { id: string; provider: string; mode: string; displayName: string; status: string; isCurrent: boolean; activatedAt: Date | null };

const sessionCookieName = "mba_session";

function defaultStorageConfig(partial: Partial<StorageConfig> = {}): StorageConfig {
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

async function withClient<T>(config: StorageConfig, run: (client: SqlClient) => Promise<T>): Promise<T> {
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
      workspace_members.role::text as role,
      workspaces.onboarding_step::text as "onboardingStep",
      workspaces.storage_status::text as "storageStatus"
    from workspaces
    inner join workspace_members on workspace_members.workspace_id = workspaces.id
    where workspace_members.user_id = ${userId}
      and workspaces.id = ${workspaceId}
      and workspaces.soft_deleted_at is null
    limit 1
  `;

  return workspace ?? null;
}

function serializeStorage(row: StorageRow | null, storageStatus: string) {
  return {
    status: storageStatus,
    config: row ? {
      id: row.id,
      provider: row.provider,
      mode: row.mode,
      displayName: row.displayName,
      status: row.status,
      isCurrent: row.isCurrent,
      activatedAt: row.activatedAt?.toISOString() ?? null
    } : null
  };
}

function canRetryProvisioning(workspace: WorkspaceAccess): boolean {
  if (workspace.storageStatus !== "failed") {
    return false;
  }
  if (workspace.onboardingStep !== "complete") {
    return workspace.role === "owner";
  }
  return workspace.role === "owner" || workspace.role === "admin";
}

export function createStorageRoutes(partialConfig: Partial<StorageConfig> = {}) {
  const config = defaultStorageConfig(partialConfig);

  return new Elysia()
    .get("/workspaces/:workspaceId/storage", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const [storage] = await client<StorageRow[]>`
        select id,
          provider::text as provider,
          mode::text as mode,
          display_name as "displayName",
          status::text as status,
          is_current as "isCurrent",
          activated_at as "activatedAt"
        from backup_storage_configs
        where workspace_id = ${workspace.id}
          and is_current = true
        limit 1
      `;

      return jsonResponse({ storage: serializeStorage(storage ?? null, workspace.storageStatus) });
    }))
    .post("/workspaces/:workspaceId/storage/retry", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (!canRetryProvisioning(workspace)) {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      await client`
        update workspaces
        set storage_status = 'provisioning', updated_at = now()
        where id = ${workspace.id}
          and storage_status = 'failed'
      `;
      const result = await provisionWorkspaceStorageWithClient(client, workspace.id);

      return jsonResponse({ storage: { status: result.status === "ready" ? "ready" : "failed", storageConfigId: result.storageConfigId ?? null } }, { status: result.status === "ready" ? 200 : 500 });
    }));
}
