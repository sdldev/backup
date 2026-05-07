import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb, createSqlClient, type SqlClient } from '../db/client';
import { backupJobs, backupStorageConfigs, backups, databaseSources, plans, projects, users, workspaceMembers, workspaces } from '../db/schema';
import { decryptBackupArtifact } from './backup-artifact-crypto';
import { processQueuedBackupJobScaffold } from './backup-worker';
import { testConnection } from './database-engine-adapters';
import { encryptSecret } from './secret-vault';

const runLive = Bun.env.RUN_LIVE_POSTGRES_PIPELINE === 'true';
Bun.env.DATABASE_URL = Bun.env.LIVE_POSTGRES_DATABASE_URL ?? 'postgres://backup_saas:backup_saas@localhost:5433/backup_saas';
Bun.env.APP_MASTER_KEY_V1 = Buffer.from(new Uint8Array(32).fill(43)).toString('base64url');
Bun.env.OBJECT_STORAGE_PROVIDER = 'local';
Bun.env.OBJECT_STORAGE_LOCAL_DIR = `.storage/live-pg-test-${crypto.randomUUID()}`;
Bun.env.BACKUP_DUMP_MODE = 'process';
delete Bun.env.BACKUP_FAKE_DUMP_OUTPUT;
delete Bun.env.BACKUP_FAKE_DUMP_ERROR;
delete Bun.env.BACKUP_POSTGRES_DUMP_COMMAND;

describe.skipIf(!runLive)('Live PostgreSQL backup pipeline', () => {
  let sql: SqlClient;
  const ids: string[] = [];
  const fixtureTable = `live_backup_fixture_${crypto.randomUUID().replaceAll('-', '_')}`;

  beforeAll(async () => {
    sql = createSqlClient();
    await sql.unsafe(`create table ${fixtureTable} (id integer primary key, note text not null)`);
    await sql.unsafe(`insert into ${fixtureTable} (id, note) values (1, 'live-fixture-row')`);
  });

  afterAll(async () => {
    await sql.unsafe(`drop table if exists ${fixtureTable}`);
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

  test('tests connection, runs real pg_dump, stores encrypted artifact containing fixture data', async () => {
    const connection = {
      engine: 'postgresql' as const,
      host: 'localhost',
      port: 5433,
      database: 'backup_saas',
      username: 'backup_saas',
      password: 'backup_saas',
      sslMode: 'disable',
    };
    const testResult = await testConnection(connection);
    expect(testResult.ok).toBe(true);
    expect(testResult.server_version).toBeTruthy();
    expect(testResult.can_dump).toBe(true);

    const db = createDb(sql);
    const [plan] = await db.select().from(plans).where(eq(plans.slug, 'basic')).limit(1);
    const [user] = await db.insert(users).values({ email: `live-pg-${crypto.randomUUID()}@example.com`, name: 'Live PG User' }).returning();
    const [workspace] = await db.insert(workspaces).values({ name: 'Live PG Workspace', slug: `live-pg-${crypto.randomUUID()}`, timezone: 'Asia/Jakarta', planId: plan!.id, storageStatus: 'ready' }).returning();
    const [project] = await db.insert(projects).values({ workspaceId: workspace!.id, name: 'Live PG Project', createdByUserId: user!.id }).returning();
    const [storageConfig] = await db.insert(backupStorageConfigs).values({ workspaceId: workspace!.id, provider: 'local_disk', mode: 'platform_managed', displayName: 'Live local storage', storagePrefix: 'live-pg-test', status: 'active', isCurrent: true }).returning();
    const [source] = await db.insert(databaseSources).values({
      workspaceId: workspace!.id,
      projectId: project!.id,
      engine: 'postgresql',
      displayName: 'Live PostgreSQL',
      technicalDatabaseName: connection.database,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      encryptedPassword: await encryptSecret(connection.password),
      credentialFingerprint: 'sha256:live-pg',
      sslMode: connection.sslMode,
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
    expect(backup!.format).toBe('postgres_custom');
    expect(backup!.originalSizeBytes).toBeGreaterThan(0);

    const stored = await Bun.file(`${Bun.env.OBJECT_STORAGE_LOCAL_DIR}/${backup!.objectKey}`).bytes();
    const firstLine = new TextDecoder().decode(stored).split('\n')[0]!;
    const envelope = JSON.parse(firstLine) as { version: string };
    expect(envelope.version).toBe('backup-artifact-stream-ndjson-v1');
    const plaintext = await decryptBackupArtifact(stored);
    expect(new TextDecoder().decode(plaintext)).toContain(fixtureTable);
  });
});
