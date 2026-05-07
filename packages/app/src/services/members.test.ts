import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { ApiError } from '@backup-saas/shared';
import { createDb, createSqlClient, type SqlClient } from '../db/client';
import { auditEvents, plans, users, workspaceMembers, workspaces } from '../db/schema';
import { changeWorkspaceMemberRole, listWorkspaceMembers, removeWorkspaceMember, transferWorkspaceOwnership } from './members';

Bun.env.DATABASE_URL = 'postgres://backup_saas:backup_saas@localhost:5433/backup_saas';
Bun.env.APP_MASTER_KEY_V1 = Buffer.from(new Uint8Array(32).fill(37)).toString('base64url');

describe('Workspace members', () => {
  let sql: SqlClient;
  const ids: string[] = [];

  beforeAll(() => {
    sql = createSqlClient();
  });

  afterAll(async () => {
    for (const id of ids.reverse()) {
      await sql`delete from audit_events where workspace_id = ${id} or resource_id = ${id}`;
      await sql`delete from workspace_members where workspace_id = ${id} or user_id = ${id}`;
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
    const [workspace] = await db.insert(workspaces).values({ name: 'Member Workspace', slug: `member-${crypto.randomUUID()}`, timezone: 'Asia/Jakarta', planId: plan!.id, storageStatus: 'ready' }).returning();
    ids.push(owner!.id, admin!.id, member!.id, workspace!.id);
    await db.insert(workspaceMembers).values([
      { workspaceId: workspace!.id, userId: owner!.id, role: 'owner' },
      { workspaceId: workspace!.id, userId: admin!.id, role: 'admin' },
      { workspaceId: workspace!.id, userId: member!.id, role: 'member' },
    ]);
    return { db, owner: owner!, admin: admin!, member: member!, workspace: workspace! };
  }

  test('member can list members but cannot change roles', async () => {
    const { db, admin, member, workspace } = await setupFixture();

    const rows = await listWorkspaceMembers(db, workspace.id, member.id);
    await expect(changeWorkspaceMemberRole(db, workspace.id, member.id, admin.id, 'member')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' } satisfies Partial<ApiError>);

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.user?.email)).toContain(member.email);
  });

  test('owner can change member role and audit event is emitted', async () => {
    const { db, owner, member, workspace } = await setupFixture();

    const updated = await changeWorkspaceMemberRole(db, workspace.id, owner.id, member.id, 'admin');
    const events = await db.select().from(auditEvents).where(eq(auditEvents.resourceId, updated.id));

    expect(updated.role).toBe('admin');
    expect(events.map((event) => event.eventType)).toContain('member.role_changed');
  });

  test('admin cannot remove admin and owner cannot be removed', async () => {
    const { db, owner, admin, workspace } = await setupFixture();

    await expect(removeWorkspaceMember(db, workspace.id, admin.id, owner.id)).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' } satisfies Partial<ApiError>);
    await expect(removeWorkspaceMember(db, workspace.id, owner.id, owner.id)).rejects.toMatchObject({ status: 422, code: 'SOLE_OWNER_REMOVE_FORBIDDEN' } satisfies Partial<ApiError>);
  });

  test('owner can remove member and audit event is emitted', async () => {
    const { db, owner, member, workspace } = await setupFixture();

    const removed = await removeWorkspaceMember(db, workspace.id, owner.id, member.id);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.resourceId, removed.id));
    const remaining = await listWorkspaceMembers(db, workspace.id, owner.id);

    expect(remaining.map((row) => row.user_id)).not.toContain(member.id);
    expect(events.map((event) => event.eventType)).toContain('member.removed');
  });

  test('ownership transfer requires Admin target and demotes previous Owner', async () => {
    const { db, owner, admin, member, workspace } = await setupFixture();

    await expect(transferWorkspaceOwnership(db, workspace.id, owner.id, member.id)).rejects.toMatchObject({ status: 422, code: 'OWNERSHIP_TRANSFER_TARGET_NOT_ADMIN' } satisfies Partial<ApiError>);
    const newOwner = await transferWorkspaceOwnership(db, workspace.id, owner.id, admin.id);
    const rows = await listWorkspaceMembers(db, workspace.id, admin.id);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.resourceId, newOwner.id));

    expect(rows.find((row) => row.user_id === admin.id)?.role).toBe('owner');
    expect(rows.find((row) => row.user_id === owner.id)?.role).toBe('admin');
    expect(events.map((event) => event.eventType)).toContain('ownership.transferred');
  });
});
