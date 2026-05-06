import { createHash } from "node:crypto";
import { createSqlClient, getDatabaseUrl, getWorkspaceRetainedStorageBytes, resolveWorkspacePlanLimits } from "@mba/db";
import { Elysia } from "elysia";

type SqlClient = ReturnType<typeof createSqlClient>;

export type WorkspaceConfig = {
  databaseUrl: string;
};

type SessionUser = {
  id: string;
};

type WorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  planSlug: string;
  storageStatus: string;
  role: string;
  softDeletedAt: Date | null;
};

type DashboardCountsRow = {
  project_count: string;
  source_count: string;
  tested_source_count: string;
  invited_member_count: string;
};

type DashboardLastBackupRow = {
  backupId: string;
  backupStatus: "succeeded" | "failed";
  backupFilename: string | null;
  backupCreatedAt: Date;
  backupErrorMessage: string | null;
};

type FirstBackupAttemptRow = {
  backupId: string | null;
  downloadFilename: string | null;
  storedSizeBytes: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  jobId: string;
  jobStage: string;
  jobStatus: string;
  userErrorMessage: string | null;
};

type DashboardChecklistItem = {
  key: string;
  label: string;
  complete: boolean;
  optional: boolean;
};

const sessionCookieName = "mba_session";
const defaultTimezone = "UTC";
const requestablePlans = new Set(["pro", "agency"]);

function defaultWorkspaceConfig(partial: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
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
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers
    }
  });
}

function parseJsonObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  return body as Record<string, unknown>;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 120 ? trimmed : null;
}

function cleanTimezone(value: unknown): string {
  if (typeof value !== "string") {
    return defaultTimezone;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 100 ? trimmed : defaultTimezone;
}

export function slugifyWorkspaceName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");

  return slug || "workspace";
}

function cleanSlug(value: unknown, fallbackName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return slugifyWorkspaceName(fallbackName);
  }

  return slugifyWorkspaceName(value);
}

function serializeWorkspace(row: WorkspaceRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
      timezone: row.timezone,
      planSlug: row.planSlug,
      storageStatus: row.storageStatus,
      role: row.role,
      deleted: row.softDeletedAt !== null
  };
}

