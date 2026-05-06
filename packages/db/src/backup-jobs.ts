import type { Sql } from "postgres";

export type SqlClient = Sql;

export type ManualBackupAdmission =
  | {
      ok: true;
      workspaceId: string;
      projectId: string;
      sourceId: string;
      sourceState: string;
      sourceHealth: string;
      storageConfigId: string;
      manualBackupPerHourLimit: number;
      recentManualJobCount: number;
      activeJobCount: number;
    }
  | { ok: false; code: "workspace.not_found" | "source.not_found" | "source.disabled" | "workspace_storage_not_ready" | "manual_backup_rate_limit_exceeded" | "active_backup_job_exists" };

export type BackupJobRow = {
  id: string;
  workspaceId: string;
  projectId: string;
  databaseSourceId: string;
  trigger: string;
  requestedByUserId: string | null;
  status: string;
  stage: string;
  attemptCount: number;
  maxAttempts: number;
  errorCategory: string | null;
  userErrorMessage: string | null;
  internalErrorRef: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  cancelRequestedAt: Date | null;
  cancelRequestedByUserId: string | null;
};

type AdmissionRow = {
  workspace_id: string;
  project_id: string;
  source_id: string;
  source_state: string;
  source_health: string;
  storage_status: string;
  storage_config_id: string | null;
  manual_backup_per_hour_limit: number;
  recent_manual_job_count: string;
  active_job_count: string;
};

function mapJobRow(row: BackupJobRow): BackupJobRow {
  return row;
}

export async function getManualBackupAdmission(client: SqlClient, workspaceId: string, sourceId: string): Promise<ManualBackupAdmission> {
  const [row] = await client<AdmissionRow[]>`
    select workspaces.id as workspace_id,
      database_sources.project_id,
      database_sources.id as source_id,
      database_sources.state::text as source_state,
      database_sources.health::text as source_health,
      workspaces.storage_status::text as storage_status,
      storage.id as storage_config_id,
      limits.manual_backup_per_hour_limit,
      (
        select count(*)::text
        from backup_jobs recent_jobs
        where recent_jobs.workspace_id = workspaces.id
          and recent_jobs.trigger = 'manual'
          and recent_jobs.queued_at >= now() - interval '1 hour'
      ) as recent_manual_job_count
      ,(
        select count(*)::text
        from backup_jobs active_jobs
        where active_jobs.database_source_id = database_sources.id
          and active_jobs.workspace_id = workspaces.id
          and active_jobs.status in ('queued', 'running')
      ) as active_job_count
    from workspaces
    inner join database_sources on database_sources.workspace_id = workspaces.id
    inner join plans on plans.id = workspaces.plan_id
    left join lateral (
      select backup_storage_configs.id
      from backup_storage_configs
      where backup_storage_configs.workspace_id = workspaces.id
        and backup_storage_configs.is_current = true
        and backup_storage_configs.status = 'active'
      limit 1
    ) as storage on true
    left join lateral (
      select coalesce(active_override.manual_backup_per_hour_limit, plans.manual_backup_per_hour_limit) as manual_backup_per_hour_limit
      from plans plans_for_limits
      left join lateral (
        select workspace_limit_overrides.manual_backup_per_hour_limit
        from workspace_limit_overrides
        where workspace_limit_overrides.workspace_id = workspaces.id
          and (workspace_limit_overrides.expires_at is null or workspace_limit_overrides.expires_at > now())
        order by workspace_limit_overrides.created_at desc, workspace_limit_overrides.id desc
        limit 1
      ) as active_override on true,
      plans
      where plans_for_limits.id = workspaces.plan_id
      limit 1
    ) as limits on true
    where workspaces.id = ${workspaceId}
      and workspaces.soft_deleted_at is null
      and database_sources.id = ${sourceId}
      and database_sources.workspace_id = ${workspaceId}
      and database_sources.state <> 'deleted'
    limit 1
  `;

  if (!row) {
    const [workspace] = await client<{ id: string }[]>`
      select id
      from workspaces
      where id = ${workspaceId}
        and soft_deleted_at is null
      limit 1
    `;

    return workspace ? { ok: false, code: "source.not_found" } : { ok: false, code: "workspace.not_found" };
  }

  if (row.source_state !== "enabled") {
    return { ok: false, code: "source.disabled" };
  }

  if (row.storage_status !== "ready" || !row.storage_config_id) {
    return { ok: false, code: "workspace_storage_not_ready" };
  }

  if (Number(row.active_job_count) > 0) {
    return { ok: false, code: "active_backup_job_exists" };
  }

  if (Number(row.recent_manual_job_count) >= row.manual_backup_per_hour_limit) {
    return { ok: false, code: "manual_backup_rate_limit_exceeded" };
  }

  return {
    ok: true,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    sourceId: row.source_id,
    sourceState: row.source_state,
    sourceHealth: row.source_health,
    storageConfigId: row.storage_config_id,
    manualBackupPerHourLimit: row.manual_backup_per_hour_limit,
    recentManualJobCount: Number(row.recent_manual_job_count),
    activeJobCount: Number(row.active_job_count)
  };
}

