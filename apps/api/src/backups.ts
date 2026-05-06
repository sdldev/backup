import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendAuditLogWithClient, computeDeleteRetryAfter, createSqlClient, finalizeBackupDeletion, getDatabaseUrl, getWorkspaceRetainedStorageBytes, markBackupDeleteFailed, prepareBackupDeletion } from "@mba/db";
import { assertSessionActionAllowed, decryptBackupStream, type WrappedBackupKey, unwrapBackupDataKey } from "@mba/security";
import type { BackupObjectStorage } from "@mba/storage";
import { Elysia } from "elysia";
import { checkRateLimit, clientIp, rateLimitKey, rateLimitResponse, type RateLimitConfig } from "./rate-limit";

type SqlClient = ReturnType<typeof createSqlClient>;

type SessionUser = {
  id: string;
  sessionId: string;
  systemAdminId: string | null;
  systemRole: string | null;
  impersonation: {
    active: true;
    adminUserId: string;
    targetUserId: string;
    reason: string;
    startedAt: string;
    impersonationSessionId: string;
  } | null;
};

type WorkspaceAccess = { id: string; role: string };

type BackupRow = {
  id: string;
  workspaceId: string;
  projectId: string;
  projectName: string;
  databaseSourceId: string;
  sourceDisplayName: string;
  sourceEngine: string;
  status: string;
  format: string;
  objectKey: string;
  downloadFilename: string;
  originalDumpSizeBytes: string;
  storedSizeBytes: string;
  createdAt: Date;
  retentionExpiresAt: Date;
};

type DownloadAuthorization = {
  requestId: string;
  backupId: string;
  workspaceId: string;
  userId: string;
  sessionIdHash: string;
  tokenHash: string;
  objectKey: string;
  downloadFilename: string;
  format: string;
  wrappedDataKey: string;
};

export type BackupRoutesConfig = {
  databaseUrl: string;
  storage: BackupObjectStorage & { getObject?: (key: string) => { body: Uint8Array } | undefined };
  resolveWorkspaceKey: (workspaceId: string) => Promise<Uint8Array> | Uint8Array;
  now?: () => Date;
  lockTtlMs: number;
  heartbeatMs: number;
  rateLimit?: Partial<RateLimitConfig>;
};

const sessionCookieName = "mba_session";

function defaultBackupConfig(partial: Partial<BackupRoutesConfig> = {}): BackupRoutesConfig {
  return {
    databaseUrl: partial.databaseUrl ?? getDatabaseUrl(),
    storage: partial.storage ?? {
      async putObjectStream() {
        throw new Error("backup.storage_not_configured");
      },
      deleteObject() {
        return false;
      },
      listKeys() {
        return [];
      }
    },
    resolveWorkspaceKey: partial.resolveWorkspaceKey ?? (() => {
      throw new Error("backup.workspace_key_not_configured");
    }),
    now: partial.now ?? (() => new Date()),
    lockTtlMs: partial.lockTtlMs ?? 30_000,
    heartbeatMs: partial.heartbeatMs ?? 5_000,
    ...(partial.rateLimit ? { rateLimit: partial.rateLimit } : {})
  };
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
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

function canDownload(role: string): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

function canDeleteBackup(role: string): boolean {
  return role === "owner" || role === "admin";
}

function normalizeFilenameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "backup";
}

function buildDownloadFilename(projectName: string, sourceName: string, createdAt: Date, engine: string): string {
  const timestamp = createdAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const extension = engine === "mysql" ? ".sql.gz" : ".dump";
  return `${normalizeFilenameSegment(projectName)}-${normalizeFilenameSegment(sourceName)}-${timestamp}${extension}`;
}

function serializeBackup(row: BackupRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectName: row.projectName,
    databaseSourceId: row.databaseSourceId,
    sourceDisplayName: row.sourceDisplayName,
    sourceEngine: row.sourceEngine,
    status: row.status,
    format: row.format,
    downloadFilename: row.downloadFilename,
    originalDumpSizeBytes: row.originalDumpSizeBytes,
    storedSizeBytes: row.storedSizeBytes,
    createdAt: row.createdAt.toISOString(),
    retentionExpiresAt: row.retentionExpiresAt.toISOString()
  };
}

