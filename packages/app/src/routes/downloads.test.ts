import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { eq } from 'drizzle-orm';
import { ApiError, toApiErrorResponse } from '@backup-saas/shared';
import { createDb, createSqlClient, type SqlClient } from '../db/client';
import { backupJobs, backupStorageConfigs, backups, databaseSources, downloadRequests, plans, projects, sessions, users, workspaceMembers, workspaces } from '../db/schema';
import { encryptBackupArtifact } from '../services/backup-artifact-crypto';
import { hashSessionToken } from '../services/sessions';
import { backupRoutes } from './backups';
import { downloadRoutes } from './downloads';

Bun.env.DATABASE_URL = 'postgres://backup_saas:backup_saas@localhost:5433/backup_saas';
Bun.env.APP_MASTER_KEY_V1 = Buffer.from(new Uint8Array(32).fill(13)).toString('base64url');
Bun.env.OBJECT_STORAGE_PROVIDER = 'local';
Bun.env.OBJECT_STORAGE_LOCAL_DIR = '.storage/test-downloads';

describe('download token security', () => {
  let sql: SqlClient;
  const ids: string[] = [];

  beforeAll(() => {
    sql = createSqlClient();
  });

  afterAll(async () => {
    for (const id of ids.reverse()) {
      await sql`delete from audit_events where workspace_id = ${id} or resource_id = ${id}`;
      await sql`delete from download_requests where workspace_id = ${id} or backup_id = ${id}`;
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

  async function setupFixture() {
    const db = createDb(sql);
    const app = new Elysia()
      .use(backupRoutes({ db }))
      .use(downloadRoutes({ db }))
      .onError(({ error, status }) => {
        if (error instanceof ApiError) return status(error.status, toApiErrorResponse(error));
        throw error;
      });

    const [plan] = await db.select().from(plans).where(eq(plans.slug, 'basic')).limit(1);
    expect(plan).toBeDefined();

    const [user] = await db.insert(users).values({ email: `download-${crypto.randomUUID()}@example.com`, name: 'Download User' }).returning();
    const [otherUser] = await db.insert(users).values({ email: `download-other-${crypto.randomUUID()}@example.com`, name: 'Other User' }).returning();
    const [workspace] = await db.insert(workspaces).values({ name: 'Download Test', slug: `download-${crypto.randomUUID()}`, timezone: 'Asia/Jakarta', planId: plan!.id, storageStatus: 'ready' }).returning();
    ids.push(user!.id, otherUser!.id, workspace!.id);

    await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: user!.id, role: 'owner' });
    await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: otherUser!.id, role: 'member' });

    const sessionToken = `download-session-${crypto.randomUUID()}`;
    const otherSessionToken = `other-download-session-${crypto.randomUUID()}`;
    const [session] = await db.insert(sessions).values({ userId: user!.id, tokenHash: await hashSessionToken(sessionToken), expiresAt: new Date(Date.now() + 60 * 60 * 1000) }).returning();
    const [otherSession] = await db.insert(sessions).values({ userId: otherUser!.id, tokenHash: await hashSessionToken(otherSessionToken), expiresAt: new Date(Date.now() + 60 * 60 * 1000) }).returning();
    ids.push(session!.id, otherSession!.id);

    const [project] = await db.insert(projects).values({ workspaceId: workspace!.id, name: 'Project', createdByUserId: user!.id }).returning();
    const [source] = await db.insert(databaseSources).values({ workspaceId: workspace!.id, projectId: project!.id, engine: 'mysql', displayName: 'Source', technicalDatabaseName: 'db', host: 'localhost', port: 3306, username: 'user', createdByUserId: user!.id }).returning();
    const [job] = await db.insert(backupJobs).values({ workspaceId: workspace!.id, projectId: project!.id, databaseSourceId: source!.id, trigger: 'manual', requestedByUserId: user!.id, status: 'succeeded', stage: 'succeeded' }).returning();
    const [storageConfig] = await db.insert(backupStorageConfigs).values({ workspaceId: workspace!.id, provider: 'local_disk', mode: 'platform_managed', displayName: 'Local', storagePrefix: 'test', status: 'active', isCurrent: true, createdByUserId: user!.id }).returning();
    ids.push(project!.id, source!.id, job!.id, storageConfig!.id);

    const objectKey = `tests/${crypto.randomUUID()}.enc`;
    const encrypted = await encryptBackupArtifact(new TextEncoder().encode('download plaintext'));
    await Bun.write(`${Bun.env.OBJECT_STORAGE_LOCAL_DIR}/${objectKey}`, encrypted);

    const [backup] = await db.insert(backups).values({ workspaceId: workspace!.id, projectId: project!.id, databaseSourceId: source!.id, backupJobId: job!.id, storageConfigId: storageConfig!.id, format: 'mysql_sql_gzip', objectKey, downloadFilename: 'backup.sql.gz', encryptedSizeBytes: encrypted.byteLength, originalSizeBytes: 18, retentionExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }).returning();
    ids.push(backup!.id);

    const [otherWorkspace] = await db.insert(workspaces).values({ name: 'Other Download Test', slug: `download-other-${crypto.randomUUID()}`, timezone: 'Asia/Jakarta', planId: plan!.id, storageStatus: 'ready' }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: otherWorkspace!.id, userId: user!.id, role: 'owner' });
    ids.push(otherWorkspace!.id);

    const [nonMember] = await db.insert(users).values({ email: `download-nonmember-${crypto.randomUUID()}@example.com`, name: 'Non Member' }).returning();
    const nonMemberToken = `nonmember-download-session-${crypto.randomUUID()}`;
    const [nonMemberSession] = await db.insert(sessions).values({ userId: nonMember!.id, tokenHash: await hashSessionToken(nonMemberToken), expiresAt: new Date(Date.now() + 60 * 60 * 1000) }).returning();
    ids.push(nonMember!.id, nonMemberSession!.id);

    return { app, db, workspace: workspace!, otherWorkspace: otherWorkspace!, backup: backup!, session: session!, otherSession: otherSession!, sessionToken, otherSessionToken, nonMemberToken };
  }

  test('download token is single-use', async () => {
    const { app, workspace, backup, sessionToken } = await setupFixture();
    const createResponse = await app.handle(new Request(`http://test/v1/workspaces/${workspace.id}/backups/${backup.id}/download-requests`, { method: 'POST', headers: { cookie: `backup_saas_session=${sessionToken}` } }));
    const created = await createResponse.json() as { data: { download_url: string } };

    const first = await app.handle(new Request(`http://test${created.data.download_url}`, { headers: { cookie: `backup_saas_session=${sessionToken}` } }));
    const second = await app.handle(new Request(`http://test${created.data.download_url}`, { headers: { cookie: `backup_saas_session=${sessionToken}` } }));

    expect(first.status).toBe(200);
    expect(await first.text()).toBe('download plaintext');
    expect(second.status).toBe(404);
  });

  test('download token is bound to creating session', async () => {
    const { app, workspace, backup, sessionToken, otherSessionToken } = await setupFixture();
    const createResponse = await app.handle(new Request(`http://test/v1/workspaces/${workspace.id}/backups/${backup.id}/download-requests`, { method: 'POST', headers: { cookie: `backup_saas_session=${sessionToken}` } }));
    const created = await createResponse.json() as { data: { download_url: string } };

    const wrongSession = await app.handle(new Request(`http://test${created.data.download_url}`, { headers: { cookie: `backup_saas_session=${otherSessionToken}` } }));

    expect(wrongSession.status).toBe(404);
  });

  test('expired download token returns 404', async () => {
    const { app, db, workspace, backup, sessionToken } = await setupFixture();
    const createResponse = await app.handle(new Request(`http://test/v1/workspaces/${workspace.id}/backups/${backup.id}/download-requests`, { method: 'POST', headers: { cookie: `backup_saas_session=${sessionToken}` } }));
    const created = await createResponse.json() as { data: { download_url: string } };
    await db.update(downloadRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(downloadRequests.backupId, backup.id));

    const expired = await app.handle(new Request(`http://test${created.data.download_url}`, { headers: { cookie: `backup_saas_session=${sessionToken}` } }));

    expect(expired.status).toBe(404);
  });

  test('Backup responses do not leak object key or checksum', async () => {
    const { app, workspace, backup, sessionToken } = await setupFixture();

    const listResponse = await app.handle(new Request(`http://test/v1/workspaces/${workspace.id}/backups`, { headers: { cookie: `backup_saas_session=${sessionToken}` } }));
    const detailResponse = await app.handle(new Request(`http://test/v1/workspaces/${workspace.id}/backups/${backup.id}`, { headers: { cookie: `backup_saas_session=${sessionToken}` } }));
    const listText = await listResponse.text();
    const detailText = await detailResponse.text();

    expect(listResponse.status).toBe(200);
    expect(detailResponse.status).toBe(200);
    expect(listText).not.toContain('object_key');
    expect(listText).not.toContain('checksum');
    expect(listText).not.toContain(backup.objectKey);
    expect(detailText).not.toContain('object_key');
    expect(detailText).not.toContain('checksum');
    expect(detailText).not.toContain(backup.objectKey);
  });

  test('download request response does not leak token hash or object key', async () => {
    const { app, workspace, backup, sessionToken } = await setupFixture();

    const response = await app.handle(new Request(`http://test/v1/workspaces/${workspace.id}/backups/${backup.id}/download-requests`, { method: 'POST', headers: { cookie: `backup_saas_session=${sessionToken}` } }));
    const text = await response.text();

    expect(response.status).toBe(201);
    expect(text).toContain('/v1/downloads/');
    expect(text).not.toContain('token_hash');
    expect(text).not.toContain('object_key');
    expect(text).not.toContain(backup.objectKey);
  });

  test('invalid download token response does not leak lookup details', async () => {
    const { app, sessionToken } = await setupFixture();

    const response = await app.handle(new Request('http://test/v1/downloads/not-a-real-token', { headers: { cookie: `backup_saas_session=${sessionToken}` } }));
    const text = await response.text();

    expect(response.status).toBe(404);
    expect(text).toContain('DOWNLOAD_TOKEN_INVALID');
    expect(text).not.toContain('token_hash');
    expect(text).not.toContain('object_key');
    expect(text).not.toContain('backup_id');
  });

  test('member cannot delete Backup', async () => {
    const { app, workspace, backup, otherSessionToken } = await setupFixture();

    const response = await app.handle(new Request(`http://test/v1/workspaces/${workspace.id}/backups/${backup.id}`, { method: 'DELETE', headers: { cookie: `backup_saas_session=${otherSessionToken}` } }));

    expect(response.status).toBe(403);
  });

  test('cross-Workspace Backup detail returns 404', async () => {
    const { app, otherWorkspace, backup, sessionToken } = await setupFixture();

    const response = await app.handle(new Request(`http://test/v1/workspaces/${otherWorkspace.id}/backups/${backup.id}`, { headers: { cookie: `backup_saas_session=${sessionToken}` } }));

    expect(response.status).toBe(404);
  });

  test('non-member cannot list Backups', async () => {
    const { app, workspace, nonMemberToken } = await setupFixture();

    const response = await app.handle(new Request(`http://test/v1/workspaces/${workspace.id}/backups`, { headers: { cookie: `backup_saas_session=${nonMemberToken}` } }));

    expect(response.status).toBe(404);
  });

  test('non-member cannot get Backup detail', async () => {
    const { app, workspace, backup, nonMemberToken } = await setupFixture();

    const response = await app.handle(new Request(`http://test/v1/workspaces/${workspace.id}/backups/${backup.id}`, { headers: { cookie: `backup_saas_session=${nonMemberToken}` } }));

    expect(response.status).toBe(404);
  });

  test('non-member cannot create download request', async () => {
    const { app, workspace, backup, nonMemberToken } = await setupFixture();

    const response = await app.handle(new Request(`http://test/v1/workspaces/${workspace.id}/backups/${backup.id}/download-requests`, { method: 'POST', headers: { cookie: `backup_saas_session=${nonMemberToken}` } }));

    expect(response.status).toBe(404);
  });
});
