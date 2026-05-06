import { createSqlClient, getDatabaseUrl, waitForDatabase } from "../../packages/db/src/testing";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const containerName = "mba-postgres-test";
const defaultDatabaseUrl = "postgres://postgres:postgres@127.0.0.1:55432/manual_backup_beta";
let resolvedDatabaseUrl: string | null = null;

function resolveProcessScopedDatabaseName(baseName: string): string {
  const explicit = process.env.MBA_TEST_DB_NAME?.trim();
  if (explicit) {
    return explicit;
  }

  const suffix = process.env.BUN_WORKER_ID?.trim() || `${process.pid}`;
  const normalizedSuffix = suffix.replace(/[^a-zA-Z0-9_]+/g, "_");
  return `${baseName}_${normalizedSuffix}`;
}

export function resolveDatabaseUrl(): string {
  if (resolvedDatabaseUrl) {
    return resolvedDatabaseUrl;
  }

  const raw = process.env.DATABASE_URL ?? defaultDatabaseUrl;
  const parsed = new URL(raw);
  const baseDatabaseName = parsed.pathname.replace(/^\//, "") || "manual_backup_beta";
  parsed.pathname = `/${resolveProcessScopedDatabaseName(baseDatabaseName)}`;
  resolvedDatabaseUrl = parsed.toString();
  return resolvedDatabaseUrl;
}

function parseDockerArgs(databaseUrl: string): { host: string; port: string; user: string; password: string; database: string } {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port || "5432",
    user: decodeURIComponent(url.username || "postgres"),
    password: decodeURIComponent(url.password || "postgres"),
    database: url.pathname.replace(/^\//, "") || "manual_backup_beta"
  };
}

async function createDatabaseIfMissing(databaseUrl: string): Promise<void> {
  const { database } = parseDockerArgs(databaseUrl);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const client = createSqlClient(adminUrl.toString());

  try {
    const [existing] = await client<{ exists: boolean }[]>`
      select exists(select 1 from pg_database where datname = ${database}) as exists
    `;

    if (!existing?.exists) {
      await client.unsafe(`create database "${database.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.end();
  }
}

export async function ensureTestDatabase(): Promise<string> {
  const databaseUrl = resolveDatabaseUrl();
  process.env.DATABASE_URL = databaseUrl;
  const { host, port, user, password, database } = parseDockerArgs(databaseUrl);

  try {
    await createDatabaseIfMissing(databaseUrl);
    await waitForDatabase(databaseUrl, 2);
    return databaseUrl;
  } catch {
    if (host !== "127.0.0.1" && host !== "localhost") {
      throw new Error(`DATABASE_URL host ${host} unreachable and auto-start supports only localhost/127.0.0.1`);
    }

    const existingContainer = await Bun.$`docker ps -a --filter name=${containerName} --format {{.Names}}`.text();

    if (existingContainer.trim() === containerName) {
      await createDatabaseIfMissing(databaseUrl);
      await waitForDatabase(databaseUrl);
      return databaseUrl;
    }

    await Bun.$`docker rm -f ${containerName}`.quiet().nothrow();
    await Bun.$`docker run --name ${containerName} -e POSTGRES_USER=${user} -e POSTGRES_PASSWORD=${password} -e POSTGRES_DB=${database} -p ${port}:5432 -d postgres:16-alpine`;
    await createDatabaseIfMissing(databaseUrl);
    await waitForDatabase(databaseUrl);

    return databaseUrl;
  }
}

export async function resetPublicSchema(databaseUrl = getDatabaseUrl()): Promise<void> {
  const client = createSqlClient(databaseUrl);

  try {
    await client.unsafe("drop schema if exists public cascade; create schema public;");
  } finally {
    await client.end();
  }
}

function advisoryLockKey(databaseUrl: string): bigint {
  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.replace(/^\//, "") || "manual_backup_beta";
  let value = 0n;
  for (const char of databaseName) {
    value = (value * 131n + BigInt(char.charCodeAt(0))) % 9_223_372_036_854_775_807n;
  }
  return value;
}

export async function ensureFreshTestSchema(databaseUrl = getDatabaseUrl()): Promise<string> {
  await ensureTestDatabase();
  const client = createSqlClient(databaseUrl);
  const lockKey = advisoryLockKey(databaseUrl);

  try {
    const migrationPath = join(import.meta.dir, "../../packages/db/migrations/0001_initial.sql");
    const migrationSql = await readFile(migrationPath, "utf8");

    await client`select pg_advisory_lock(${lockKey.toString()}::bigint)`;
    await client.unsafe("drop schema if exists public cascade; create schema public;");
    await client.unsafe(migrationSql);

    for (const plan of (await import("../../packages/db/src/plans")).SEEDED_PLANS) {
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
    try {
      await client`select pg_advisory_unlock(${lockKey.toString()}::bigint)`;
    } catch {
      // ignore unlock failures during teardown
    }
    await client.end();
  }
  return databaseUrl;
}