export async function createManualBackupJob(client: SqlClient, workspaceId: string, projectId: string, sourceId: string, requestedByUserId: string): Promise<BackupJobRow> {
  const [job] = await client<BackupJobRow[]>`
    insert into backup_jobs (workspace_id, project_id, database_source_id, trigger, requested_by_user_id, status, stage)
    values (${workspaceId}, ${projectId}, ${sourceId}, 'manual', ${requestedByUserId}, 'queued', 'queued')
    returning id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      database_source_id as "databaseSourceId",
      trigger::text as trigger,
      requested_by_user_id as "requestedByUserId",
      status::text as status,
      stage::text as stage,
      attempt_count as "attemptCount",
      max_attempts as "maxAttempts",
      error_category as "errorCategory",
      user_error_message as "userErrorMessage",
      internal_error_ref as "internalErrorRef",
      queued_at as "queuedAt",
      started_at as "startedAt",
      finished_at as "finishedAt",
      cancel_requested_at as "cancelRequestedAt",
      cancel_requested_by_user_id as "cancelRequestedByUserId"
  `;

  if (!job) {
    throw new Error("backup_job.create_failed");
  }

  return mapJobRow(job);
}

export async function getBackupJob(client: SqlClient, workspaceId: string, jobId: string): Promise<BackupJobRow | null> {
  const [job] = await client<BackupJobRow[]>`
    select id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      database_source_id as "databaseSourceId",
      trigger::text as trigger,
      requested_by_user_id as "requestedByUserId",
      status::text as status,
      stage::text as stage,
      attempt_count as "attemptCount",
      max_attempts as "maxAttempts",
      error_category as "errorCategory",
      user_error_message as "userErrorMessage",
      internal_error_ref as "internalErrorRef",
      queued_at as "queuedAt",
      started_at as "startedAt",
      finished_at as "finishedAt",
      cancel_requested_at as "cancelRequestedAt",
      cancel_requested_by_user_id as "cancelRequestedByUserId"
    from backup_jobs
    where id = ${jobId}
      and workspace_id = ${workspaceId}
    limit 1
  `;

  return job ? mapJobRow(job) : null;
}

export async function requestBackupJobCancel(client: SqlClient, workspaceId: string, jobId: string, userId: string): Promise<BackupJobRow | null> {
  const [job] = await client<BackupJobRow[]>`
    update backup_jobs
    set cancel_requested_at = coalesce(cancel_requested_at, now()),
      cancel_requested_by_user_id = coalesce(cancel_requested_by_user_id, ${userId}),
      status = case when status = 'queued' then 'cancelled' else status end,
      stage = case when status = 'queued' then 'cancelled' else stage end,
      finished_at = case when status = 'queued' then now() else finished_at end,
      updated_at = now()
    where id = ${jobId}
      and workspace_id = ${workspaceId}
      and status in ('queued', 'running')
    returning id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      database_source_id as "databaseSourceId",
      trigger::text as trigger,
      requested_by_user_id as "requestedByUserId",
      status::text as status,
      stage::text as stage,
      attempt_count as "attemptCount",
      max_attempts as "maxAttempts",
      error_category as "errorCategory",
      user_error_message as "userErrorMessage",
      internal_error_ref as "internalErrorRef",
      queued_at as "queuedAt",
      started_at as "startedAt",
      finished_at as "finishedAt",
      cancel_requested_at as "cancelRequestedAt",
      cancel_requested_by_user_id as "cancelRequestedByUserId"
  `;

  return job ? mapJobRow(job) : null;
}