function buildRestoreInstructionsModel(input: { engine: "mysql" | "postgresql"; filename?: string | null }) {
  const filename = input.filename ?? (input.engine === "mysql" ? "backup.sql.gz" : "backup.dump");

  if (input.engine === "mysql") {
    return {
      title: `Restore ${filename} manually`,
      formatLabel: ".sql.gz",
      warningTitle: "Production overwrite warning",
      warnings: [
        "Restoring can overwrite live production data.",
        "Confirm target hostname, database name, and credentials before running import commands.",
        "Restore into non-production first whenever possible."
      ],
      steps: [
        "Download backup file locally.",
        "Confirm target MySQL database exists and is safe to overwrite.",
        "Decompress or stream-decompress the SQL dump before import.",
        "Run import from trusted shell with production credentials kept outside command history."
      ],
      commands: [
        `gunzip -c ${filename} > restore.sql`,
        "mysql --host <HOST> --port <PORT> --user <USER> --password <DATABASE_NAME> < restore.sql",
        `gunzip -c ${filename} | mysql --host <HOST> --port <PORT> --user <USER> --password <DATABASE_NAME>`
      ],
      hasExecutionAction: false as const
    };
  }

  return {
    title: `Restore ${filename} manually`,
    formatLabel: ".dump",
    warningTitle: "Production overwrite warning",
    warnings: [
      "Restoring can overwrite live production data.",
      "Double-check target database, role permissions, and extension compatibility before pg_restore.",
      "Restore into staging first whenever possible."
    ],
    steps: [
      "Download backup file locally.",
      "Create empty target database or prepare clean restore target.",
      "Use pg_restore against the downloaded custom-format dump.",
      "Review object ownership and post-restore privileges after import completes."
    ],
    commands: [
      "createdb --host <HOST> --port <PORT> --username <USER> <DATABASE_NAME>",
      `pg_restore --host <HOST> --port <PORT> --username <USER> --dbname <DATABASE_NAME> --clean --if-exists ${filename}`
    ],
    hasExecutionAction: false as const
  };
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlList(items: string[], tagName: "ul" | "ol"): string {
  const content = items.map((item) => `<li>${htmlEscape(item)}</li>`).join("");
  return `<${tagName}>${content}</${tagName}>`;
}

function renderRestoreHtml(model: ReturnType<typeof buildRestoreInstructionsModel>): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    `  <title>${htmlEscape(model.title)}</title>`,
    "</head>",
    "<body>",
    `  <main data-restore-docs="true" data-execution-disabled="${String(model.hasExecutionAction)}">`,
    `    <h1>${htmlEscape(model.title)}</h1>`,
    `    <p>Format: <strong>${htmlEscape(model.formatLabel)}</strong></p>`,
    `    <section><h2>${htmlEscape(model.warningTitle)}</h2>${htmlList(model.warnings, "ul")}</section>`,
    `    <section><h2>Steps</h2>${htmlList(model.steps, "ol")}</section>`,
    `    <section><h2>Commands</h2>${model.commands.map((command: string) => `<pre><code>${htmlEscape(command)}</code></pre>`).join("")}</section>`,
    "  </main>",
    "</body>",
    "</html>"
  ].join("\n");
}

