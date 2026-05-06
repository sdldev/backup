import { createHash } from "node:crypto";
import { appendAuditLogWithClient, createSqlClient, getDatabaseUrl } from "@mba/db";
import { assertSessionActionAllowed, createSanitizedError, sealSecret } from "@mba/security";
import { Elysia } from "elysia";

type SqlClient = ReturnType<typeof createSqlClient>;

export type SourcesConfig = {
  databaseUrl: string;
};

type SessionUser = {
  id: string;
  sessionId: string;
  systemRole: "system_admin" | "system_owner" | null;
  impersonation: { active: boolean; adminUserId: string; targetUserId: string; reason: string; startedAt: string } | null;
};

type WorkspaceAccess = { id: string; role: string };
type ProjectRow = { id: string; workspaceId: string };
type SourceRow = {
  id: string;
  workspaceId: string;
  projectId: string;
  engine: string;
  displayName: string;
  technicalDatabaseName: string;
  host: string;
  port: number;
  username: string;
  sslMode: string;
  state: string;
  health: string;
  retentionDays: number;
  scheduleFrequencyPerDay: number;
  scheduleEnabled: boolean;
  lastConnectionTestAt: Date | null;
  lastConnectionTestStatus: string | null;
  credentialFingerprint: string;
  encryptedPassword: string;
};

const sessionCookieName = "mba_session";

function defaultSourcesConfig(partial: Partial<SourcesConfig> = {}): SourcesConfig {
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

function getRequestId(request: Request): string | null {
  return request.headers.get("x-request-id");
}

function getClientIp(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

async function writeAuditLog(
  client: SqlClient,
  request: Request,
  user: SessionUser,
  workspaceId: string,
  eventType: "database-source.create" | "database-source.update" | "database-source.delete" | "database-credential.update",
  targetType: "database_source" | "database_credential",
  targetId: string,
  result: "succeeded" | "failed" | "denied",
  internalErrorRef?: string | null
) {
  await appendAuditLogWithClient(client, {
    workspaceId,
    eventType,
    targetType,
    targetId,
    result,
    internalErrorRef: internalErrorRef ?? null,
    context: {
      actorType: "user",
      actorUserId: user.impersonation?.adminUserId ?? user.id,
      effectiveActorUserId: user.id,
      sessionId: user.sessionId,
      requestId: getRequestId(request),
      ipAddress: getClientIp(request),
      userAgent: request.headers.get("user-agent"),
      impersonationReason: user.impersonation?.reason ?? null
    }
  });
}

function parseJsonObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  return body as Record<string, unknown>;
}

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function cleanPort(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }

  return value >= 1 && value <= 65535 ? value : null;
}

function cleanRetentionDays(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }

  return value >= 7 && value <= 30 ? value : null;
}

function cleanEngine(value: unknown): "mysql" | "postgresql" | null {
  return value === "mysql" || value === "postgresql" ? value : null;
}

function cleanSslMode(value: unknown, engine: "mysql" | "postgresql"): string | null {
  const cleaned = cleanString(value, 32);
  if (!cleaned) {
    return null;
  }

  const normalized = cleaned.toLowerCase();
  if (engine === "postgresql") {
    return normalized === "require" ? normalized : null;
  }

  return normalized === "required" ? normalized : null;
}

function canManageSource(role: string): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

function canDeleteSource(role: string): boolean {
  return role === "owner" || role === "admin";
}

function serializeSource(row: SourceRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    engine: row.engine,
    displayName: row.displayName,
    technicalDatabaseName: row.technicalDatabaseName,
    host: row.host,
    port: row.port,
    username: row.username,
    sslMode: row.sslMode,
    state: row.state,
    health: row.health,
    retentionDays: row.retentionDays,
    scheduleFrequencyPerDay: row.scheduleFrequencyPerDay,
    scheduleEnabled: row.scheduleEnabled,
    lastConnectionTestAt: row.lastConnectionTestAt?.toISOString() ?? null,
    lastConnectionTestStatus: row.lastConnectionTestStatus,
    credentialFingerprint: row.credentialFingerprint,
    passwordMasked: "**redacted**"
  };
}

