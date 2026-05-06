import { createHash } from "node:crypto";
import { assertWorkspaceHasStorageHeadroom, createManualBackupJob, createSqlClient, getBackupJob, getDatabaseUrl, getManualBackupAdmission, requestBackupJobCancel } from "@mba/db";
import type { BackupJobRow } from "@mba/db";
import { sseEventStages, type SseEventStage } from "@mba/shared";
import { Elysia } from "elysia";
import { checkRateLimit, clientIp, rateLimitKey, rateLimitResponse, type RateLimitConfig } from "./rate-limit";

type SqlClient = ReturnType<typeof createSqlClient>;

export type BackupJobsConfig = {
  databaseUrl: string;
  rateLimit?: Partial<RateLimitConfig>;
};

type SessionUser = { id: string };
type WorkspaceAccess = { id: string; role: string };

const sessionCookieName = "mba_session";

function defaultBackupJobsConfig(partial: Partial<BackupJobsConfig> = {}): BackupJobsConfig {
  return { databaseUrl: partial.databaseUrl ?? getDatabaseUrl(), ...(partial.rateLimit ? { rateLimit: partial.rateLimit } : {}) };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withClient<T>(config: BackupJobsConfig, run: (client: SqlClient) => Promise<T>): Promise<T> {
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

function canRunBackup(role: string): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

function canCancelBackup(role: string): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

function sanitizeUserErrorMessage(message: string | null): string | null {
  if (!message) {
    return null;
  }

  if (message === "storage_limit_exceeded") {
    return "Workspace storage limit reached before upload completed.";
  }

  if (message.toLowerCase().includes("cancel")) {
    return "Backup cancelled before completion.";
  }

  return "Backup failed before verification completed.";
}

type SafeJobEvent = {
  eventId: string;
  workspaceId: string;
  jobId: string;
  status: string;
  stage: SseEventStage;
  terminal: boolean;
  attemptCount: number;
  maxAttempts: number;
  userErrorMessage: string | null;
  internalErrorRef: string | null;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  queuedAt: string;
};

function isSseStage(value: string): value is SseEventStage {
  return (sseEventStages as readonly string[]).includes(value);
}

function toSafeStage(job: BackupJobRow): SseEventStage {
  if (job.status === "succeeded") {
    return "succeeded";
  }

  if (job.status === "failed" || job.status === "cancelled") {
    return "failed";
  }

  if (job.stage === "queued") {
    return "queued";
  }

  if (job.stage === "dumping") {
    return "connected";
  }

  if (isSseStage(job.stage)) {
    return job.stage;
  }

  return "queued";
}

function toSafeEventId(job: BackupJobRow): string {
  const finishedAt = job.finishedAt?.toISOString() ?? "open";
  const cancelRequestedAt = job.cancelRequestedAt?.toISOString() ?? "nocancel";
  return [job.id, job.status, job.stage, String(job.attemptCount), finishedAt, cancelRequestedAt].join(":");
}

function serializeSafeJobEvent(job: BackupJobRow): SafeJobEvent {
  return {
    eventId: toSafeEventId(job),
    workspaceId: job.workspaceId,
    jobId: job.id,
    status: job.status,
    stage: toSafeStage(job),
    terminal: job.status === "succeeded" || job.status === "failed" || job.status === "cancelled",
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    userErrorMessage: sanitizeUserErrorMessage(job.userErrorMessage),
    internalErrorRef: job.internalErrorRef,
    cancelRequestedAt: job.cancelRequestedAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    queuedAt: job.queuedAt.toISOString()
  };
}

function toSseFrame(event: "connected" | "job", payload: SafeJobEvent | { eventId: string; stage: "connected"; terminal: false }): string {
  return `id: ${payload.eventId}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function readJobOrNotFound(client: SqlClient, workspaceId: string, jobId: string): Promise<BackupJobRow | Response> {
  const job = await getBackupJob(client, workspaceId, jobId);
  return job ?? jsonResponse({ error: { code: "backup_job.not_found" } }, { status: 404 });
}

function serializeJob(job: BackupJobRow) {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    projectId: job.projectId,
    databaseSourceId: job.databaseSourceId,
    trigger: job.trigger,
    status: job.status,
    stage: job.stage,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    errorCategory: job.errorCategory,
    userErrorMessage: sanitizeUserErrorMessage(job.userErrorMessage),
    internalErrorRef: job.internalErrorRef,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    cancelRequestedAt: job.cancelRequestedAt?.toISOString() ?? null,
    cancelRequestedByUserId: job.cancelRequestedByUserId
  };
}

export function createBackupJobRoutes(partialConfig: Partial<BackupJobsConfig> = {}) {
  const config = defaultBackupJobsConfig(partialConfig);

  return new Elysia()
    .post("/workspaces/:workspaceId/database-sources/:sourceId/backup-jobs", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (!canRunBackup(workspace.role)) {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const limited = checkRateLimit("backup_action", rateLimitKey([user.id, workspace.id, params.sourceId, clientIp(request)]), config.rateLimit);
      if (!limited.ok) {
        return rateLimitResponse(limited.retryAfterSeconds);
      }

      const headroom = await assertWorkspaceHasStorageHeadroom(client, workspace.id);
      if (!headroom.ok) {
        return jsonResponse({ code: headroom.code }, { status: 409 });
      }

      const admission = await getManualBackupAdmission(client, workspace.id, params.sourceId);
      if (!admission.ok) {
        const statusByCode = {
          "workspace.not_found": 404,
          "source.not_found": 404,
          "source.disabled": 409,
          "workspace_storage_not_ready": 409,
          "active_backup_job_exists": 409,
          "manual_backup_rate_limit_exceeded": 429
        } as const;
        return jsonResponse({ error: { code: admission.code } }, { status: statusByCode[admission.code] });
      }

      try {
        const job = await createManualBackupJob(client, admission.workspaceId, admission.projectId, admission.sourceId, user.id);
        return jsonResponse({ backupJob: serializeJob(job) }, { status: 201 });
      } catch (error) {
        if (String(error).includes("backup_jobs_one_active_per_source_idx")) {
          return jsonResponse({ error: { code: "active_backup_job_exists" } }, { status: 409 });
        }

        throw error;
      }
    }))
    .post("/workspaces/:workspaceId/backup-jobs/:jobId/cancel", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (!canCancelBackup(workspace.role)) {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const limited = checkRateLimit("backup_action", rateLimitKey([user.id, workspace.id, params.jobId, "cancel", clientIp(request)]), config.rateLimit);
      if (!limited.ok) {
        return rateLimitResponse(limited.retryAfterSeconds);
      }

      const job = await requestBackupJobCancel(client, workspace.id, params.jobId, user.id);
      return job ? jsonResponse({ backupJob: serializeJob(job) }) : jsonResponse({ error: { code: "backup_job.not_found" } }, { status: 404 });
    }))
    .get("/workspaces/:workspaceId/backup-jobs/:jobId", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const job = await readJobOrNotFound(client, workspace.id, params.jobId);
      return job instanceof Response ? job : jsonResponse({ backupJob: serializeJob(job), event: serializeSafeJobEvent(job) });
    }))
    .get("/workspaces/:workspaceId/backup-jobs/:jobId/events", async ({ request, params }) => {
      const client = createSqlClient(config.databaseUrl);
      const encoder = new TextEncoder();

      const user = await requireSession(client, request);
      if (user instanceof Response) {
        await client.end();
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        await client.end();
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const job = await readJobOrNotFound(client, workspace.id, params.jobId);
      if (job instanceof Response) {
        await client.end();
        return job;
      }

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const connectedPayload = { eventId: `${job.id}:connected`, stage: "connected" as const, terminal: false as const };
          controller.enqueue(encoder.encode(toSseFrame("connected", connectedPayload)));

          void (async () => {
            let lastEventId = "";

            try {
              while (true) {
                const nextJob = await getBackupJob(client, workspace.id, params.jobId);
                if (!nextJob) {
                  controller.close();
                  return;
                }

                const payload = serializeSafeJobEvent(nextJob);
                if (payload.eventId !== lastEventId) {
                  controller.enqueue(encoder.encode(toSseFrame("job", payload)));
                  lastEventId = payload.eventId;
                }

                if (payload.terminal) {
                  controller.close();
                  return;
                }

                await sleep(100);
              }
            } catch (error) {
              controller.error(error);
            } finally {
              await client.end();
            }
          })();
        },
        async cancel() {
          await client.end();
        }
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        }
      });
    });
}
