import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb, createSqlClient, type SqlClient } from '../db/client';
import { auditEvents, backupJobs, backupStorageConfigs, backups, databaseSources, plans, projects, users, workspaceMembers, workspaces } from '../db/schema';
import { decryptBackupArtifact } from './backup-artifact-crypto';
import { cancelAwareStream, processQueuedBackupJobScaffold } from './backup-worker';
import { encryptSecret } from './secret-vault';

Bun.env.DATABASE_URL = 'postgres://backup_saas:backup_saas@localhost:5433/backup_saas';
Bun.env.APP_MASTER_KEY_V1 = Buffer.from(new Uint8Array(32).fill(23)).toString('base64url');
Bun.env.OBJECT_STORAGE_PROVIDER = 'local';
Bun.env.OBJECT_STORAGE_LOCAL_DIR = `.storage/test-backups-${crypto.randomUUID()}`;
Bun.env.BACKUP_DUMP_MODE = 'process';
Bun.env.BACKUP_POSTGRES_DUMP_COMMAND = 'bun';
Bun.env.BACKUP_FAKE_DUMP_OUTPUT = 'fake-pg-dump';

describe('Backup worker process dump mode', () => {
  let sql: SqlClient;
  const ids: string[] = [];

  beforeAll(() => {
    sql = createSqlClient();
  });

  afterAll(async () => {
    delete Bun.env.BACKUP_FAKE_DUMP_ERROR;
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

  async function setupProcessModeFixture(cancelRequestedAt?: Date) {
    const db = createDb(sql);
    const [plan] = await db.select().from(plans).where(eq(plans.slug, 'basic')).limit(1);
    const [user] = await db.insert(users).values({ email: `worker-${crypto.randomUUID()}@example.com`, name: 'Worker User' }).returning();
    const [workspace] = await db.insert(workspaces).values({ name: 'Worker Workspace', slug: `worker-${crypto.randomUUID()}`, timezone: 'Asia/Jakarta', planId: plan!.id, storageStatus: 'ready' }).returning();
    const [project] = await db.insert(projects).values({ workspaceId: workspace!.id, name: 'Worker Project', createdByUserId: user!.id }).returning();
    const [storageConfig] = await db.insert(backupStorageConfigs).values({ workspaceId: workspace!.id, provider: 'local_disk', mode: 'platform_managed', displayName: 'Local test storage', storagePrefix: 'worker-test', status: 'active', isCurrent: true }).returning();
    const [source] = await db.insert(databaseSources).values({
      workspaceId: workspace!.id,
      projectId: project!.id,
      engine: 'postgresql',
      displayName: 'Worker Postgres',
      technicalDatabaseName: 'app',
      host: 'pg.example.com',
      port: 5432,
      username: 'postgres',
      encryptedPassword: await encryptSecret('secret'),
      credentialFingerprint: 'sha256:test',
      sslMode: 'disable',
      state: 'enabled',
      health: 'healthy',
      lastConnectionTestStatus: 'succeeded',
      createdByUserId: user!.id,
    }).returning();
    const [job] = await db.insert(backupJobs).values({ workspaceId: workspace!.id, projectId: project!.id, databaseSourceId: source!.id, trigger: 'manual', requestedByUserId: user!.id, status: 'queued', stage: 'queued', cancelRequestedAt }).returning();
    ids.push(user!.id, workspace!.id, project!.id, storageConfig!.id, source!.id, job!.id);
    await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: user!.id, role: 'owner' });
    return { db, job };
  }

  test('cancel-aware upload stream aborts mid-stream', async () => {
    let checks = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first'));
        controller.enqueue(new TextEncoder().encode('second'));
        controller.close();
      },
    });

    const guarded = cancelAwareStream(stream, async () => {
      checks += 1;
      return checks > 1;
    });

    await expect(new Response(guarded).text()).rejects.toThrow('Backup Job cancellation requested');
  });

  test('runs fake pg_dump command, encrypts output, and stores Backup metadata', async () => {
    const { db, job } = await setupProcessModeFixture();

    const result = await processQueuedBackupJobScaffold(db);

    expect(result?.status).toBe('succeeded');
    const [backup] = await db.select().from(backups).where(eq(backups.backupJobId, job!.id)).limit(1);
    expect(backup).toBeDefined();
    ids.push(backup!.id);
    expect(backup!.format).toBe('postgres_custom');
    expect(backup!.originalSizeBytes).toBe(12);
    expect(backup!.encryptedSizeBytes).toBeGreaterThan(12);

    const stored = await Bun.file(`${Bun.env.OBJECT_STORAGE_LOCAL_DIR}/${backup!.objectKey}`).bytes();
    const firstLine = new TextDecoder().decode(stored).split('\n')[0]!;
    const envelope = JSON.parse(firstLine) as { version: string };
    expect(envelope.version).toBe('backup-artifact-stream-ndjson-v1');
    const plaintext = await decryptBackupArtifact(stored);
    expect(new TextDecoder().decode(plaintext)).toBe('fake-pg-dump');
    const events = await db.select().from(auditEvents).where(eq(auditEvents.resourceId, job!.id));
    expect(events.map((event) => event.eventType)).toContain('backup_job.started');
    expect(events.map((event) => event.eventType)).toContain('backup_job.succeeded_scaffold');
  });

  test('cancels queued job before dump without creating Backup', async () => {
    const { db, job } = await setupProcessModeFixture(new Date());

    const result = await processQueuedBackupJobScaffold(db);

    expect(result?.status).toBe('cancelled');
    expect(result?.stage).toBe('cancelled');
    const rows = await db.select().from(backups).where(eq(backups.backupJobId, job!.id));
    expect(rows).toHaveLength(0);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.resourceId, job!.id));
    expect(events.map((event) => event.eventType)).toContain('backup_job.started');
    expect(events.map((event) => event.eventType)).toContain('backup_job.cancelled');
  });

  test('cancels after dump before upload without creating Backup object', async () => {
    const { db, job } = await setupProcessModeFixture();
    await db.update(backupJobs).set({ cancelRequestedAt: new Date() }).where(eq(backupJobs.id, job!.id));

    const result = await processQueuedBackupJobScaffold(db);

    expect(result?.status).toBe('cancelled');
    const rows = await db.select().from(backups).where(eq(backups.backupJobId, job!.id));
    expect(rows).toHaveLength(0);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.resourceId, job!.id));
    expect(events.map((event) => event.eventType)).toContain('backup_job.cancelled');
  });

  test('marks job failed on sanitized dump error without creating Backup', async () => {
    const { db, job } = await setupProcessModeFixture();
    Bun.env.BACKUP_FAKE_DUMP_OUTPUT = undefined;
    Bun.env.BACKUP_FAKE_DUMP_ERROR = 'pg_dump failed password=secret postgres://user:secret@example/db';

    const result = await processQueuedBackupJobScaffold(db);

    expect(result?.status).toBe('failed');
    expect(result?.stage).toBe('failed');
    expect(result?.errorCategory).toBe('dump_failed');
    expect(result?.userErrorMessage).toContain('REDACTED');
    expect(result?.userErrorMessage).not.toContain('secret');
    const rows = await db.select().from(backups).where(eq(backups.backupJobId, job!.id));
    expect(rows).toHaveLength(0);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.resourceId, job!.id));
    expect(events.map((event) => event.eventType)).toContain('backup_job.started');
    expect(events.map((event) => event.eventType)).toContain('backup_job.failed');

    delete Bun.env.BACKUP_FAKE_DUMP_ERROR;
    Bun.env.BACKUP_FAKE_DUMP_OUTPUT = 'fake-pg-dump';
  });
});
