import { createHash } from "node:crypto";
import { appendAuditLogWithClient, createSqlClient, getDatabaseUrl, resolveWorkspacePlanLimits } from "@mba/db";
import { Elysia } from "elysia";

type SqlClient = ReturnType<typeof createSqlClient>;

export type AdminConfig = {
  databaseUrl: string;
};

type SessionUser = {
  id: string;
  sessionId: string;
  systemAdminId: string | null;
  systemRole: "system_admin" | "system_owner" | null;
};

type WorkspaceStatusRow = {
  id: string;
  name: string;
  slug: string;
  planSlug: string;
  storageStatus: string;
  sourceCount: string;
  backupCount: string;
  failedJobCount: string;
  retainedStorageBytes: string;
  latestBackupAt: Date | null;
};

type PlanRequestRow = {
  id: string;
  workspaceId: string;
  requestedPlan: string;
  status: string;
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
};

const sessionCookieName = "mba_session";

function defaultAdminConfig(partial: Partial<AdminConfig> = {}): AdminConfig {
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

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function cleanOptionalInteger(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function cleanOptionalBigIntString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }
  return value;
}

function cleanExpiry(value: unknown): Date | null | undefined {
  if (value === undefined || value === null) {
    return value === null ? null : undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  const expiresAt = new Date(value);
  return Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date() ? null : expiresAt;
}

async function withClient<T>(config: AdminConfig, run: (client: SqlClient) => Promise<T>): Promise<T> {
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

  return session ? { id: session.user_id, sessionId: session.session_id, systemAdminId: session.system_admin_id, systemRole: session.system_role } : null;
}

async function requireSystemAdmin(client: SqlClient, request: Request): Promise<SessionUser | Response> {
  const user = await getSessionUser(client, request);
  if (!user) {
    return jsonResponse({ error: { code: "auth.required" } }, { status: 401 });
  }
  return user.systemRole ? user : jsonResponse({ error: { code: "admin.permission_denied" } }, { status: 403 });
}

async function requireSystemOwner(client: SqlClient, request: Request): Promise<SessionUser | Response> {
  const user = await requireSystemAdmin(client, request);
  if (user instanceof Response) {
    return user;
  }
  return user.systemRole === "system_owner" ? user : jsonResponse({ error: { code: "admin.owner_required" } }, { status: 403 });
}

function serializePlanRequest(row: PlanRequestRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    requestedPlan: row.requestedPlan,
    status: row.status,
    reviewNote: row.reviewNote,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString()
  };
}

async function writeAdminAudit(client: SqlClient, request: Request, user: SessionUser, workspaceId: string | null, eventType: string, targetType: string, targetId: string, metadata: Record<string, unknown>) {
  await appendAuditLogWithClient(client, {
    workspaceId,
    eventType: eventType as never,
    targetType: targetType as never,
    targetId,
    result: "succeeded",
    metadata,
    context: {
      actorType: "user",
      actorUserId: user.id,
      effectiveActorUserId: user.id,
      systemAdminId: user.systemAdminId,
      sessionId: user.sessionId,
      requestId: request.headers.get("x-request-id"),
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: request.headers.get("user-agent"),
      impersonationReason: null
    }
  });
}

