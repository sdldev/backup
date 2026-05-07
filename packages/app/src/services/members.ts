import { and, eq, ne, count } from 'drizzle-orm';
import { ApiError } from '@backup-saas/shared';
import type { Db } from '../db';
import { users, workspaceMembers, type workspaceRoleEnum } from '../db/schema';
import { writeAuditEvent } from './audit';
import { requireWorkspaceRole } from './workspace-access';

type WorkspaceRole = (typeof workspaceRoleEnum.enumValues)[number];

export async function listWorkspaceMembers(db: Db, workspaceId: string, actorUserId: string) {
  await requireWorkspaceRole(db, workspaceId, actorUserId, ['owner', 'admin', 'member']);
  const rows = await db
    .select({ membership: workspaceMembers, user: { id: users.id, email: users.email, name: users.name, avatarUrl: users.avatarUrl } })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  return rows.map(({ membership, user }) => toSafeWorkspaceMember(membership, user));
}

export async function changeWorkspaceMemberRole(db: Db, workspaceId: string, actorUserId: string, memberUserId: string, role: WorkspaceRole) {
  await requireWorkspaceRole(db, workspaceId, actorUserId, ['owner']);
  if (role === 'owner') throw new ApiError(422, 'OWNERSHIP_TRANSFER_REQUIRED', 'Use ownership transfer to assign Owner role');
  const [member] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, memberUserId))).limit(1);
  if (!member) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Member not found');
  if (member.role === 'owner') throw new ApiError(422, 'OWNER_ROLE_CHANGE_FORBIDDEN', 'Transfer ownership before changing Owner role');

  const now = new Date();
  const [updated] = await db.update(workspaceMembers).set({ role, updatedAt: now }).where(eq(workspaceMembers.id, member.id)).returning();
  await writeAuditEvent(db, { workspaceId, eventType: 'member.role_changed', actor: { type: 'user', userId: actorUserId }, resourceType: 'workspace_member', resourceId: updated!.id, metadata: { user_id: memberUserId, role } });
  return updated!;
}

export async function removeWorkspaceMember(db: Db, workspaceId: string, actorUserId: string, memberUserId: string) {
  await requireWorkspaceRole(db, workspaceId, actorUserId, ['owner', 'admin']);
  const [actor] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorUserId))).limit(1);
  const [member] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, memberUserId))).limit(1);
  if (!member) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Member not found');
  if (actor!.role === 'admin' && member.role !== 'member') throw new ApiError(403, 'FORBIDDEN', 'Admins can only remove Members');
  if (member.role === 'owner') throw new ApiError(422, 'SOLE_OWNER_REMOVE_FORBIDDEN', 'Transfer ownership before removing Owner');

  await db.delete(workspaceMembers).where(eq(workspaceMembers.id, member.id));
  await writeAuditEvent(db, { workspaceId, eventType: 'member.removed', actor: { type: 'user', userId: actorUserId }, resourceType: 'workspace_member', resourceId: member.id, metadata: { user_id: memberUserId, role: member.role } });
  return { id: member.id };
}

export async function transferWorkspaceOwnership(db: Db, workspaceId: string, actorUserId: string, newOwnerUserId: string) {
  await requireWorkspaceRole(db, workspaceId, actorUserId, ['owner']);
  const [target] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, newOwnerUserId))).limit(1);
  if (!target) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Member not found');
  if (target.role !== 'admin') throw new ApiError(422, 'OWNERSHIP_TRANSFER_TARGET_NOT_ADMIN', 'Ownership can only transfer to an Admin');

  const now = new Date();
  await db.update(workspaceMembers).set({ role: 'admin', updatedAt: now }).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorUserId)));
  const [newOwner] = await db.update(workspaceMembers).set({ role: 'owner', updatedAt: now }).where(eq(workspaceMembers.id, target.id)).returning();
  await writeAuditEvent(db, { workspaceId, eventType: 'ownership.transferred', actor: { type: 'user', userId: actorUserId }, resourceType: 'workspace_member', resourceId: newOwner!.id, metadata: { previous_owner_user_id: actorUserId, new_owner_user_id: newOwnerUserId } });
  return newOwner!;
}

export async function countOtherOwners(db: Db, workspaceId: string, userId: string) {
  const [row] = await db.select({ value: count() }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner'), ne(workspaceMembers.userId, userId)));
  return row?.value ?? 0;
}

export function toSafeWorkspaceMember(member: typeof workspaceMembers.$inferSelect, user?: { id: string; email: string; name: string; avatarUrl: string | null }) {
  return {
    id: member.id,
    workspace_id: member.workspaceId,
    user_id: member.userId,
    role: member.role,
    joined_at: member.joinedAt.toISOString(),
    user: user ? { id: user.id, email: user.email, name: user.name, avatar_url: user.avatarUrl } : undefined,
  };
}
