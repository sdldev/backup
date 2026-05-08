import { and, desc, eq, lt } from 'drizzle-orm';
import { ApiError } from '@backup-saas/shared';
import type { Db } from '../db';
import { backups, downloadRequests, sessions } from '../db';
import { writeAuditEvent } from './audit';
import { createObjectStorageProvider } from './object-storage';
import { requireWorkspaceMembership, requireWorkspaceRole } from './workspace-access';

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Buffer.from(digest).toString('base64url');
}

export async function getBackup(db: Db, workspaceId: string, backupId: string, userId: string) {
  await requireWorkspaceMembership(db, workspaceId, userId);
  const [backup] = await db
    .select()
    .from(backups)
    .where(and(eq(backups.id, backupId), eq(backups.workspaceId, workspaceId)))
    .limit(1);
  if (!backup) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Backup not found');
  return backup;
}

export async function createDownloadRequest(db: Db, workspaceId: string, backupId: string, userId: string, sessionId: string) {
  const backup = await getBackup(db, workspaceId, backupId, userId);
  if (backup.status !== 'succeeded') throw new ApiError(422, 'BACKUP_NOT_DOWNLOADABLE', 'Backup is not downloadable');

  const [session] = await db.select().from(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId))).limit(1);
  if (!session || session.invalidatedAt || session.expiresAt <= new Date()) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
  }

  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  const [request] = await db
    .insert(downloadRequests)
    .values({ workspaceId, backupId, requestedByUserId: userId, sessionId, tokenHash, expiresAt })
    .returning();
  if (!request) throw new ApiError(500, 'DOWNLOAD_REQUEST_CREATE_FAILED', 'Download request could not be created');

  await writeAuditEvent(db, {
    workspaceId,
    eventType: 'backup.download_requested',
    actor: { type: 'user', userId },
    resourceType: 'backup',
    resourceId: backup.id,
    metadata: {},
  });

  return { request, token, expiresAt };
}

export async function deleteBackup(db: Db, workspaceId: string, backupId: string, userId: string) {
  await requireWorkspaceRole(db, workspaceId, userId, ['owner', 'admin']);
  const backup = await getBackup(db, workspaceId, backupId, userId);
  if (backup.status !== 'succeeded') throw new ApiError(422, 'BACKUP_NOT_DELETABLE', 'Backup is not deletable');

  const storage = createObjectStorageProvider();
  try {
    await storage.deleteObject(backup.objectKey);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'OBJECT_STORAGE_NOT_IMPLEMENTED') {
      // Scaffold mode: keep metadata lifecycle working until storage provider exists.
    } else {
      throw error;
    }
  }

  const now = new Date();
  const [updated] = await db
    .update(backups)
    .set({ status: 'deleted', deletedAt: now, deletedByUserId: userId, updatedAt: now })
    .where(and(eq(backups.id, backup.id), eq(backups.workspaceId, workspaceId)))
    .returning();

  const result = updated ?? backup;
  await writeAuditEvent(db, {
    workspaceId,
    eventType: 'backup.deleted',
    actor: { type: 'user', userId },
    resourceType: 'backup',
    resourceId: result.id,
    metadata: {},
  });
  return result;
}

export async function expireDueBackups(db: Db) {
  const due = await db
    .select()
    .from(backups)
    .where(and(eq(backups.status, 'succeeded'), lt(backups.retentionExpiresAt, new Date())))
    .limit(25);

  for (const backup of due) {
    const now = new Date();
    const [updated] = await db
      .update(backups)
      .set({ status: 'expired', expiredAt: now, updatedAt: now })
      .where(and(eq(backups.id, backup.id), eq(backups.status, 'succeeded')))
      .returning();
    if (updated) {
      const storage = createObjectStorageProvider();
      try {
        await storage.deleteObject(updated.objectKey);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'OBJECT_STORAGE_NOT_IMPLEMENTED') {
          // Scaffold mode: keep metadata lifecycle working until storage provider exists.
        } else {
          throw error;
        }
      }

      await writeAuditEvent(db, {
        workspaceId: updated.workspaceId,
        eventType: 'backup.expired_scaffold',
        actor: { type: 'system' },
        resourceType: 'backup',
        resourceId: updated.id,
        metadata: {},
      });
    }
  }

  return due.length;
}

export async function listBackups(db: Db, workspaceId: string, userId: string) {
  await requireWorkspaceMembership(db, workspaceId, userId);
  return db.select().from(backups).where(eq(backups.workspaceId, workspaceId)).orderBy(desc(backups.createdAt)).limit(50);
}

export function toSafeBackup(backup: typeof backups.$inferSelect) {
  return {
    id: backup.id,
    workspace_id: backup.workspaceId,
    project_id: backup.projectId,
    database_source_id: backup.databaseSourceId,
    backup_job_id: backup.backupJobId,
    status: backup.status,
    format: backup.format,
    download_filename: backup.downloadFilename,
    encrypted_size_bytes: backup.encryptedSizeBytes,
    original_size_bytes: backup.originalSizeBytes,
    retention_expires_at: backup.retentionExpiresAt.toISOString(),
    created_at: backup.createdAt.toISOString(),
  };
}
