import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb, createSqlClient, type SqlClient } from '../db/client';
import { invites, plans, sessions, users, workspaceMembers, workspaces } from '../db/schema';
import { hashSessionToken } from '../services/sessions';

Bun.env.DATABASE_URL = 'postgres://backup_saas:backup_saas@localhost:5433/backup_saas';
Bun.env.APP_MASTER_KEY_V1 = Buffer.from(new Uint8Array(32).fill(31)).toString('base64url');
Bun.env.API_ENABLED = 'false';
Bun.env.WORKER_ENABLED = 'false';

describe('Invite routes', () => {
  let sql: SqlClient;
  const ids: string[] = [];

  beforeAll(() => {
    sql = createSqlClient();
  });

  afterAll(async () => {
    for (const id of ids.reverse()) {
      await sql`delete from audit_events where workspace_id = ${id} or resource_id = ${id}`;
      await sql`delete from invites where id = ${id} or workspace_id = ${id}`;
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
    const [invitee] = await db.insert(users).values({ email: `invitee-${crypto.randomUUID()}@example.com`, name: 'Invitee' }).returning();
    const [workspace] = await db.insert(workspaces).values({ name: 'Route Invite Workspace', slug: `route-invite-${crypto.randomUUID()}`, timezone: 'Asia/Jakarta', planId: plan!.id, storageStatus: 'ready' }).returning();
    const ownerToken = `owner-session-${crypto.randomUUID()}`;
    const inviteeToken = `invitee-session-${crypto.randomUUID()}`;
    const [ownerSession] = await db.insert(sessions).values({ userId: owner!.id, tokenHash: await hashSessionToken(ownerToken), expiresAt: new Date(Date.now() + 60 * 60 * 1000) }).returning();
    const [inviteeSession] = await db.insert(sessions).values({ userId: invitee!.id, tokenHash: await hashSessionToken(inviteeToken), expiresAt: new Date(Date.now() + 60 * 60 * 1000) }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: owner!.id, role: 'owner' });
    ids.push(owner!.id, invitee!.id, workspace!.id, ownerSession!.id, inviteeSession!.id);
    return { db, owner, invitee, workspace, ownerToken, inviteeToken };
  }

  test('create, preview, and accept invite through HTTP routes', async () => {
    const { db, invitee, workspace, ownerToken, inviteeToken } = await setupFixture();
    const { createApp } = await import('../index');
    const app = createApp({ db, sql });

    const createResponse = await app.handle(new Request(`http://test/v1/workspaces/${workspace!.id}/invites`, {
      method: 'POST',
      headers: { cookie: `backup_saas_session=${ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: invitee!.email, role: 'member' }),
    }));
    const createPayload = await createResponse.json() as { data: { id: string; email: string }; invite_token: string };
    ids.push(createPayload.data.id);

    expect(createResponse.status).toBe(201);
    expect(createPayload.data.email).toBe(invitee!.email);
    expect(createPayload.invite_token).toBeTruthy();

    const [row] = await db.select().from(invites).where(eq(invites.id, createPayload.data.id)).limit(1);
    expect(row!.tokenHash).not.toBe(createPayload.invite_token);

    const previewResponse = await app.handle(new Request(`http://test/v1/invites/${createPayload.invite_token}`));
    const previewPayload = await previewResponse.json() as { data: { workspace: { name: string }; role: string } };
    expect(previewResponse.status).toBe(200);
    expect(previewPayload.data.workspace.name).toBe(workspace!.name);
    expect(JSON.stringify(previewPayload)).not.toContain(row!.tokenHash);

    const acceptResponse = await app.handle(new Request(`http://test/v1/invites/${createPayload.invite_token}/accept`, {
      method: 'POST',
      headers: { cookie: `backup_saas_session=${inviteeToken}` },
    }));
    const acceptPayload = await acceptResponse.json() as { data: { workspace_id: string; workspace_slug: string; role: string } };
    expect(acceptResponse.status).toBe(200);
    expect(acceptPayload.data.workspace_id).toBe(workspace!.id);
    expect(acceptPayload.data.workspace_slug).toBe(workspace!.slug);
    expect(acceptPayload.data.role).toBe('member');

    const reusedResponse = await app.handle(new Request(`http://test/v1/invites/${createPayload.invite_token}`));
    expect(reusedResponse.status).toBe(404);
  });
});
