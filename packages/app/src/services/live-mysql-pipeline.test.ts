import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb, createSqlClient, type SqlClient } from '../db/client';
import { backupJobs, backupStorageConfigs, backups, databaseSources, plans, projects, users, workspaceMembers, workspaces } from '../db/schema';
import { decryptBackupArtifact } from './backup-artifact-crypto';
import { processQueuedBackupJobScaffold } from './backup-worker';
import { testConnection } from './database-engine-adapters';
import { encryptSecret } from './secret-vault';

const runLive = Bun.env.RUN_LIVE_MYSQL_PIPELINE === 'true';
Bun.env.DATABASE_URL = Bun.env.LIVE_POSTGRES_DATABASE_URL ?? 'postgres://backup_saas:backup_saas@localhost:5433/backup_saas';
Bun.env.APP_MASTER_KEY_V1 = Buffer.from(new Uint8Array(32).fill(47)).toString('base64url');
Bun.env.OBJECT_STORAGE_PROVIDER = 'local';
Bun.env.OBJECT_STORAGE_LOCAL_DIR = `.storage/live-mysql-test-${crypto.randomUUID()}`;
Bun.env.BACKUP_DUMP_MODE = 'process';
delete Bun.env.BACKUP_FAKE_DUMP_OUTPUT;
delete Bun.env.BACKUP_FAKE_DUMP_ERROR;
delete Bun.env.BACKUP_MYSQL_DUMP_COMMAND;

describe.skipIf(!runLive)('Live MySQL backup pipeline', () => {
  let sql: SqlClient;
  const ids: string[] = [];
  const fixtureTable = `live_backup_fixture_${crypto.randomUUID().replaceAll('-', '_')}`;
  const mysqlConnection = {
    engine: 'mysql' as const,
    host: Bun.env.LIVE_MYSQL_HOST ?? '127.0.0.1',
    port: Number(Bun.env.LIVE_MYSQL_PORT ?? 3307),
    database: Bun.env.LIVE_MYSQL_DATABASE ?? 'backup_saas_fixture',
    username: Bun.env.LIVE_MYSQL_USERNAME ?? 'backup_saas',
    password: Bun.env.LIVE_MYSQL_PASSWORD ?? 'backup_saas',
    sslMode: 'disable',
  };

  async function mysqlExec(statement: string) {
    const proc = Bun.spawn(['mysql', '--batch', '--skip-column-names', `--host=${mysqlConnection.host}`, `--port=${mysqlConnection.port}`, `--user=${mysqlConnection.username}`, `--database=${mysqlConnection.database}`, `--execute=${statement}`], {
      env: { ...Bun.env, MYSQL_PWD: mysqlConnection.password },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) throw new Error(stderr);
  }

  beforeAll(async () => {
    sql = createSqlClient();
    await mysqlExec(`create table ${fixtureTable} (id int primary key, note varchar(255) not null)`);
    await mysqlExec(`insert into ${fixtureTable} (id, note) values (1, 'live-mysql-fixture-row')`);
  });

  afterAll(async () => {
    await mysqlExec(`drop table if exists ${fixtureTable}`).catch(() => undefined);
    for (const id of ids.reverse()) {
      await sql`delete from audit_events where workspace_id = ${id} or resource_id = ${id}`;
      await sql`delete from backups where id = ${id} or backup_job_id = ${id} or workspace_id = ${id}`;
      await sql`delete from backup_jobs where id = ${id} or workspace_id = ${id}`;
      await sql`delete from database_sources where id = ${id} or workspace_id = ${id}`;
      await sql`delete from projects where id = ${id} or workspace_id = ${id}`;
      await sql`delete from backup_storage_configs where id = ${id} or workspace_id = ${id}`;
      await sql`delete from workspace_members where workspace_id = ${id} or user_id = ${id}`;
      await sql`delete from workspaces where id = ${id}`;
      await sql`delete from users where id = ${id}`;
    }
    await sql.end();
  });

  test('tests connection, runs real mysqldump, stores encrypted artifact containing fixture data', async () => {
    const testResult = await testConnection(mysqlConnection);
    expect(testResult.ok).toBe(true);
    expect(testResult.server_version).toBeTruthy();
    expect(testResult.can_dump).toBe(true);

    const db = createDb(sql);
    const [plan] = await db.select().from(plans).where(eq(plans.slug, 'basic')).limit(1);
    const [user] = await db.insert(users).values({ email: `live-mysql-${crypto.randomUUID()}@example.com`, name: 'Live MySQL User' }).returning();
    const [workspace] = await db.insert(workspaces).values({ name: 'Live MySQL Workspace', slug: `live-mysql-${crypto.randomUUID()}`, timezone: 'Asia/Jakarta', planId: plan!.id, storageStatus: 'ready' }).returning();
    const [project] = await db.insert(projects).values({ workspaceId: workspace!.id, name: 'Live MySQL Project', createdByUserId: user!.id }).returning();
    const [storageConfig] = await db.insert(backupStorageConfigs).values({ workspaceId: workspace!.id, provider: 'local_disk', mode: 'platform_managed', displayName: 'Live MySQL local storage', storagePrefix: 'live-mysql-test', status: 'active', isCurrent: true }).returning();
    const [source] = await db.insert(databaseSources).values({
      workspaceId: workspace!.id,
      projectId: project!.id,
      engine: 'mysql',
      displayName: 'Live MySQL',
      technicalDatabaseName: mysqlConnection.database,
      host: mysqlConnection.host,
      port: mysqlConnection.port,
      username: mysqlConnection.username,
      encryptedPassword: await encryptSecret(mysqlConnection.password),
      credentialFingerprint: 'sha256:live-mysql',
      sslMode: mysqlConnection.sslMode,
      state: 'enabled',
      health: 'healthy',
      lastConnectionTestStatus: 'succeeded',
      createdByUserId: user!.id,
    }).returning();
    const [job] = await db.insert(backupJobs).values({ workspaceId: workspace!.id, projectId: project!.id, databaseSourceId: source!.id, trigger: 'manual', requestedByUserId: user!.id, status: 'queued', stage: 'queued' }).returning();
    ids.push(user!.id, workspace!.id, project!.id, storageConfig!.id, source!.id, job!.id);
    await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: user!.id, role: 'owner' });

    const result = await processQueuedBackupJobScaffold(db);
    expect(result?.status).toBe('succeeded');
    const [backup] = await db.select().from(backups).where(eq(backups.backupJobId, job!.id)).limit(1);
    ids.push(backup!.id);
    expect(backup!.format).toBe('mysql_sql_gzip');
    expect(backup!.originalSizeBytes).toBeGreaterThan(0);

    const stored = await Bun.file(`${Bun.env.OBJECT_STORAGE_LOCAL_DIR}/${backup!.objectKey}`).bytes();
    const firstLine = new TextDecoder().decode(stored).split('\n')[0]!;
    const envelope = JSON.parse(firstLine) as { version: string };
    expect(envelope.version).toBe('backup-artifact-stream-ndjson-v1');
    const plaintext = await decryptBackupArtifact(stored);
    expect(plaintext[0]).toBe(0x1f);
    expect(plaintext[1]).toBe(0x8b);
    const dumpText = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(plaintext)));
    expect(dumpText).toContain(fixtureTable);
    expect(dumpText).toContain('live-mysql-fixture-row');
  });
});