async function withClient<T>(config: WorkspaceConfig, run: (client: SqlClient) => Promise<T>): Promise<T> {
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

async function ensureUniqueSlug(client: SqlClient, wantedSlug: string, workspaceId?: string): Promise<string> {
  let candidate = wantedSlug;
  for (let suffix = 2; suffix <= 50; suffix += 1) {
    const rows = await client<{ id: string }[]>`
      select id from workspaces
      where slug = ${candidate}
        and (${workspaceId ?? null}::uuid is null or id <> ${workspaceId ?? null}::uuid)
      limit 1
    `;
    if (!rows[0]) {
      return candidate;
    }
    candidate = `${wantedSlug}-${suffix}`;
  }

  throw new Error("workspace.slug_exhausted");
}

async function selectWorkspaceForUser(client: SqlClient, userId: string, workspaceIdOrSlug: string, includeDeleted = false): Promise<WorkspaceRow | null> {
  const [workspace] = await client<WorkspaceRow[]>`
    select workspaces.id,
      workspaces.name,
      workspaces.slug,
      workspaces.timezone,
      plans.slug::text as "planSlug",
      workspaces.storage_status::text as "storageStatus",
      workspace_members.role::text as role,
      workspaces.soft_deleted_at as "softDeletedAt"
    from workspaces
    inner join workspace_members on workspace_members.workspace_id = workspaces.id
    inner join plans on plans.id = workspaces.plan_id
    where workspace_members.user_id = ${userId}
      and (workspaces.id::text = ${workspaceIdOrSlug} or workspaces.slug = ${workspaceIdOrSlug})
      and (${includeDeleted}::boolean or workspaces.soft_deleted_at is null)
    limit 1
  `;

  return workspace ?? null;
}

async function selectDashboardCounts(client: SqlClient, workspaceId: string): Promise<DashboardCountsRow> {
  const [counts] = await client<DashboardCountsRow[]>`
    select
      (select count(*)::text from projects where projects.workspace_id = ${workspaceId}) as project_count,
      (select count(*)::text from database_sources where database_sources.workspace_id = ${workspaceId} and database_sources.state <> 'deleted') as source_count,
      (select count(*)::text from database_sources where database_sources.workspace_id = ${workspaceId} and database_sources.last_connection_test_status = 'succeeded' and database_sources.state <> 'deleted') as tested_source_count,
      (select count(*)::text from workspace_members where workspace_members.workspace_id = ${workspaceId} and workspace_members.role <> 'owner') as invited_member_count
  `;

  return counts ?? { project_count: "0", source_count: "0", tested_source_count: "0", invited_member_count: "0" };
}

async function selectLastBackup(client: SqlClient, workspaceId: string): Promise<DashboardLastBackupRow | null> {
  const [lastBackup] = await client<DashboardLastBackupRow[]>`
    select
      backups.id as "backupId",
      'succeeded'::text as "backupStatus",
      backups.download_filename as "backupFilename",
      backups.created_at as "backupCreatedAt",
      null::text as "backupErrorMessage"
    from backups
    where backups.workspace_id = ${workspaceId}
      and backups.status = 'succeeded'
    union all
    select
      backup_jobs.id as "backupId",
      'failed'::text as "backupStatus",
      null::text as "backupFilename",
      coalesce(backup_jobs.finished_at, backup_jobs.queued_at) as "backupCreatedAt",
      backup_jobs.user_error_message as "backupErrorMessage"
    from backup_jobs
    where backup_jobs.workspace_id = ${workspaceId}
      and backup_jobs.status = 'failed'
    order by "backupCreatedAt" desc, "backupId" desc
    limit 1
  `;

  return lastBackup ?? null;
}

async function selectFirstBackupAttempt(client: SqlClient, workspaceId: string): Promise<FirstBackupAttemptRow | null> {
  const [attempt] = await client<FirstBackupAttemptRow[]>`
    select
      backups.id as "backupId",
      backups.download_filename as "downloadFilename",
      backups.stored_size_bytes::text as "storedSizeBytes",
      backup_jobs.started_at as "startedAt",
      backup_jobs.finished_at as "finishedAt",
      backup_jobs.id as "jobId",
      backup_jobs.stage::text as "jobStage",
      backup_jobs.status::text as "jobStatus",
      backup_jobs.user_error_message as "userErrorMessage"
    from backup_jobs
    left join backups on backups.backup_job_id = backup_jobs.id
      and backups.workspace_id = backup_jobs.workspace_id
      and backups.status = 'succeeded'
    where backup_jobs.workspace_id = ${workspaceId}
      and backup_jobs.trigger = 'manual'
      and backup_jobs.status in ('succeeded', 'failed')
    order by coalesce(backup_jobs.finished_at, backup_jobs.queued_at) asc, backup_jobs.id asc
    limit 1
  `;

  return attempt ?? null;
}

function buildDashboardChecklist(input: {
  storageStatus: string;
  projectCount: number;
  sourceCount: number;
  testedSourceCount: number;
  invitedMemberCount: number;
  lastBackupStatus: "succeeded" | "failed" | null;
}): DashboardChecklistItem[] {
  return [
    { key: "workspace_created", label: "Workspace created", complete: true, optional: false },
    { key: "storage_provisioned", label: "Storage provisioned", complete: input.storageStatus === "ready", optional: false },
    { key: "project_created", label: "Project created", complete: input.projectCount > 0, optional: false },
    { key: "database_source_added", label: "Database Source added", complete: input.sourceCount > 0, optional: false },
    { key: "connection_tested", label: "Connection tested", complete: input.testedSourceCount > 0, optional: false },
    { key: "first_backup_succeeded", label: "First Backup succeeded", complete: input.lastBackupStatus === "succeeded", optional: false },
    { key: "team_invited_optional", label: "Team invite optional", complete: input.invitedMemberCount > 0, optional: true }
  ];
}

function buildDashboardResponse(input: {
  storageStatus: string;
  storageUsedBytes: bigint;
  storageLimitBytes: bigint;
  projectCount: number;
  sourceCount: number;
  testedSourceCount: number;
  invitedMemberCount: number;
  lastBackup: { id: string; status: "succeeded" | "failed"; filename: string | null; createdAt: string; errorMessage: string | null } | null;
}) {
  const checklist = buildDashboardChecklist({
    storageStatus: input.storageStatus,
    projectCount: input.projectCount,
    sourceCount: input.sourceCount,
    testedSourceCount: input.testedSourceCount,
    invitedMemberCount: input.invitedMemberCount,
    lastBackupStatus: input.lastBackup?.status ?? null
  });
  const setupComplete = checklist.every((item) => item.optional || item.complete);
  const readyForFirstBackup = input.storageStatus === "ready"
    && input.projectCount > 0
    && input.sourceCount > 0
    && input.testedSourceCount > 0;
  const status = input.lastBackup?.status === "failed"
    ? "last_failed"
    : input.lastBackup?.status === "succeeded"
      ? "last_succeeded"
      : readyForFirstBackup
        ? "ready"
        : "setup_incomplete";

  return {
    status,
    storageUsedBytes: input.storageUsedBytes.toString(),
    storageLimitBytes: input.storageLimitBytes.toString(),
    storageUsagePercent: input.storageLimitBytes > 0n ? Math.max(0, Math.min(100, Number((input.storageUsedBytes * 10_000n) / input.storageLimitBytes) / 100)) : 0,
    setupComplete,
    lastBackupAt: input.lastBackup?.createdAt ?? null,
    lastBackupId: input.lastBackup?.id ?? null,
    lastBackupFilename: input.lastBackup?.filename ?? null,
    lastBackupErrorMessage: input.lastBackup?.status === "failed" ? input.lastBackup.errorMessage ?? "Backup failed before verification completed." : null,
    checklist
  };
}

function buildFirstBackupResponse(input: {
  workspaceRole: string;
  attempt: FirstBackupAttemptRow;
}) {
  if (input.attempt.jobStatus === "succeeded" && input.attempt.backupId && input.attempt.downloadFilename && input.attempt.storedSizeBytes) {
    return {
      status: "succeeded",
      backupId: input.attempt.backupId,
      filename: input.attempt.downloadFilename,
      storedSizeBytes: input.attempt.storedSizeBytes,
      durationSeconds: input.attempt.startedAt && input.attempt.finishedAt
        ? Math.max(0, Math.round((input.attempt.finishedAt.getTime() - input.attempt.startedAt.getTime()) / 1000))
        : null,
      downloadReady: true,
      invitePromptVisible: input.workspaceRole === "owner" || input.workspaceRole === "admin"
    };
  }

  return {
    status: "failed",
    backupJobId: input.attempt.jobId,
    failedStage: input.attempt.jobStage,
    failureReason: input.attempt.userErrorMessage ?? "Backup failed before verification completed.",
    actions: ["retry", "edit"]
  };
}

export function createWorkspaceRoutes(partialConfig: Partial<WorkspaceConfig> = {}) {
  const config = defaultWorkspaceConfig(partialConfig);

  return new Elysia()
    .get("/workspaces", async ({ request, query }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const includeDeleted = query.include_deleted === "true";
      const rows = await client<WorkspaceRow[]>`
        select workspaces.id,
          workspaces.name,
          workspaces.slug,
          workspaces.timezone,
          plans.slug::text as "planSlug",
          workspaces.storage_status::text as "storageStatus",
          workspace_members.role::text as role,
          workspaces.soft_deleted_at as "softDeletedAt"
        from workspaces
        inner join workspace_members on workspace_members.workspace_id = workspaces.id
        inner join plans on plans.id = workspaces.plan_id
        where workspace_members.user_id = ${user.id}
          and (${includeDeleted}::boolean or workspaces.soft_deleted_at is null)
        order by workspaces.created_at asc
      `;

      return jsonResponse({ workspaces: rows.map(serializeWorkspace) });
    }))
    .post("/workspaces", async ({ request, body }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const [existing] = await client<{ count: string }[]>`
        select count(*)::text as count
        from workspace_members
        inner join workspaces on workspaces.id = workspace_members.workspace_id
        where workspace_members.user_id = ${user.id}
          and workspaces.soft_deleted_at is null
      `;
      if (Number(existing?.count ?? "0") >= 1) {
        return jsonResponse({ error: { code: "workspace_limit_requires_admin_approval" } }, { status: 403 });
      }

      const payload = parseJsonObject(body);
      const name = cleanName(payload.name);
      if (!name) {
        return jsonResponse({ error: { code: "workspace.name_required" } }, { status: 400 });
      }

      const timezone = cleanTimezone(payload.timezone);
      const slug = await ensureUniqueSlug(client, cleanSlug(payload.slug, name));
      const requestedPlan = typeof payload.requested_plan === "string" ? payload.requested_plan.trim().toLowerCase() : "basic";
      if (requestedPlan !== "basic" && !requestablePlans.has(requestedPlan)) {
        return jsonResponse({ error: { code: "plan.request_invalid" } }, { status: 400 });
      }
      const [plan] = await client<{ id: string }[]>`select id from plans where slug = 'basic' limit 1`;
      if (!plan) {
        return jsonResponse({ error: { code: "plan.basic_missing" } }, { status: 500 });
      }
      const [requestedPlanRow] = requestedPlan === "basic" ? [null] : await client<{ id: string }[]>`select id from plans where slug = ${requestedPlan} limit 1`;
      if (requestedPlan !== "basic" && !requestedPlanRow) {
        return jsonResponse({ error: { code: "plan.not_found" } }, { status: 404 });
      }

      const workspaceId = await client.begin(async (transaction) => {
        const [created] = await transaction<{ id: string }[]>`
          insert into workspaces (name, slug, timezone, plan_id, storage_status, onboarding_step)
          values (${name}, ${slug}, ${timezone}, ${plan.id}, 'provisioning', 'project')
          returning id
        `;
        if (!created) {
          throw new Error("workspace.create_failed");
        }

        await transaction`
          insert into workspace_members (workspace_id, user_id, role)
          values (${created.id}, ${user.id}, 'owner')
        `;

        if (requestedPlanRow) {
          await transaction`
            insert into plan_requests (workspace_id, requested_plan_id, requested_by_user_id, status)
            values (${created.id}, ${requestedPlanRow.id}, ${user.id}, 'pending')
          `;
        }

        return created.id;
      });
      const workspace = await selectWorkspaceForUser(client, user.id, workspaceId);

      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.create_failed" } }, { status: 500 });
      }

      return jsonResponse({ workspace: serializeWorkspace(workspace) }, { status: 201 });
    }))
    .get("/workspaces/:workspaceId", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceForUser(client, user.id, params.workspaceId);
      return workspace ? jsonResponse({ workspace: serializeWorkspace(workspace) }) : jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
    }))
    .get("/workspaces/:workspaceId/dashboard", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceForUser(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const [counts, lastBackup, limits, retainedBytes] = await Promise.all([
        selectDashboardCounts(client, workspace.id),
        selectLastBackup(client, workspace.id),
        resolveWorkspacePlanLimits(client, workspace.id),
        getWorkspaceRetainedStorageBytes(client, workspace.id)
      ]);

      if (!limits) {
        return jsonResponse({ error: { code: "workspace.plan_limits_missing" } }, { status: 500 });
      }

      const dashboard = buildDashboardResponse({
        storageStatus: workspace.storageStatus,
        storageUsedBytes: retainedBytes,
        storageLimitBytes: limits.retainedStorageBytesLimit,
        projectCount: Number(counts.project_count),
        sourceCount: Number(counts.source_count),
        testedSourceCount: Number(counts.tested_source_count),
        invitedMemberCount: Number(counts.invited_member_count),
        lastBackup: lastBackup
          ? {
              id: lastBackup.backupId,
              status: lastBackup.backupStatus,
              filename: lastBackup.backupFilename,
              createdAt: lastBackup.backupCreatedAt.toISOString(),
              errorMessage: lastBackup.backupErrorMessage
            }
          : null
      });

      return jsonResponse({ dashboard });
    }))
    .get("/workspaces/:workspaceId/first-backup", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceForUser(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const attempt = await selectFirstBackupAttempt(client, workspace.id);
      if (!attempt) {
        return jsonResponse({ firstBackup: null });
      }

      return jsonResponse({ firstBackup: buildFirstBackupResponse({ workspaceRole: workspace.role, attempt }) });
    }))
    .patch("/workspaces/:workspaceId", async ({ request, params, body }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceForUser(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (workspace.role !== "owner") {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const payload = parseJsonObject(body);
      const name = cleanName(payload.name) ?? workspace.name;
      const timezone = Object.hasOwn(payload, "timezone") ? cleanTimezone(payload.timezone) : workspace.timezone;
      const slug = Object.hasOwn(payload, "slug") ? await ensureUniqueSlug(client, cleanSlug(payload.slug, name), workspace.id) : workspace.slug;

      await client`
        update workspaces
        set name = ${name}, slug = ${slug}, timezone = ${timezone}, updated_at = now()
        where id = ${workspace.id}
      `;

      const updated = await selectWorkspaceForUser(client, user.id, workspace.id);
      return updated ? jsonResponse({ workspace: serializeWorkspace(updated) }) : jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
    }))
    .delete("/workspaces/:workspaceId", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceForUser(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (workspace.role !== "owner") {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      await client`update workspaces set soft_deleted_at = now(), purge_scheduled_at = now() + interval '7 days', updated_at = now() where id = ${workspace.id}`;
      return jsonResponse({ ok: true });
    }))
    .post("/workspaces/:workspaceId/restore", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceForUser(client, user.id, params.workspaceId, true);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (workspace.role !== "owner") {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      await client`update workspaces set soft_deleted_at = null, purge_scheduled_at = null, updated_at = now() where id = ${workspace.id}`;
      const restored = await selectWorkspaceForUser(client, user.id, workspace.id);
      return restored ? jsonResponse({ workspace: serializeWorkspace(restored) }) : jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
    }));
}
