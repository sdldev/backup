import { eq } from 'drizzle-orm';
import { ApiError } from '@backup-saas/shared';
import type { Db } from '../db';
import { backupStorageConfigs, workspaces } from '../db';
import { requireWorkspaceRole } from './workspace-access';

export async function provisionPlatformManagedStorage(db: Db, workspaceId: string, userId: string) {
  await requireWorkspaceRole(db, workspaceId, userId, ['owner', 'admin']);

  return db.transaction(async (tx) => {
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!workspace || workspace.softDeletedAt) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Workspace not found');

    const prefix = `workspace/${workspace.id}/${crypto.randomUUID()}`;

    await tx
      .update(backupStorageConfigs)
      .set({ isCurrent: false, status: 'retired', retiredAt: new Date(), updatedAt: new Date() })
      .where(eq(backupStorageConfigs.workspaceId, workspace.id));

    const [config] = await tx
      .insert(backupStorageConfigs)
      .values({
        workspaceId: workspace.id,
        provider: 'minio',
        mode: 'platform_managed',
        displayName: 'Platform-managed Backup Storage',
        storagePrefix: prefix,
        status: 'active',
        isCurrent: true,
        createdByUserId: userId,
        activatedAt: new Date(),
      })
      .returning();

    const [updatedWorkspace] = await tx
      .update(workspaces)
      .set({ storageStatus: 'ready', updatedAt: new Date() })
      .where(eq(workspaces.id, workspace.id))
      .returning();

    if (!config || !updatedWorkspace) {
      throw new ApiError(500, 'STORAGE_PROVISION_FAILED', 'Backup Storage could not be provisioned');
    }

    return { workspace: updatedWorkspace, storageConfig: config };
  });
}
