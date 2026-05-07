import { and, eq } from 'drizzle-orm';
import { ApiError } from '@backup-saas/shared';
import type { Db } from '../db';
import { invites, users, workspaceMembers, workspaces, type workspaceRoleEnum } from '../db/schema';
import { writeAuditEvent } from './audit';
import { requireWorkspaceMembership, requireWorkspaceRole } from './workspace-access';

type WorkspaceRole = (typeof workspaceRoleEnum.enumValues)[number];
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function hashInviteToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Buffer.from(digest).toString('base64url');
}

export async function createWorkspaceInvite(db: Db, input: { workspaceId: string; actorUserId: string; email: string; role: WorkspaceRole }) {
  const actor = await requireWorkspaceRole(db, input.workspaceId, input.actorUserId, ['owner', 'admin']);
  if (actor.role === 'admin' && input.role !== 'member') throw new ApiError(403, 'FORBIDDEN', 'Admins can only invite Members');
  if (input.role === 'owner') throw new ApiError(422, 'INVITE_OWNER_NOT_ALLOWED', 'Transfer ownership instead of inviting an Owner');

  const normalizedEmail = input.email.trim().toLowerCase();
  if (!normalizedEmail.includes('@')) throw new ApiError(422, 'INVITE_EMAIL_INVALID', 'Invite email is invalid');

  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const tokenHash = await hashInviteToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const [invite] = await db.insert(invites).values({ workspaceId: input.workspaceId, email: normalizedEmail, role: input.role, tokenHash, invitedByUserId: input.actorUserId, expiresAt }).returning();
  await writeAuditEvent(db, {
    workspaceId: input.workspaceId,
    eventType: 'invite.created',
    actor: { type: 'user', userId: input.actorUserId },
    resourceType: 'invite',
    resourceId: invite!.id,
    metadata: { role: input.role, email: normalizedEmail },
  });

  return { invite: toSafeInvite(invite!), token };
}

export async function previewInvite(db: Db, token: string) {
  const invite = await getUsableInviteByToken(db, token);
  const [workspace] = await db.select({ name: workspaces.name, slug: workspaces.slug }).from(workspaces).where(eq(workspaces.id, invite.workspaceId)).limit(1);
  if (!workspace) throw new ApiError(404, 'INVITE_TOKEN_INVALID', 'Invite not found');
  return { workspace, role: invite.role, email: invite.email, expires_at: invite.expiresAt.toISOString() };
}

export async function acceptInvite(db: Db, token: string, userId: string) {
  const invite = await getUsableInviteByToken(db, token);
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'User not found');
  if (user.email.toLowerCase() !== invite.email) throw new ApiError(403, 'INVITE_EMAIL_MISMATCH', 'Invite belongs to another email');

  const now = new Date();
  const [member] = await db.insert(workspaceMembers).values({ workspaceId: invite.workspaceId, userId, role: invite.role, invitedByUserId: invite.invitedByUserId }).onConflictDoNothing().returning();
  await db.update(invites).set({ status: 'accepted', acceptedByUserId: userId, usedAt: now, updatedAt: now }).where(eq(invites.id, invite.id));
  await writeAuditEvent(db, {
    workspaceId: invite.workspaceId,
    eventType: 'invite.accepted',
    actor: { type: 'user', userId },
    resourceType: 'invite',
    resourceId: invite.id,
    metadata: { role: invite.role },
  });

  const [workspace] = await db.select({ id: workspaces.id, slug: workspaces.slug }).from(workspaces).where(eq(workspaces.id, invite.workspaceId)).limit(1);
  return { membership: member ?? (await requireWorkspaceMembership(db, invite.workspaceId, userId)), workspace: workspace! };
}

async function getUsableInviteByToken(db: Db, token: string) {
  const tokenHash = await hashInviteToken(token);
  const [invite] = await db.select().from(invites).where(and(eq(invites.tokenHash, tokenHash), eq(invites.status, 'created'))).limit(1);
  if (!invite || invite.expiresAt.getTime() <= Date.now()) throw new ApiError(404, 'INVITE_TOKEN_INVALID', 'Invite not found');
  return invite;
}

export function toSafeInvite(invite: typeof invites.$inferSelect) {
  return {
    id: invite.id,
    workspace_id: invite.workspaceId,
    email: invite.email,
    role: invite.role,
    status: invite.status,
    expires_at: invite.expiresAt.toISOString(),
    created_at: invite.createdAt.toISOString(),
  };
}