async function withClient<T>(config: BackupRoutesConfig, run: (client: SqlClient) => Promise<T>): Promise<T> {
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
    system_role: string | null;
    impersonation_session_id: string | null;
    admin_user_id: string | null;
    target_user_id: string | null;
    reason: string | null;
    started_at: Date | null;
  }[]>`
    select sessions.id as session_id,
      sessions.user_id,
      system_admins.id as system_admin_id,
      system_admins.role::text as system_role,
      impersonation_sessions.id as impersonation_session_id,
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
    systemAdminId: session.system_admin_id,
    systemRole: session.system_role,
    impersonation: session.impersonation_session_id && session.admin_user_id && session.target_user_id && session.reason && session.started_at
      ? {
          active: true,
          adminUserId: session.admin_user_id,
          targetUserId: session.target_user_id,
          reason: session.reason,
          startedAt: session.started_at.toISOString(),
          impersonationSessionId: session.impersonation_session_id
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

async function selectBackup(client: SqlClient, workspaceId: string, backupId: string): Promise<BackupRow | null> {
  const [backup] = await client<BackupRow[]>`
    select backups.id,
      backups.workspace_id as "workspaceId",
      backups.project_id as "projectId",
      projects.name as "projectName",
      backups.database_source_id as "databaseSourceId",
      database_sources.display_name as "sourceDisplayName",
      backups.engine::text as "sourceEngine",
      backups.status::text as status,
      backups.format::text as format,
      backups.object_key as "objectKey",
      backups.download_filename as "downloadFilename",
      backups.original_dump_size_bytes::text as "originalDumpSizeBytes",
      backups.stored_size_bytes::text as "storedSizeBytes",
      backups.created_at as "createdAt",
      backups.retention_expires_at as "retentionExpiresAt"
    from backups
    inner join projects on projects.id = backups.project_id
      and projects.workspace_id = backups.workspace_id
    inner join database_sources on database_sources.id = backups.database_source_id
      and database_sources.workspace_id = backups.workspace_id
    where backups.id = ${backupId}
      and backups.workspace_id = ${workspaceId}
      and backups.status = 'succeeded'
    limit 1
  `;

  return backup ?? null;
}

async function writeAuditLog(client: SqlClient, request: Request, user: SessionUser, workspaceId: string | null, targetId: string, result: "succeeded" | "failed" | "denied", metadata: Record<string, unknown> = {}) {
  await appendAuditLogWithClient(client, {
    workspaceId,
    eventType: "backup.download",
    targetType: "backup",
    targetId,
    result,
    metadata,
    context: {
      actorType: "user",
      actorUserId: user.impersonation?.adminUserId ?? user.id,
      effectiveActorUserId: user.id,
      systemAdminId: user.systemAdminId,
      impersonationSessionId: user.impersonation?.impersonationSessionId ?? null,
      requestId: request.headers.get("x-request-id"),
      sessionId: user.sessionId,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: request.headers.get("user-agent"),
      impersonationReason: user.impersonation?.reason ?? null
    }
  });
}

function denyProtectedAction(user: SessionUser, workspaceId: string, role: string) {
  try {
    assertSessionActionAllowed({
      session: {
        sessionId: user.sessionId,
        userId: user.id,
        systemRole: user.systemRole === "system_admin" || user.systemRole === "system_owner" ? user.systemRole : null,
        memberships: [{ workspaceId, role: role as "owner" | "admin" | "member" }],
        impersonation: user.impersonation
          ? {
              active: true,
              adminUserId: user.impersonation.adminUserId,
              targetUserId: user.impersonation.targetUserId,
              reason: user.impersonation.reason,
              startedAt: user.impersonation.startedAt
            }
          : null
      },
      action: "backup.download"
    });
    return null;
  } catch (error) {
    if (error instanceof Error && error.message.includes("session.impersonation_denied")) {
      return jsonResponse({ error: { code: "session.impersonation_denied" } }, { status: 403 });
    }
    return jsonResponse({ error: { code: "backup.download_forbidden" } }, { status: 403 });
  }
}

async function selectDownloadAuthorization(client: SqlClient, tokenHash: string, user: SessionUser): Promise<DownloadAuthorization | { code: string }> {
  const sessionIdHash = hashValue(user.sessionId);
  const rows = await client.begin(async (tx) => {
    const [download] = await tx<DownloadAuthorization[]>`
      update download_requests
      set consumed_at = now()
      where id = (
        select download_requests.id
        from download_requests
        inner join backups on backups.id = download_requests.backup_id
          and backups.workspace_id = download_requests.workspace_id
        inner join workspace_members on workspace_members.workspace_id = download_requests.workspace_id
          and workspace_members.user_id = ${user.id}
        where download_requests.token_hash = ${tokenHash}
          and download_requests.user_id = ${user.id}
          and download_requests.session_id_hash = ${sessionIdHash}
          and download_requests.consumed_at is null
          and download_requests.revoked_at is null
          and download_requests.expires_at > now()
          and backups.status = 'succeeded'
        limit 1
        for update
      )
      returning download_requests.id as "requestId",
        download_requests.backup_id as "backupId",
        download_requests.workspace_id as "workspaceId",
        download_requests.user_id as "userId",
        download_requests.session_id_hash as "sessionIdHash",
        download_requests.token_hash as "tokenHash",
        (
          select backups.object_key
          from backups
          where backups.id = download_requests.backup_id
            and backups.workspace_id = download_requests.workspace_id
        ) as "objectKey",
        (
          select backups.download_filename
          from backups
          where backups.id = download_requests.backup_id
            and backups.workspace_id = download_requests.workspace_id
        ) as "downloadFilename",
        (
          select backups.format::text
          from backups
          where backups.id = download_requests.backup_id
            and backups.workspace_id = download_requests.workspace_id
        ) as format,
        (
          select backup_encryption_keys.wrapped_data_key
          from backup_encryption_keys
          where backup_encryption_keys.backup_id = download_requests.backup_id
            and backup_encryption_keys.workspace_id = download_requests.workspace_id
          limit 1
        ) as "wrappedDataKey"
    `;

    if (!download) {
      return null;
    }

    await tx`
      insert into backup_download_locks (backup_id, workspace_id, download_request_id, session_id_hash, expires_at)
      values (${download.backupId}, ${download.workspaceId}, ${download.requestId}, ${sessionIdHash}, now() + interval '30 seconds')
    `;

    return download;
  });

  if (!rows) {
    return { code: "download.invalid_token" };
  }

  return rows;
}

export function createBackupRoutes(partialConfig: Partial<BackupRoutesConfig> = {}) {
  const config = defaultBackupConfig(partialConfig);

  return new Elysia()
    .get("/workspaces/:workspaceId/restore-docs", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }
      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const mysql = buildRestoreInstructionsModel({ engine: "mysql", filename: "backup.sql.gz" });
      const postgresql = buildRestoreInstructionsModel({ engine: "postgresql", filename: "backup.dump" });

      return new Response([
        "<!doctype html>",
        '<html lang="en">',
        "<head>",
        '  <meta charset="utf-8">',
        "  <title>Restore docs</title>",
        "</head>",
        "<body>",
        `  <article>${renderRestoreHtml(mysql)}</article>`,
        `  <article>${renderRestoreHtml(postgresql)}</article>`,
        "</body>",
        "</html>"
      ].join("\n"), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }))
    .get("/workspaces/:workspaceId/backups", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }
      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const rows = await client<BackupRow[]>`
        select backups.id,
          backups.workspace_id as "workspaceId",
          backups.project_id as "projectId",
          projects.name as "projectName",
          backups.database_source_id as "databaseSourceId",
          database_sources.display_name as "sourceDisplayName",
          backups.engine::text as "sourceEngine",
          backups.status::text as status,
          backups.format::text as format,
          backups.object_key as "objectKey",
          backups.download_filename as "downloadFilename",
          backups.original_dump_size_bytes::text as "originalDumpSizeBytes",
          backups.stored_size_bytes::text as "storedSizeBytes",
          backups.created_at as "createdAt",
          backups.retention_expires_at as "retentionExpiresAt"
        from backups
        inner join projects on projects.id = backups.project_id and projects.workspace_id = backups.workspace_id
        inner join database_sources on database_sources.id = backups.database_source_id and database_sources.workspace_id = backups.workspace_id
        where backups.workspace_id = ${workspace.id}
          and backups.status = 'succeeded'
        order by backups.created_at desc, backups.id desc
      `;

      return jsonResponse({ backups: rows.map(serializeBackup) });
    }))
    .get("/workspaces/:workspaceId/backups/:backupId", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }
      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const backup = await selectBackup(client, workspace.id, params.backupId);
      return backup ? jsonResponse({ backup: serializeBackup(backup) }) : jsonResponse({ error: { code: "backup.not_found" } }, { status: 404 });
    }))
    .get("/workspaces/:workspaceId/backups/:backupId/restore-docs", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }
      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const backup = await selectBackup(client, workspace.id, params.backupId);
      if (!backup) {
        return jsonResponse({ error: { code: "backup.not_found" } }, { status: 404 });
      }

      const model = buildRestoreInstructionsModel({
        engine: backup.sourceEngine === "mysql" ? "mysql" : "postgresql",
        filename: backup.downloadFilename
      });

      return new Response(renderRestoreHtml(model), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }))
    .post("/workspaces/:workspaceId/backups/:backupId/download-requests", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      const actionDenied = denyProtectedAction(user, workspace.id, workspace.role);
      if (actionDenied) {
        await writeAuditLog(client, request, user, workspace.id, params.backupId, "denied", { phase: "request_create" });
        return actionDenied;
      }
      if (!canDownload(workspace.role)) {
        await writeAuditLog(client, request, user, workspace.id, params.backupId, "denied", { phase: "request_create" });
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const limited = checkRateLimit("download_token", rateLimitKey([user.id, user.sessionId, workspace.id, params.backupId, clientIp(request)]), config.rateLimit);
      if (!limited.ok) {
        await writeAuditLog(client, request, user, workspace.id, params.backupId, "denied", { phase: "request_create", reason: "rate_limit" });
        return rateLimitResponse(limited.retryAfterSeconds);
      }

      const backup = await selectBackup(client, workspace.id, params.backupId);
      if (!backup) {
        return jsonResponse({ error: { code: "backup.not_found" } }, { status: 404 });
      }

      const token = randomToken();
      const filename = buildDownloadFilename(backup.projectName, backup.sourceDisplayName, backup.createdAt, backup.sourceEngine);
      await client`
        insert into download_requests (backup_id, workspace_id, user_id, session_id_hash, token_hash, expires_at, created_ip, user_agent)
        values (
          ${backup.id},
          ${workspace.id},
          ${user.id},
          ${hashValue(user.sessionId)},
          ${hashValue(token)},
          now() + interval '15 minutes',
          ${request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null},
          ${request.headers.get("user-agent")}
        )
      `;
      await client`
        update backups
        set download_filename = ${filename}
        where id = ${backup.id}
          and workspace_id = ${workspace.id}
      `;
      await writeAuditLog(client, request, user, workspace.id, backup.id, "succeeded", { phase: "request_create", filename });

      return jsonResponse({ downloadToken: token, expiresInSeconds: 900, filename }, { status: 201 });
    }))
    .delete("/workspaces/:workspaceId/backups/:backupId", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      if (!canDeleteBackup(workspace.role)) {
        await appendAuditLogWithClient(client, {
          workspaceId: workspace.id,
          eventType: "backup.delete",
          targetType: "backup",
          targetId: params.backupId,
          result: "denied",
          metadata: { reason: "manual" },
          context: {
            actorType: "user",
            actorUserId: user.id,
            effectiveActorUserId: user.id,
            systemAdminId: user.systemAdminId,
            impersonationSessionId: user.impersonation?.impersonationSessionId ?? null,
            requestId: request.headers.get("x-request-id"),
            sessionId: user.sessionId,
            ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
            userAgent: request.headers.get("user-agent"),
            impersonationReason: user.impersonation?.reason ?? null
          }
        });
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const prepared = await prepareBackupDeletion(client, {
        workspaceId: workspace.id,
        backupId: params.backupId,
        now: config.now ? config.now() : new Date()
      });

      if (!prepared.ok) {
        if (prepared.code === "backup.locked") {
          return jsonResponse({ error: { code: prepared.code } }, { status: 409 });
        }
        return jsonResponse({ error: { code: prepared.code } }, { status: 404 });
      }

      try {
        config.storage.deleteObject(prepared.target.objectKey);
        const finalized = await finalizeBackupDeletion(client, {
          workspaceId: workspace.id,
          backupId: params.backupId,
          finalStatus: "deleted",
          deletedByUserId: user.id
        });
        if (!finalized.ok) {
          return jsonResponse({ error: { code: finalized.code } }, { status: 409 });
        }

        await appendAuditLogWithClient(client, {
          workspaceId: workspace.id,
          eventType: "backup.delete",
          targetType: "backup",
          targetId: params.backupId,
          result: "succeeded",
          metadata: { reason: "manual", finalStatus: finalized.finalStatus, retainedStorageBytes: finalized.retainedStorageBytes.toString() },
          context: {
            actorType: "user",
            actorUserId: user.id,
            effectiveActorUserId: user.id,
            systemAdminId: user.systemAdminId,
            impersonationSessionId: user.impersonation?.impersonationSessionId ?? null,
            requestId: request.headers.get("x-request-id"),
            sessionId: user.sessionId,
            ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
            userAgent: request.headers.get("user-agent"),
            impersonationReason: user.impersonation?.reason ?? null
          }
        });

        return jsonResponse({ deleted: true, backupId: params.backupId, status: finalized.finalStatus, retainedStorageBytes: finalized.retainedStorageBytes.toString() });
      } catch (error) {
        const now = config.now ? config.now() : new Date();
        const retry = await markBackupDeleteFailed(client, {
          workspaceId: workspace.id,
          backupId: params.backupId,
          retryAfter: computeDeleteRetryAfter(now, 1),
          errorMessage: error instanceof Error ? error.message : "backup_delete_failed"
        });
        await appendAuditLogWithClient(client, {
          workspaceId: workspace.id,
          eventType: "backup.delete",
          targetType: "backup",
          targetId: params.backupId,
          result: "failed",
          metadata: {
            reason: "manual",
            retainedStorageBytes: retry.ok ? retry.retainedStorageBytes.toString() : (await getWorkspaceRetainedStorageBytes(client, workspace.id)).toString(),
            deleteRetryAfter: retry.ok ? retry.deleteRetryAfter.toISOString() : null,
            deleteError: error instanceof Error ? error.message : "backup_delete_failed"
          },
          context: {
            actorType: "user",
            actorUserId: user.id,
            effectiveActorUserId: user.id,
            systemAdminId: user.systemAdminId,
            impersonationSessionId: user.impersonation?.impersonationSessionId ?? null,
            requestId: request.headers.get("x-request-id"),
            sessionId: user.sessionId,
            ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
            userAgent: request.headers.get("user-agent"),
            impersonationReason: user.impersonation?.reason ?? null
          }
        });
        return jsonResponse({ error: { code: "backup.delete_failed" } }, { status: 500 });
      }
    }))
    .get("/downloads/:downloadToken", async ({ request, params }) => {
      const client = createSqlClient(config.databaseUrl);
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        await client.end();
        return user;
      }
      const [workspace] = await client<WorkspaceAccess[]>`
        select workspaces.id,
          workspace_members.role::text as role
        from download_requests
        inner join workspaces on workspaces.id = download_requests.workspace_id
        inner join workspace_members on workspace_members.workspace_id = workspaces.id
          and workspace_members.user_id = ${user.id}
        where download_requests.token_hash = ${hashValue(params.downloadToken)}
        limit 1
      `;
      if (workspace) {
        const actionDenied = denyProtectedAction(user, workspace.id, workspace.role);
        if (actionDenied) {
          await client.end();
          return actionDenied;
        }
      }
      if (!workspace && (user.systemRole || user.impersonation?.active)) {
        await client.end();
        return jsonResponse({ error: { code: user.impersonation?.active ? "session.impersonation_denied" : "backup.download_forbidden" } }, { status: 403 });
      }

      const authorized = await selectDownloadAuthorization(client, hashValue(params.downloadToken), user);
      if ("code" in authorized) {
        await client.end();
        return jsonResponse({ error: { code: authorized.code } }, { status: 403 });
      }

      try {
        const workspaceKey = await config.resolveWorkspaceKey(authorized.workspaceId);
        const wrappedBackupKey = JSON.parse(authorized.wrappedDataKey) as WrappedBackupKey;
        const dataKey = await unwrapBackupDataKey({
          workspaceId: authorized.workspaceId,
          backupId: authorized.backupId,
          wrappedBackupKey,
          workspaceKey
        });

        const object = config.storage.getObject?.(authorized.objectKey);
        if (!object) {
          throw new Error("download.object_missing");
        }

        const decrypted = decryptBackupStream(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(object.body);
            controller.close();
          }
        }), { dataKey });

        const lockId = authorized.requestId;
        const heartbeat = setInterval(async () => {
          try {
            await client`
              update backup_download_locks
              set heartbeat_at = now(), expires_at = now() + (${String(config.lockTtlMs)}::text || ' milliseconds')::interval
              where download_request_id = ${lockId}
                and workspace_id = ${authorized.workspaceId}
            `;
          } catch {
            // ignore heartbeat failure during response lifecycle
          }
        }, config.heartbeatMs);

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const reader = decrypted.getReader();
            void (async () => {
              try {
                while (true) {
                  const read = await reader.read();
                  if (read.done) {
                    break;
                  }
                  controller.enqueue(read.value);
                }
                await writeAuditLog(client, request, user, authorized.workspaceId, authorized.backupId, "succeeded", { phase: "stream_complete" });
                await client`
                  delete from backup_download_locks
                  where download_request_id = ${lockId}
                    and workspace_id = ${authorized.workspaceId}
                `;
                controller.close();
              } catch (error) {
                controller.error(error);
                await writeAuditLog(client, request, user, authorized.workspaceId, authorized.backupId, "failed", { phase: "stream_failed", errorRef: randomUUID() });
                await client`
                  delete from backup_download_locks
                  where download_request_id = ${lockId}
                    and workspace_id = ${authorized.workspaceId}
                `;
              } finally {
                clearInterval(heartbeat);
                await client.end();
              }
            })();
          },
          cancel() {
            clearInterval(heartbeat);
          }
        });

        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": authorized.format === "mysql_sql_gzip" ? "application/gzip" : "application/octet-stream",
            "content-disposition": `attachment; filename="${authorized.downloadFilename}"`
          }
        });
      } catch {
        await writeAuditLog(client, request, user, authorized.workspaceId, authorized.backupId, "failed", { phase: "stream_start_failed" });
        await client`
          delete from backup_download_locks
          where download_request_id = ${authorized.requestId}
            and workspace_id = ${authorized.workspaceId}
        `;
        await client.end();
        return jsonResponse({ error: { code: "download.stream_failed" } }, { status: 500 });
      }
    });
}
