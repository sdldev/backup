import { and, asc, eq, isNull } from 'drizzle-orm';
import { ApiError } from '@backup-saas/shared';
import type { Db } from '../db';
import { projects } from '../db';
import { writeAuditEvent } from './audit';
import { requireWorkspaceMembership, requireWorkspaceRole } from './workspace-access';

type CreateProjectInput = {
  workspaceId: string;
  userId: string;
  name: string;
  websiteUrl?: string | undefined;
};

export async function listProjects(db: Db, workspaceId: string, userId: string) {
  await requireWorkspaceMembership(db, workspaceId, userId);

  return db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.softDeletedAt)))
    .orderBy(asc(projects.name));
}

export async function createProject(db: Db, input: CreateProjectInput) {
  await requireWorkspaceRole(db, input.workspaceId, input.userId, ['owner', 'admin']);

  try {
    const [project] = await db
      .insert(projects)
      .values({
        workspaceId: input.workspaceId,
        name: input.name.trim(),
        websiteUrl: input.websiteUrl?.trim() || null,
        createdByUserId: input.userId,
      })
      .returning();

    if (!project) {
      throw new ApiError(500, 'PROJECT_CREATE_FAILED', 'Project could not be created');
    }

    await writeAuditEvent(db, {
      workspaceId: input.workspaceId,
      eventType: 'project.created',
      actor: { type: 'user', userId: input.userId },
      resourceType: 'project',
      resourceId: project.id,
      metadata: { name: project.name },
    });

    return project;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.message.includes('projects_active_name_per_workspace_uidx')) {
      throw new ApiError(409, 'PROJECT_NAME_TAKEN', 'Project name is already used in this Workspace');
    }
    throw error;
  }
}
