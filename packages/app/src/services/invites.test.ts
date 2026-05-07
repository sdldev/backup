import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { ApiError } from '@backup-saas/shared';
import { createDb, createSqlClient, type SqlClient } from '../db/client';
import { auditEvents, invites, plans, users, workspaceMembers, workspaces } from '../db/schema';
import { acceptInvite, createWorkspaceInvite, hashInviteToken, previewInvite } from './invites';

Bun.env.DATABASE_URL = 'postgres://backup_saas:backup_saas@localhost:5433/backup_saas';
Bun.env.APP_MASTER_KEY_V1 = Buffer.from(new Uint8Array(32).fill(29)).toString('base64url');

describe('Workspace invites', () => {
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
      await sql`delete from workspaces where id = ${id}`;
      await sql`delete from users where id = ${id}`;
    }
    await sql.end();
  });

  async function setupFixture(actorRole: 'owner' | 'admin' | 'member' = 'owner', inviteeEmail = `invitee-${crypto.randomUUID()}@example.com`) {
    const db = createDb(sql);
    const [plan] = await db.select().from(plans).where(eq(plans.slug, 'basic')).limit(1);
    const [actor] = await db.insert(users).values({ email: `actor-${crypto.randomUUID()}@example.com`, name: 'Invite Actor' }).returning();
    const [invitee] = await db.insert(users).values({ email: inviteeEmail, name: 'Invitee' }).returning();
    const [workspace] = await db.insert(workspaces).values({ name: 'Invite Workspace', slug: `invite-${crypto.randomUUID()}`, timezone: 'Asia/Jakarta', planId: plan!.id, storageStatus: 'ready' }).returning();
    ids.push(actor!.id, invitee!.id, workspace!.id);
    await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: actor!.id, role: actorRole });
    return { db, actor: actor!, invitee: invitee!, workspace: workspace! };
  }

  test('creates invite with token hash only and limited preview', async () => {
    const { db, actor, workspace } = await setupFixture();

    const result = await createWorkspaceInvite(db, { workspaceId: workspace.id, actorUserId: actor.id, email: 'NewUser@Example.com', role: 'member' });
    ids.push(result.invite.id);
    const [row] = await db.select().from(invites).where(eq(invites.id, result.invite.id)).limit(1);
    const preview = await previewInvite(db, result.token);

    expect(row!.tokenHash).toBe(await hashInviteToken(result.token));
    expect(row!.tokenHash).not.toBe(result.token);
    expect(JSON.stringify(row)).not.toContain(result.token);
    expect(preview.workspace.name).toBe(workspace.name);
    expect(preview.role).toBe('member');
    expect(JSON.stringify(preview)).not.toContain('token_hash');
    expect(JSON.stringify(preview)).not.toContain(result.token);
  });

  test('accept creates membership and makes token single-use', async () => {
    const { db, actor, invitee, workspace } = await setupFixture('owner', `invitee-${crypto.randomUUID()}@example.com`);
    const result = await createWorkspaceInvite(db, { workspaceId: workspace.id, actorUserId: actor.id, email: invitee.email, role: 'member' });
    ids.push(result.invite.id);

    const accepted = await acceptInvite(db, result.token, invitee.id);
    await expect(acceptInvite(db, result.token, invitee.id)).rejects.toMatchObject({ status: 404, code: 'INVITE_TOKEN_INVALID' } satisfies Partial<ApiError>);

    expect(accepted.membership.workspaceId).toBe(workspace.id);
    expect(accepted.membership.role).toBe('member');
    const [row] = await db.select().from(invites).where(eq(invites.id, result.invite.id)).limit(1);
    expect(row!.status).toBe('accepted');
    expect(row!.usedAt).toBeInstanceOf(Date);
  });

  test('expired token returns 404', async () => {
    const { db, actor, workspace } = await setupFixture();
    const result = await createWorkspaceInvite(db, { workspaceId: workspace.id, actorUserId: actor.id, email: `expired-${crypto.randomUUID()}@example.com`, role: 'member' });
    ids.push(result.invite.id);
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, result.invite.id));

    await expect(previewInvite(db, result.token)).rejects.toMatchObject({ status: 404, code: 'INVITE_TOKEN_INVALID' } satisfies Partial<ApiError>);
  });

  test('admin cannot invite admin and member cannot invite', async () => {
    const adminFixture = await setupFixture('admin');
    await expect(createWorkspaceInvite(adminFixture.db, { workspaceId: adminFixture.workspace.id, actorUserId: adminFixture.actor.id, email: `admin-${crypto.randomUUID()}@example.com`, role: 'admin' })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' } satisfies Partial<ApiError>);

    const memberFixture = await setupFixture('member');
    await expect(createWorkspaceInvite(memberFixture.db, { workspaceId: memberFixture.workspace.id, actorUserId: memberFixture.actor.id, email: `member-${crypto.randomUUID()}@example.com`, role: 'member' })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' } satisfies Partial<ApiError>);
  });

  test('email mismatch is forbidden and audit events do not leak token', async () => {
    const { db, actor, invitee, workspace } = await setupFixture('owner', `right-${crypto.randomUUID()}@example.com`);
    const [wrongUser] = await db.insert(users).values({ email: `wrong-${crypto.randomUUID()}@example.com`, name: 'Wrong User' }).returning();
    ids.push(wrongUser!.id);
    const result = await createWorkspaceInvite(db, { workspaceId: workspace.id, actorUserId: actor.id, email: invitee.email, role: 'member' });
    ids.push(result.invite.id);

    await expect(acceptInvite(db, result.token, wrongUser!.id)).rejects.toMatchObject({ status: 403, code: 'INVITE_EMAIL_MISMATCH' } satisfies Partial<ApiError>);
    await acceptInvite(db, result.token, invitee.id);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.resourceId, result.invite.id));

    expect(events.map((event) => event.eventType)).toContain('invite.created');
    expect(events.map((event) => event.eventType)).toContain('invite.accepted');
    expect(JSON.stringify(events)).not.toContain(result.token);
    expect(JSON.stringify(events)).not.toContain(await hashInviteToken(result.token));
  });
});
