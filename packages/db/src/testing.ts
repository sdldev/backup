import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { schema } from "./schema";
import { SEEDED_PLANS } from "./plans";

const postgresReadySql = "select 1 as ready";

export function getDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;

  if (!value) {
    throw new Error("DATABASE_URL is required for DB tasks");
  }

  return value;
}

export function createSqlClient(databaseUrl = getDatabaseUrl()) {
  return postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    prepare: false
  });
}

export function createDb(databaseUrl = getDatabaseUrl()) {
  const client = createSqlClient(databaseUrl);

  return {
    client,
    db: drizzle(client, { schema })
  };
}

export async function waitForDatabase(databaseUrl = getDatabaseUrl(), attempts = 30): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const client = createSqlClient(databaseUrl);

    try {
      await client.unsafe(postgresReadySql);
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end({ timeout: 0 });
      await Bun.sleep(1000);
    }
  }

  throw new Error(`Database did not become ready: ${String(lastError)}`);
}

export async function applySqlFile(fileName: string, databaseUrl = getDatabaseUrl()): Promise<void> {
  const client = createSqlClient(databaseUrl);

  try {
    const filePath = join(import.meta.dir, "..", "migrations", fileName);
    const sqlText = await readFile(filePath, "utf8");
    await client.unsafe(sqlText);
  } finally {
    await client.end();
  }
}

export async function seedPlans(databaseUrl = getDatabaseUrl()): Promise<void> {
  const client = createSqlClient(databaseUrl);

  try {
    for (const plan of SEEDED_PLANS) {
      await client`
        insert into plans (
          slug,
          display_name,
          is_request_only,
          database_source_limit,
          retained_storage_bytes_limit,
          retention_days_max,
          schedule_frequency_per_day_max,
          workspace_member_limit,
          manual_backup_per_hour_limit
        ) values (
          ${plan.slug},
          ${plan.displayName},
          ${plan.isRequestOnly},
          ${plan.databaseSourceLimit},
          ${plan.retainedStorageBytesLimit.toString()},
          ${plan.retentionDaysMax},
          ${plan.scheduleFrequencyPerDayMax},
          ${plan.workspaceMemberLimit},
          ${plan.manualBackupPerHourLimit}
        )
        on conflict (slug) do update set
          display_name = excluded.display_name,
          is_request_only = excluded.is_request_only,
          database_source_limit = excluded.database_source_limit,
          retained_storage_bytes_limit = excluded.retained_storage_bytes_limit,
          retention_days_max = excluded.retention_days_max,
          schedule_frequency_per_day_max = excluded.schedule_frequency_per_day_max,
          workspace_member_limit = excluded.workspace_member_limit,
          manual_backup_per_hour_limit = excluded.manual_backup_per_hour_limit,
          updated_at = now()
      `;
    }
  } finally {
    await client.end();
  }
}
