import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb, createSqlClient, type SqlClient } from '../db/client';
import { plans, sessions, users, workspaceMembers, workspaces } from '../db/schema';
import { hashSessionToken } from '../services/sessions';

Bun.env.DATABASE_URL = 'postgres://backup_saas:backup_saas@localhost:5433/backup_saas';
Bun.env.APP_MASTER_KEY_V1 = Buffer.from(new Uint8Array(32).fill(41)).toString('base64url');
Bun.env.API_ENABLED = 'false';
Bun.env.WORKER_ENABLED = 'false';

describe('Member routes', () => {
  let sql: SqlClient;
  const ids: string[] = [];

  beforeAll(() => {
    sql = createSqlClient();
  });

  afterAll(async () => {
    for (const id of ids.reverse()) {
      await sql`delete from audit_events where workspace_id = ${id} or resource_id = ${id}`;
      await sql`delete from workspace_members where workspace_id = ${id} or user_id = ${id}`;
      await sql`delete from sessions where id = ${id} or user_id = ${id}`;
      await sql`delete from workspaces where id = ${id}`;
      await sql`delete from users where id = ${id}`;
    }
    await sql.end();
  });

  async function setupFixture() {
    const db = createDb(sql);
    const [plan] = await db.select().from(plans).where(eq(plans.slug, 'basic')).limit(1);
    const [owner] = await db.insert(users).values({ email: `owner-${crypto.randomUUID()}@example.com`, name: 'Owner' }).returning();
    const [admin] = await db.insert(users).values({ email: `admin-${crypto.randomUUID()}@example.com`, name: 'Admin' }).returning();
    const [member] = await db.insert(users).values({ email: `member-${crypto.randomUUID()}@example.com`, name: 'Member' }).returning();
    const [workspace] = await db.insert(workspaces).values({ name: 'Member Route Workspace', slug: `member-route-${crypto.randomUUID()}`, timezone: 'Asia/Jakarta', planId: plan!.id, storageStatus: 'ready' }).returning();
    const ownerToken = `owner-session-${crypto.randomUUID()}`;
    const adminToken = `admin-session-${crypto.randomUUID()}`;
    await db.insert(sessions).values([
      { userId: owner!.id, tokenHash: await hashSessionToken(ownerToken), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
      { userId: admin!.id, tokenHash: await hashSessionToken(adminToken), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    ]).returning().then((rows) => ids.push(...rows.map((row) => row.id)));
    await db.insert(workspaceMembers).values([
      { workspaceId: workspace!.id, userId: owner!.id, role: 'owner' },
      { workspaceId: workspace!.id, userId: admin!.id, role: 'admin' },
      { workspaceId: workspace!.id, userId: member!.id, role: 'member' },
    ]);
    ids.push(owner!.id, admin!.id, member!.id, workspace!.id);
    return { db, owner, admin, member, workspace, ownerToken, adminToken };
  }

  test('lists, changes role, removes member, and transfers ownership through HTTP routes', async () => {
    const { owner, admin, member, workspace, ownerToken, adminToken } = await setupFixture();
    const { createApp } = await import('../index');
    const app = createApp({ db: createDb(sql), sql });

    const listResponse = await app.handle(new Request(`http://test/v1/workspaces/${workspace!.id}/members`, { headers: { cookie: `backup_saas_session=${ownerToken}` } }));
    const listPayload = await listResponse.json() as { data: Array<{ user_id: string; role: string }> };
    expect(listResponse.status).toBe(200);
    expect(listPayload.data).toHaveLength(3);

    const roleResponse = await app.handle(new Request(`http://test/v1/workspaces/${workspace!.id}/members/${member!.id}/role`, {
      method: 'PATCH',
      headers: { cookie: `backup_saas_session=${ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    }));
    const rolePayload = await roleResponse.json() as { data: { role: string } };
    expect(roleResponse.status).toBe(200);
    expect(rolePayload.data.role).toBe('admin');

    const transferResponse = await app.handle(new Request(`http://test/v1/workspaces/${workspace!.id}/members/ownership-transfer`, {
      method: 'POST',
      headers: { cookie: `backup_saas_session=${ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ new_owner_user_id: admin!.id }),
    }));
    const transferPayload = await transferResponse.json() as { data: { user_id: string; role: string } };
    expect(transferResponse.status).toBe(200);
    expect(transferPayload.data.user_id).toBe(admin!.id);
    expect(transferPayload.data.role).toBe('owner');

    const removeResponse = await app.handle(new Request(`http://test/v1/workspaces/${workspace!.id}/members/${member!.id}`, {
      method: 'DELETE',
      headers: { cookie: `backup_saas_session=${adminToken}` },
    }));
    expect(removeResponse.status).toBe(204);
  });
});
