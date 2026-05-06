import type { Sql } from "postgres";

export type SeedPlan = {
  slug: "basic" | "pro" | "agency";
  displayName: string;
  isRequestOnly: boolean;
  databaseSourceLimit: number;
  retainedStorageBytesLimit: bigint;
  retentionDaysMax: number;
  scheduleFrequencyPerDayMax: number;
  workspaceMemberLimit: number;
  manualBackupPerHourLimit: number;
};

const gib = 1024n ** 3n;
const tib = 1024n ** 4n;

export const SEEDED_PLANS: SeedPlan[] = [
  {
    slug: "basic",
    displayName: "Basic",
    isRequestOnly: false,
    databaseSourceLimit: 3,
    retainedStorageBytesLimit: 10n * gib,
    retentionDaysMax: 7,
    scheduleFrequencyPerDayMax: 1,
    workspaceMemberLimit: 2,
    manualBackupPerHourLimit: 1
  },
  {
    slug: "pro",
    displayName: "Pro",
    isRequestOnly: true,
    databaseSourceLimit: 20,
    retainedStorageBytesLimit: 100n * gib,
    retentionDaysMax: 30,
    scheduleFrequencyPerDayMax: 5,
    workspaceMemberLimit: 5,
    manualBackupPerHourLimit: 5
  },
  {
    slug: "agency",
    displayName: "Agency",
    isRequestOnly: true,
    databaseSourceLimit: 100,
    retainedStorageBytesLimit: 1n * tib,
    retentionDaysMax: 30,
    scheduleFrequencyPerDayMax: 5,
    workspaceMemberLimit: 20,
    manualBackupPerHourLimit: 10
  }
];

export type PlanLimits = {
  databaseSourceLimit: number;
  retainedStorageBytesLimit: bigint;
  retentionDaysMax: number;
  scheduleFrequencyPerDayMax: number;
  workspaceMemberLimit: number;
  manualBackupPerHourLimit: number;
};

type SqlClient = Sql;

type LimitRow = {
  database_source_limit: number;
  retained_storage_bytes_limit: string;
  retention_days_max: number;
  schedule_frequency_per_day_max: number;
  workspace_member_limit: number;
  manual_backup_per_hour_limit: number;
};

function rowToLimits(row: LimitRow): PlanLimits {
  return {
    databaseSourceLimit: row.database_source_limit,
    retainedStorageBytesLimit: BigInt(row.retained_storage_bytes_limit),
    retentionDaysMax: row.retention_days_max,
    scheduleFrequencyPerDayMax: row.schedule_frequency_per_day_max,
    workspaceMemberLimit: row.workspace_member_limit,
    manualBackupPerHourLimit: row.manual_backup_per_hour_limit
  };
}

export async function resolveWorkspacePlanLimits(client: SqlClient, workspaceId: string): Promise<PlanLimits | null> {
  const [row] = await client<LimitRow[]>`
    select
      coalesce(active_override.database_source_limit, plans.database_source_limit) as database_source_limit,
      coalesce(active_override.retained_storage_bytes_limit, plans.retained_storage_bytes_limit)::text as retained_storage_bytes_limit,
      coalesce(active_override.retention_days_max, plans.retention_days_max) as retention_days_max,
      coalesce(active_override.schedule_frequency_per_day_max, plans.schedule_frequency_per_day_max) as schedule_frequency_per_day_max,
      coalesce(active_override.workspace_member_limit, plans.workspace_member_limit) as workspace_member_limit,
      coalesce(active_override.manual_backup_per_hour_limit, plans.manual_backup_per_hour_limit) as manual_backup_per_hour_limit
    from workspaces
    inner join plans on plans.id = workspaces.plan_id
    left join lateral (
      select *
      from workspace_limit_overrides
      where workspace_limit_overrides.workspace_id = workspaces.id
        and (workspace_limit_overrides.expires_at is null or workspace_limit_overrides.expires_at > now())
      order by workspace_limit_overrides.created_at desc, workspace_limit_overrides.id desc
      limit 1
    ) as active_override on true
    where workspaces.id = ${workspaceId}
    limit 1
  `;

  return row ? rowToLimits(row) : null;
}

export async function getWorkspaceRetainedStorageBytes(client: SqlClient, workspaceId: string): Promise<bigint> {
  const [row] = await client<{ retained_bytes: string }[]>`
    select coalesce(sum(stored_size_bytes), 0)::text as retained_bytes
    from backups
    where workspace_id = ${workspaceId}
      and status = 'succeeded'
      and deleted_at is null
      and expired_at is null
  `;

  return BigInt(row?.retained_bytes ?? "0");
}

export async function assertWorkspaceHasStorageHeadroom(client: SqlClient, workspaceId: string): Promise<{ ok: true } | { ok: false; code: "storage_limit_exceeded" }> {
  const limits = await resolveWorkspacePlanLimits(client, workspaceId);
  if (!limits) {
    throw new Error("workspace.limits_missing");
  }

  const retainedBytes = await getWorkspaceRetainedStorageBytes(client, workspaceId);
  return retainedBytes >= limits.retainedStorageBytesLimit ? { ok: false, code: "storage_limit_exceeded" } : { ok: true };
}