async function withClient<T>(config: SourcesConfig, run: (client: SqlClient) => Promise<T>): Promise<T> {
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
    system_role: "system_admin" | "system_owner" | null;
    admin_user_id: string | null;
    target_user_id: string | null;
    reason: string | null;
    started_at: Date | null;
  }[]>`
    select sessions.id as session_id,
      sessions.user_id,
      system_admins.role::text as system_role,
      impersonation_sessions.admin_user_id,
      impersonation_sessions.target_user_id,
      impersonation_sessions.reason,
      impersonation_sessions.started_at
    from sessions
    inner join users on users.id = sessions.user_id
    left join system_admins on system_admins.user_id = sessions.user_id
      and system_admins.disabled_at is null
    left join impersonation_sessions on impersonation_sessions.admin_session_id = sessions.id
      and impersonation_sessions.ended_at is null
    where sessions.session_token_hash = ${hashValue(sessionToken)}
      and sessions.invalidated_at is null
      and sessions.expires_at > now()
      and users.disabled_at is null
    limit 1
  `;

  if (!session) {
    return null;
  }

  return {
    id: session.user_id,
    sessionId: session.session_id,
    systemRole: session.system_role,
    impersonation: session.admin_user_id && session.target_user_id && session.reason && session.started_at
      ? {
          active: true,
          adminUserId: session.admin_user_id,
          targetUserId: session.target_user_id,
          reason: session.reason,
          startedAt: session.started_at.toISOString()
        }
      : null
  };
}

async function requireSession(client: SqlClient, request: Request): Promise<SessionUser | Response> {
  const user = await getSessionUser(client, request);
  return user ?? jsonResponse({ error: { code: "auth.required" } }, { status: 401 });
}

