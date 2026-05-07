import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { ApiError } from '@backup-saas/shared';
import { createDb, createSqlClient, type SqlClient } from '../db/client';
import { backupJobs, backupStorageConfigs, backups, databaseSources, plans, projects, sessions, users, workspaceMembers, workspaces } from '../db/schema';
import { createManualBackupJob } from './backup-jobs';
import { hashSessionToken } from './sessions';

Bun.env.DATABASE_URL = 'postgres://backup_saas:backup_saas@localhost:5433/backup_saas';
Bun.env.APP_MASTER_KEY_V1 = Buffer.from(new Uint8Array(32).fill(17)).toString('base64url');
Bun.env.API_ENABLED = 'false';
Bun.env.WORKER_ENABLED = 'false';

describe('manual Backup Job preflight', () => {
  let sql: SqlClient;
  const ids: string[] = [];

  beforeAll(() => {
    sql = createSqlClient();
  });

  afterAll(async () => {
    for (const id of ids.reverse()) {
      await sql`delete from audit_events where workspace_id = ${id} or resource_id = ${id}`;
      await sql`delete from backups where id = ${id} or workspace_id = ${id}`;
      await sql`delete from backup_jobs where id = ${id} or workspace_id = ${id}`;
      await sql`delete from database_sources where id = ${id} or workspace_id = ${id}`;
      await sql`delete from projects where id = ${id} or workspace_id = ${id}`;
      await sql`delete from backup_storage_configs where id = ${id} or workspace_id = ${id}`;
      await sql`delete from workspace_members where workspace_id = ${id} or user_id = ${id}`;
      await sql`delete from workspaces where id = ${id}`;
      await sql`delete from sessions where id = ${id} or user_id = ${id}`;
      await sql`delete from users where id = ${id}`;
    }
    await sql.end();
  });

  async function setupFixture(options: { storageStatus?: 'ready' | 'provisioning'; sourceState?: 'enabled' | 'disabled' } = {}) {
    const db = createDb(sql);
    const [plan] = await db.select().from(plans).where(eq(plans.slug, 'basic')).limit(1);
    expect(plan).toBeDefined();

    const [user] = await db.insert(users).values({ email: `job-${crypto.randomUUID()}@example.com`, name: 'Job User' }).returning();
    const [workspace] = await db.insert(workspaces).values({ name: 'Job Test', slug: `job-${crypto.randomUUID()}`, timezone: 'Asia/Jakarta', planId: plan!.id, storageStatus: options.storageStatus ?? 'ready' }).returning();
    ids.push(user!.id, workspace!.id);
    await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: user!.id, role: 'owner' });

    const [project] = await db.insert(projects).values({ workspaceId: workspace!.id, name: 'Project', createdByUserId: user!.id }).returning();
    const [source] = await db.insert(databaseSources).values({ workspaceId: workspace!.id, projectId: project!.id, engine: 'mysql', displayName: 'Source', technicalDatabaseName: 'db', host: 'localhost', port: 3306, username: 'user', state: options.sourceState ?? 'enabled', health: 'healthy', lastConnectionTestStatus: 'succeeded', createdByUserId: user!.id }).returning();
    const [storageConfig] = await db.insert(backupStorageConfigs).values({ workspaceId: workspace!.id, provider: 'local_disk', mode: 'platform_managed', displayName: 'Local', storagePrefix: 'test', status: 'active', isCurrent: true, createdByUserId: user!.id }).returning();
    ids.push(project!.id, source!.id, storageConfig!.id);

    return { db, plan: plan!, user: user!, workspace: workspace!, project: project!, source: source!, storageConfig: storageConfig! };
  }

  test('storage not ready blocks manual Backup Job', async () => {
    const { db, user, workspace, source } = await setupFixture({ storageStatus: 'provisioning' });

    await expect(createManualBackupJob(db, workspace.id, source.id, user.id)).rejects.toMatchObject({ status: 422, code: 'BACKUP_STORAGE_NOT_READY' });
  });

  test('disabled Source blocks manual Backup Job', async () => {
    const { db, user, workspace, source } = await setupFixture({ sourceState: 'disabled' });

    await expect(createManualBackupJob(db, workspace.id, source.id, user.id)).rejects.toMatchObject({ status: 422, code: 'SOURCE_DISABLED' });
  });

  test('manual rate limit returns 429 with Retry-After seconds', async () => {
    const { db, user, workspace, project, source } = await setupFixture();
    const [job] = await db.insert(backupJobs).values({ workspaceId: workspace.id, projectId: project.id, databaseSourceId: source.id, trigger: 'manual', requestedByUserId: user.id, status: 'succeeded', stage: 'succeeded' }).returning();
    ids.push(job!.id);

    try {
      await createManualBackupJob(db, workspace.id, source.id, user.id);
      throw new Error('expected rate limit');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(429);
      expect((error as ApiError).code).toBe('PLAN_MANUAL_BACKUP_RATE_LIMITED');
      expect((error as ApiError).retryAfterSeconds).toBe(3600);
    }
  });

  test('active Backup Job conflict returns 409', async () => {
    const { db, user, workspace, project, source } = await setupFixture();
    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const [job] = await db.insert(backupJobs).values({ workspaceId: workspace.id, projectId: project.id, databaseSourceId: source.id, trigger: 'manual', requestedByUserId: user.id, status: 'queued', stage: 'queued', createdAt: oldDate }).returning();
    ids.push(job!.id);

    await expect(createManualBackupJob(db, workspace.id, source.id, user.id)).rejects.toMatchObject({ status: 409, code: 'BACKUP_JOB_ALREADY_ACTIVE' });
  });

  test('retained storage at plan limit blocks manual Backup Job', async () => {
    const { db, plan, user, workspace, project, source, storageConfig } = await setupFixture();
    const [job] = await db.insert(backupJobs).values({ workspaceId: workspace.id, projectId: project.id, databaseSourceId: source.id, trigger: 'scheduled', requestedByUserId: user.id, status: 'succeeded', stage: 'succeeded' }).returning();
    const [backup] = await db.insert(backups).values({ workspaceId: workspace.id, projectId: project.id, databaseSourceId: source.id, backupJobId: job!.id, storageConfigId: storageConfig.id, format: 'mysql_sql_gzip', objectKey: `tests/${crypto.randomUUID()}.enc`, downloadFilename: 'backup.sql.gz', encryptedSizeBytes: plan.retainedStorageBytes, originalSizeBytes: 1, retentionExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }).returning();
    ids.push(job!.id, backup!.id);

    await expect(createManualBackupJob(db, workspace.id, source.id, user.id)).rejects.toMatchObject({ status: 422, code: 'PLAN_STORAGE_LIMIT_EXCEEDED' });
  });

  test('route returns 429 for manual Backup rate limit', async () => {
    const { db, user, workspace, project, source } = await setupFixture();
    const sessionToken = `backup-job-session-${crypto.randomUUID()}`;
    const [session] = await db.insert(sessions).values({ userId: user.id, tokenHash: await hashSessionToken(sessionToken), expiresAt: new Date(Date.now() + 60 * 60 * 1000) }).returning();
    const [job] = await db.insert(backupJobs).values({ workspaceId: workspace.id, projectId: project.id, databaseSourceId: source.id, trigger: 'manual', requestedByUserId: user.id, status: 'succeeded', stage: 'succeeded' }).returning();
    ids.push(session!.id, job!.id);

    const { createApp } = await import('../index');
    const app = createApp({ db, sql });

    const response = await app.handle(new Request(`http://test/v1/workspaces/${workspace.id}/database-sources/${source.id}/backup-jobs`, { method: 'POST', headers: { cookie: `backup_saas_session=${sessionToken}` } }));
    const text = await response.text();

    expect(response.status).toBe(429);
    expect(text).toContain('Manual Backup rate limit reached');
  });
});
