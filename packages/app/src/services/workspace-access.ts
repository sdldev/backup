import { and, eq } from 'drizzle-orm';
import { ApiError } from '@backup-saas/shared';
import type { Db } from '../db';
import { workspaceMembers, type workspaceRoleEnum } from '../db';

type WorkspaceRole = (typeof workspaceRoleEnum.enumValues)[number];

export async function requireWorkspaceMembership(db: Db, workspaceId: string, userId: string) {
  const [membership] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);

  if (!membership) {
    throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Workspace not found');
  }

  return membership;
}

export async function requireWorkspaceRole(db: Db, workspaceId: string, userId: string, roles: readonly WorkspaceRole[]) {
  const membership = await requireWorkspaceMembership(db, workspaceId, userId);
  if (!roles.includes(membership.role)) {
    throw new ApiError(403, 'FORBIDDEN', 'Insufficient Workspace permission');
  }

  return membership;
}