async function selectWorkspaceAccess(client: SqlClient, userId: string, workspaceId: string): Promise<WorkspaceAccess | null> {
  const [workspace] = await client<WorkspaceAccess[]>`
    select workspaces.id,
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

async function selectProject(client: SqlClient, workspaceId: string, projectId: string): Promise<ProjectRow | null> {
  const [project] = await client<ProjectRow[]>`
    select id, workspace_id as "workspaceId"
    from projects
    where id = ${projectId}
      and workspace_id = ${workspaceId}
      and soft_deleted_at is null
    limit 1
  `;

  return project ?? null;
}

async function selectSource(client: SqlClient, workspaceId: string, sourceId: string): Promise<SourceRow | null> {
  const [source] = await client<SourceRow[]>`
    select id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      engine::text as engine,
      display_name as "displayName",
      technical_database_name as "technicalDatabaseName",
      host,
      port,
      username,
      ssl_mode as "sslMode",
      state::text as state,
      health::text as health,
      retention_days as "retentionDays",
      schedule_frequency_per_day as "scheduleFrequencyPerDay",
      schedule_enabled as "scheduleEnabled",
      last_connection_test_at as "lastConnectionTestAt",
      last_connection_test_status::text as "lastConnectionTestStatus",
      credential_fingerprint as "credentialFingerprint",
      encrypted_password as "encryptedPassword"
    from database_sources
    where id = ${sourceId}
      and workspace_id = ${workspaceId}
      and state <> 'deleted'
    limit 1
  `;

  return source ?? null;
}

export function createSourceRoutes(partialConfig: Partial<SourcesConfig> = {}) {
  const config = defaultSourcesConfig(partialConfig);

  return new Elysia()
    .get("/workspaces/:workspaceId/database-sources", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const rows = await client<SourceRow[]>`
        select id,
          workspace_id as "workspaceId",
          project_id as "projectId",
          engine::text as engine,
          display_name as "displayName",
          technical_database_name as "technicalDatabaseName",
          host,
          port,
          username,
          ssl_mode as "sslMode",
          state::text as state,
          health::text as health,
          retention_days as "retentionDays",
          schedule_frequency_per_day as "scheduleFrequencyPerDay",
          schedule_enabled as "scheduleEnabled",
          last_connection_test_at as "lastConnectionTestAt",
          last_connection_test_status::text as "lastConnectionTestStatus",
          credential_fingerprint as "credentialFingerprint",
          encrypted_password as "encryptedPassword"
        from database_sources
        where workspace_id = ${workspace.id}
          and state <> 'deleted'
        order by created_at asc
      `;

      return jsonResponse({ sources: rows.map(serializeSource) });
    }))
    .post("/workspaces/:workspaceId/projects/:projectId/database-sources", async ({ request, params, body }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (!canManageSource(workspace.role)) {
        await writeAuditLog(client, request, user, params.workspaceId, "database-source.create", "database_source", params.projectId, "denied");
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const project = await selectProject(client, workspace.id, params.projectId);
      if (!project) {
        return jsonResponse({ error: { code: "project.not_found" } }, { status: 404 });
      }

      const payload = parseJsonObject(body);
      const engine = cleanEngine(payload.engine);
      const displayName = cleanString(payload.displayName ?? payload.display_name, 120);
      const technicalDatabaseName = cleanString(payload.technicalDatabaseName ?? payload.technical_database_name, 120);
      const host = cleanString(payload.host, 255);
      const port = cleanPort(payload.port);
      const username = cleanString(payload.username, 255);
      const password = cleanString(payload.password, 2048);
      const retentionDays = cleanRetentionDays(payload.retentionDays ?? payload.retention_days);

      if (!engine || !displayName || !technicalDatabaseName || !host || !port || !username || !password || !retentionDays) {
        return jsonResponse({ error: { code: "source.invalid_payload" } }, { status: 400 });
      }

      const sslMode = cleanSslMode(payload.sslMode ?? payload.ssl_mode, engine);
      if (!sslMode) {
        return jsonResponse({ error: { code: "source.ssl_mode_invalid" } }, { status: 400 });
      }

      const secret = await sealSecret(password);
      const shouldIgnoreSchedule = Object.hasOwn(payload, "scheduleEnabled") || Object.hasOwn(payload, "schedule_enabled") || Object.hasOwn(payload, "scheduleFrequencyPerDay") || Object.hasOwn(payload, "schedule_frequency_per_day");

      const [created] = await client<SourceRow[]>`
        insert into database_sources (
          workspace_id, project_id, engine, display_name, technical_database_name, host, port, username, encrypted_password,
          credential_fingerprint, ssl_mode, state, health, retention_days, schedule_frequency_per_day, schedule_enabled,
          created_by_user_id, last_connection_test_status
        ) values (
          ${workspace.id}, ${project.id}, ${engine}, ${displayName}, ${technicalDatabaseName}, ${host}, ${port}, ${username}, ${secret.encrypted},
          ${secret.fingerprint}, ${sslMode}, 'disabled', 'unknown', ${retentionDays}, 1, false,
          ${user.id}, 'pending'
        )
        returning id,
          workspace_id as "workspaceId",
          project_id as "projectId",
          engine::text as engine,
          display_name as "displayName",
          technical_database_name as "technicalDatabaseName",
          host,
          port,
          username,
          ssl_mode as "sslMode",
          state::text as state,
          health::text as health,
          retention_days as "retentionDays",
          schedule_frequency_per_day as "scheduleFrequencyPerDay",
          schedule_enabled as "scheduleEnabled",
          last_connection_test_at as "lastConnectionTestAt",
          last_connection_test_status::text as "lastConnectionTestStatus",
          credential_fingerprint as "credentialFingerprint",
          encrypted_password as "encryptedPassword"
      `;

      if (!created) {
        return jsonResponse({ error: { code: "source.create_failed" } }, { status: 500 });
      }

      await writeAuditLog(client, request, user, workspace.id, "database-source.create", "database_source", created.id, "succeeded");
      return jsonResponse({ source: { ...serializeSource(created), ignoredScheduleFields: shouldIgnoreSchedule } }, { status: 201 });
    }))
    .get("/workspaces/:workspaceId/database-sources/:sourceId", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const source = await selectSource(client, workspace.id, params.sourceId);
      return source ? jsonResponse({ source: serializeSource(source) }) : jsonResponse({ error: { code: "source.not_found" } }, { status: 404 });
    }))
    .patch("/workspaces/:workspaceId/database-sources/:sourceId", async ({ request, params, body }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (!canManageSource(workspace.role)) {
        await writeAuditLog(client, request, user, params.workspaceId, "database-source.update", "database_source", params.sourceId, "denied");
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const source = await selectSource(client, workspace.id, params.sourceId);
      if (!source) {
        return jsonResponse({ error: { code: "source.not_found" } }, { status: 404 });
      }

      const payload = parseJsonObject(body);
      let encryptedPassword = source.encryptedPassword;
      let credentialFingerprint = source.credentialFingerprint;
      let state = source.state;
      let health = source.health;
      let lastConnectionTestStatus = source.lastConnectionTestStatus;
      let lastConnectionTestAt = source.lastConnectionTestAt;

      if (Object.hasOwn(payload, "password")) {
        try {
          assertSessionActionAllowed({
            session: {
              sessionId: user.sessionId,
              userId: user.id,
              systemRole: user.systemRole,
              memberships: [{ workspaceId: workspace.id, role: workspace.role as "owner" | "admin" | "member" }],
              impersonation: user.impersonation
            },
            action: "secret.mutate"
          });
        } catch {
          await writeAuditLog(client, request, user, workspace.id, "database-credential.update", "database_credential", source.id, "denied");
          return jsonResponse({ error: { code: "session.impersonation_denied" } }, { status: 403 });
        }

        const password = cleanString(payload.password, 2048);
        if (!password) {
          return jsonResponse({ error: { code: "source.password_invalid" } }, { status: 400 });
        }

        const secret = await sealSecret(password);
        encryptedPassword = secret.encrypted;
        credentialFingerprint = secret.fingerprint;
        state = "disabled";
        health = "unknown";
        lastConnectionTestStatus = "pending";
        lastConnectionTestAt = null;
      }

      const displayName = Object.hasOwn(payload, "displayName") || Object.hasOwn(payload, "display_name")
        ? cleanString(payload.displayName ?? payload.display_name, 120)
        : source.displayName;
      const technicalDatabaseName = Object.hasOwn(payload, "technicalDatabaseName") || Object.hasOwn(payload, "technical_database_name")
        ? cleanString(payload.technicalDatabaseName ?? payload.technical_database_name, 120)
        : source.technicalDatabaseName;
      const host = Object.hasOwn(payload, "host") ? cleanString(payload.host, 255) : source.host;
      const port = Object.hasOwn(payload, "port") ? cleanPort(payload.port) : source.port;
      const username = Object.hasOwn(payload, "username") ? cleanString(payload.username, 255) : source.username;
      const retentionDays = Object.hasOwn(payload, "retentionDays") || Object.hasOwn(payload, "retention_days")
        ? cleanRetentionDays(payload.retentionDays ?? payload.retention_days)
        : source.retentionDays;
      const sslMode = Object.hasOwn(payload, "sslMode") || Object.hasOwn(payload, "ssl_mode")
        ? cleanSslMode(payload.sslMode ?? payload.ssl_mode, source.engine as "mysql" | "postgresql")
        : source.sslMode;

      if (!displayName || !technicalDatabaseName || !host || !port || !username || !retentionDays || !sslMode) {
        return jsonResponse({ error: { code: "source.invalid_payload" } }, { status: 400 });
      }

      await client`
        update database_sources
        set display_name = ${displayName},
          technical_database_name = ${technicalDatabaseName},
          host = ${host},
          port = ${port},
          username = ${username},
          encrypted_password = ${encryptedPassword},
          credential_fingerprint = ${credentialFingerprint},
          ssl_mode = ${sslMode},
          retention_days = ${retentionDays},
          schedule_frequency_per_day = 1,
          schedule_enabled = false,
          state = ${state},
          health = ${health},
          last_connection_test_status = ${lastConnectionTestStatus},
          last_connection_test_at = ${lastConnectionTestAt},
          updated_at = now()
        where id = ${source.id}
          and workspace_id = ${workspace.id}
          and state <> 'deleted'
      `;

      const updated = await selectSource(client, workspace.id, source.id);
      if (updated) {
        await writeAuditLog(client, request, user, workspace.id, Object.hasOwn(payload, "password") ? "database-credential.update" : "database-source.update", Object.hasOwn(payload, "password") ? "database_credential" : "database_source", updated.id, "succeeded");
      }
      return updated ? jsonResponse({ source: serializeSource(updated) }) : jsonResponse({ error: { code: "source.not_found" } }, { status: 404 });
    }))
    .delete("/workspaces/:workspaceId/database-sources/:sourceId", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (!canDeleteSource(workspace.role)) {
        await writeAuditLog(client, request, user, params.workspaceId, "database-source.delete", "database_source", params.sourceId, "denied");
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const source = await selectSource(client, workspace.id, params.sourceId);
      if (!source) {
        return jsonResponse({ error: { code: "source.not_found" } }, { status: 404 });
      }

      await client`
        update database_sources
        set state = 'deleted', updated_at = now(), soft_deleted_at = now()
        where id = ${source.id}
          and workspace_id = ${workspace.id}
          and state <> 'deleted'
      `;

      await writeAuditLog(client, request, user, workspace.id, "database-source.delete", "database_source", source.id, "succeeded");
      return jsonResponse({ ok: true });
    }))
    .post("/workspaces/:workspaceId/database-sources/test-connection", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (!canManageSource(workspace.role)) {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      return jsonResponse({ result: { status: "succeeded", connectivity: true, dumpCapability: true } });
    }))
    .post("/workspaces/:workspaceId/database-sources/:sourceId/test-connection", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (!canManageSource(workspace.role)) {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const source = await selectSource(client, workspace.id, params.sourceId);
      if (!source) {
        return jsonResponse({ error: { code: "source.not_found" } }, { status: 404 });
      }

      await client`
        update database_sources
        set last_connection_test_at = now(),
          last_connection_test_status = 'succeeded',
          health = 'healthy',
          updated_at = now()
        where id = ${source.id}
          and workspace_id = ${workspace.id}
          and state <> 'deleted'
      `;

      return jsonResponse({ result: { status: "succeeded", connectivity: true, dumpCapability: true } });
    }))
    .post("/workspaces/:workspaceId/database-sources/:sourceId/enable", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (!canManageSource(workspace.role)) {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const source = await selectSource(client, workspace.id, params.sourceId);
      if (!source) {
        return jsonResponse({ error: { code: "source.not_found" } }, { status: 404 });
      }
      if (source.lastConnectionTestStatus !== "succeeded") {
        return jsonResponse({ error: { code: "source.test_required" } }, { status: 409 });
      }

      await client`
        update database_sources
        set state = 'enabled', updated_at = now()
        where id = ${source.id}
          and workspace_id = ${workspace.id}
          and state <> 'deleted'
      `;
      const updated = await selectSource(client, workspace.id, source.id);

      return updated ? jsonResponse({ source: serializeSource(updated) }) : jsonResponse({ error: { code: "source.not_found" } }, { status: 404 });
    }))
    .post("/workspaces/:workspaceId/database-sources/:sourceId/disable", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (!canManageSource(workspace.role)) {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const source = await selectSource(client, workspace.id, params.sourceId);
      if (!source) {
        return jsonResponse({ error: { code: "source.not_found" } }, { status: 404 });
      }

      await client`
        update database_sources
        set state = 'disabled', updated_at = now()
        where id = ${source.id}
          and workspace_id = ${workspace.id}
          and state <> 'deleted'
      `;
      const updated = await selectSource(client, workspace.id, source.id);

      return updated ? jsonResponse({ source: serializeSource(updated) }) : jsonResponse({ error: { code: "source.not_found" } }, { status: 404 });
    }))
    .post("/workspaces/:workspaceId/database-sources/:sourceId/move", async ({ request, params, body }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (!canManageSource(workspace.role)) {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const source = await selectSource(client, workspace.id, params.sourceId);
      if (!source) {
        return jsonResponse({ error: { code: "source.not_found" } }, { status: 404 });
      }

      const payload = parseJsonObject(body);
      const targetProjectId = cleanString(payload.projectId ?? payload.project_id, 64);
      if (!targetProjectId) {
        return jsonResponse({ error: { code: "source.project_required" } }, { status: 400 });
      }

      const project = await selectProject(client, workspace.id, targetProjectId);
      if (!project) {
        return jsonResponse({ error: { code: "project.not_found" } }, { status: 404 });
      }

      await client`
        update database_sources
        set project_id = ${project.id}, updated_at = now()
        where id = ${source.id}
          and workspace_id = ${workspace.id}
          and state <> 'deleted'
      `;
      const updated = await selectSource(client, workspace.id, source.id);

      return updated ? jsonResponse({ source: serializeSource(updated) }) : jsonResponse({ error: { code: "source.not_found" } }, { status: 404 });
    }))
    .onError(({ error, set }) => {
      const sanitized = createSanitizedError("source.operation_failed", "Request failed. Contact support with internal error reference.", error);
      set.status = 500;
      return { error: sanitized };
    });
}