export function createAdminRoutes(partialConfig: Partial<AdminConfig> = {}) {
  const config = defaultAdminConfig(partialConfig);

  return new Elysia()
    .get("/admin/workspaces", async ({ request }) => withClient(config, async (client) => {
      const user = await requireSystemAdmin(client, request);
      if (user instanceof Response) {
        return user;
      }

      const rows = await client<WorkspaceStatusRow[]>`
        select workspaces.id,
          workspaces.name,
          workspaces.slug,
          plans.slug::text as "planSlug",
          workspaces.storage_status::text as "storageStatus",
          count(distinct database_sources.id)::text as "sourceCount",
          count(distinct backups.id)::text as "backupCount",
          count(distinct backup_jobs.id) filter (where backup_jobs.status = 'failed')::text as "failedJobCount",
          coalesce(sum(distinct backups.stored_size_bytes), 0)::text as "retainedStorageBytes",
          max(backups.created_at) as "latestBackupAt"
        from workspaces
        inner join plans on plans.id = workspaces.plan_id
        left join database_sources on database_sources.workspace_id = workspaces.id and database_sources.state <> 'deleted'
        left join backups on backups.workspace_id = workspaces.id and backups.status = 'succeeded' and backups.deleted_at is null and backups.expired_at is null
        left join backup_jobs on backup_jobs.workspace_id = workspaces.id
        where workspaces.soft_deleted_at is null
        group by workspaces.id, plans.slug
        order by workspaces.created_at desc
      `;

      return jsonResponse({ workspaces: rows.map((row) => ({ ...row, latestBackupAt: row.latestBackupAt?.toISOString() ?? null })) });
    }))
    .get("/admin/plan-requests", async ({ request }) => withClient(config, async (client) => {
      const user = await requireSystemAdmin(client, request);
      if (user instanceof Response) {
        return user;
      }

      const rows = await client<PlanRequestRow[]>`
        select plan_requests.id,
          plan_requests.workspace_id as "workspaceId",
          plans.slug::text as "requestedPlan",
          plan_requests.status::text as status,
          plan_requests.review_note as "reviewNote",
          plan_requests.reviewed_at as "reviewedAt",
          plan_requests.created_at as "createdAt"
        from plan_requests
        inner join plans on plans.id = plan_requests.requested_plan_id
        order by plan_requests.created_at desc
      `;

      return jsonResponse({ planRequests: rows.map(serializePlanRequest) });
    }))
    .post("/admin/plan-requests/:requestId/approve", async ({ request, params, body }) => withClient(config, async (client) => {
      const user = await requireSystemAdmin(client, request);
      if (user instanceof Response) {
        return user;
      }
      const note = cleanString(parseJsonObject(body).note, 1000);

      const [updated] = await client<PlanRequestRow[]>`
        update plan_requests
        set status = 'approved', reviewed_by_platform_admin_id = ${user.systemAdminId}, review_note = ${note}, reviewed_at = now()
        where id = ${params.requestId}
          and status = 'pending'
        returning id, workspace_id as "workspaceId", (select slug::text from plans where plans.id = plan_requests.requested_plan_id) as "requestedPlan", status::text as status, review_note as "reviewNote", reviewed_at as "reviewedAt", created_at as "createdAt"
      `;
      if (!updated) {
        return jsonResponse({ error: { code: "plan_request.not_found" } }, { status: 404 });
      }
      await client`update workspaces set plan_id = (select requested_plan_id from plan_requests where id = ${updated.id}), updated_at = now() where id = ${updated.workspaceId}`;
      await writeAdminAudit(client, request, user, updated.workspaceId, "plan_request.approve", "workspace", updated.workspaceId, { planRequestId: updated.id, note });
      return jsonResponse({ planRequest: serializePlanRequest(updated) });
    }))
    .post("/admin/plan-requests/:requestId/reject", async ({ request, params, body }) => withClient(config, async (client) => {
      const user = await requireSystemAdmin(client, request);
      if (user instanceof Response) {
        return user;
      }
      const note = cleanString(parseJsonObject(body).note, 1000);

      const [updated] = await client<PlanRequestRow[]>`
        update plan_requests
        set status = 'rejected', reviewed_by_platform_admin_id = ${user.systemAdminId}, review_note = ${note}, reviewed_at = now()
        where id = ${params.requestId}
          and status = 'pending'
        returning id, workspace_id as "workspaceId", (select slug::text from plans where plans.id = plan_requests.requested_plan_id) as "requestedPlan", status::text as status, review_note as "reviewNote", reviewed_at as "reviewedAt", created_at as "createdAt"
      `;
      if (!updated) {
        return jsonResponse({ error: { code: "plan_request.not_found" } }, { status: 404 });
      }
      await writeAdminAudit(client, request, user, updated.workspaceId, "plan_request.reject", "workspace", updated.workspaceId, { planRequestId: updated.id, note });
      return jsonResponse({ planRequest: serializePlanRequest(updated) });
    }))
    .post("/admin/workspaces/:workspaceId/limit-overrides", async ({ request, params, body }) => withClient(config, async (client) => {
      const user = await requireSystemAdmin(client, request);
      if (user instanceof Response) {
        return user;
      }
      const payload = parseJsonObject(body);
      const reason = cleanString(payload.reason, 1000);
      if (!reason) {
        return jsonResponse({ error: { code: "admin.override_reason_required" } }, { status: 400 });
      }

      const databaseSourceLimit = cleanOptionalInteger(payload.databaseSourceLimit ?? payload.database_source_limit);
      const retainedStorageBytesLimit = cleanOptionalBigIntString(payload.retainedStorageBytesLimit ?? payload.retained_storage_bytes_limit);
      const retentionDaysMax = cleanOptionalInteger(payload.retentionDaysMax ?? payload.retention_days_max);
      const scheduleFrequencyPerDayMax = cleanOptionalInteger(payload.scheduleFrequencyPerDayMax ?? payload.schedule_frequency_per_day_max);
      const workspaceMemberLimit = cleanOptionalInteger(payload.workspaceMemberLimit ?? payload.workspace_member_limit);
      const manualBackupPerHourLimit = cleanOptionalInteger(payload.manualBackupPerHourLimit ?? payload.manual_backup_per_hour_limit);
      const expiresAt = cleanExpiry(payload.expiresAt ?? payload.expires_at);

      if (databaseSourceLimit === null || retainedStorageBytesLimit === null || retentionDaysMax === null || scheduleFrequencyPerDayMax === null || workspaceMemberLimit === null || manualBackupPerHourLimit === null || expiresAt === null) {
        return jsonResponse({ error: { code: "admin.override_invalid" } }, { status: 400 });
      }

      const [workspace] = await client<{ id: string }[]>`select id from workspaces where id = ${params.workspaceId} and soft_deleted_at is null limit 1`;
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const [override] = await client<{ id: string; created_at: Date }[]>`
        insert into workspace_limit_overrides (
          workspace_id, database_source_limit, retained_storage_bytes_limit, retention_days_max,
          schedule_frequency_per_day_max, workspace_member_limit, manual_backup_per_hour_limit,
          reason, created_by_platform_admin_id, expires_at
        ) values (
          ${workspace.id}, ${databaseSourceLimit ?? null}, ${retainedStorageBytesLimit ?? null}, ${retentionDaysMax ?? null},
          ${scheduleFrequencyPerDayMax ?? null}, ${workspaceMemberLimit ?? null}, ${manualBackupPerHourLimit ?? null},
          ${reason}, ${user.systemAdminId}, ${expiresAt ?? null}
        ) returning id, created_at
      `;
      if (!override) {
        return jsonResponse({ error: { code: "admin.override_create_failed" } }, { status: 500 });
      }
      const limits = await resolveWorkspacePlanLimits(client, workspace.id);
      await writeAdminAudit(client, request, user, workspace.id, "workspace.limit_override.create", "workspace", workspace.id, { overrideId: override.id, reason, expiresAt: expiresAt?.toISOString() ?? null });
      return jsonResponse({ override: { id: override.id, workspaceId: workspace.id, reason, expiresAt: expiresAt?.toISOString() ?? null, createdAt: override.created_at.toISOString() }, limits: limits ? { ...limits, retainedStorageBytesLimit: limits.retainedStorageBytesLimit.toString() } : null }, { status: 201 });
    }))
    .post("/admin/system-admins", async ({ request, body }) => withClient(config, async (client) => {
      const user = await requireSystemOwner(client, request);
      if (user instanceof Response) {
        return user;
      }
      const payload = parseJsonObject(body);
      const userId = cleanString(payload.userId ?? payload.user_id, 80);
      const role = payload.role === "system_owner" ? "system_owner" : payload.role === "system_admin" ? "system_admin" : null;
      if (!userId || !role) {
        return jsonResponse({ error: { code: "admin.system_admin_invalid" } }, { status: 400 });
      }
      const [target] = await client<{ id: string }[]>`select id from users where id = ${userId} and disabled_at is null limit 1`;
      if (!target) {
        return jsonResponse({ error: { code: "user.not_found" } }, { status: 404 });
      }
      const [admin] = await client<{ id: string; role: string }[]>`
        insert into system_admins (user_id, role, created_by_user_id, disabled_at)
        values (${target.id}, ${role}, ${user.id}, null)
        on conflict (user_id) do update set role = excluded.role, disabled_at = null, updated_at = now()
        returning id, role::text
      `;
      if (!admin) {
        return jsonResponse({ error: { code: "admin.system_admin_create_failed" } }, { status: 500 });
      }
      await writeAdminAudit(client, request, user, null, "system_admin.upsert", "member", admin.id, { targetUserId: target.id, role: admin.role });
      return jsonResponse({ systemAdmin: { id: admin.id, userId: target.id, role: admin.role } }, { status: 201 });
    }))
    .delete("/admin/system-admins/:userId", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSystemOwner(client, request);
      if (user instanceof Response) {
        return user;
      }
      const [admin] = await client<{ id: string }[]>`
        update system_admins
        set disabled_at = now(), updated_at = now()
        where user_id = ${params.userId}
          and role <> 'system_owner'
          and disabled_at is null
        returning id
      `;
      if (!admin) {
        return jsonResponse({ error: { code: "admin.system_admin_not_found" } }, { status: 404 });
      }
      await writeAdminAudit(client, request, user, null, "system_admin.disable", "member", admin.id, { targetUserId: params.userId });
      return jsonResponse({ ok: true });
    }));
}
