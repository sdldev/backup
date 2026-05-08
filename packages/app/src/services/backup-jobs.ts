import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { ApiError } from '@backup-saas/shared';
import type { Db } from '../db';
import { backupJobs, databaseSources, workspaces } from '../db';
import { writeAuditEvent } from './audit';
import { getEffectivePlanLimits } from './plan-limits';
import { getRetainedStorageBytes } from './storage-usage';
import { requireWorkspaceMembership } from './workspace-access';

export async function createManualBackupJob(db: Db, workspaceId: string, sourceId: string, userId: string) {
  await requireWorkspaceMembership(db, workspaceId, userId);

  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!workspace || workspace.softDeletedAt) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Workspace not found');
  if (workspace.storageStatus !== 'ready') {
    throw new ApiError(422, 'BACKUP_STORAGE_NOT_READY', 'Backup Storage is not ready');
  }

  const [source] = await db
    .select()
    .from(databaseSources)
    .where(and(eq(databaseSources.id, sourceId), eq(databaseSources.workspaceId, workspaceId), isNull(databaseSources.softDeletedAt)))
    .limit(1);

  if (!source) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Database Source not found');
  if (source.state !== 'enabled') throw new ApiError(422, 'SOURCE_DISABLED', 'Database Source must be enabled before running Backup');

  const limits = await getEffectivePlanLimits(db, workspaceId);
  const [recentJobCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(backupJobs)
    .where(
      and(
        eq(backupJobs.databaseSourceId, source.id),
        eq(backupJobs.trigger, 'manual'),
        gte(backupJobs.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
      ),
    );

  if ((recentJobCount?.count ?? 0) >= limits.manualBackupsPerSourcePerHour) {
    throw new ApiError(
      429,
      'PLAN_MANUAL_BACKUP_RATE_LIMITED',
      'Manual Backup rate limit reached for this Database Source',
      undefined,
      3600,
    );
  }

  const retainedStorageBytes = await getRetainedStorageBytes(db, workspaceId);
  if (retainedStorageBytes >= limits.retainedStorageBytes) {
    throw new ApiError(422, 'PLAN_STORAGE_LIMIT_EXCEEDED', 'Workspace retained Backup storage limit reached');
  }

  const [activeJob] = await db
    .select({ id: backupJobs.id })
    .from(backupJobs)
    .where(and(eq(backupJobs.databaseSourceId, source.id), inArray(backupJobs.status, ['queued', 'running'])))
    .limit(1);

  if (activeJob) throw new ApiError(409, 'BACKUP_JOB_ALREADY_ACTIVE', 'Database Source already has an active Backup Job');

  const [job] = await db
    .insert(backupJobs)
    .values({
      workspaceId,
      projectId: source.projectId,
      databaseSourceId: source.id,
      trigger: 'manual',
      requestedByUserId: userId,
      status: 'queued',
      stage: 'queued',
      maxAttempts: 3,
    })
    .returning();

  if (!job) throw new ApiError(500, 'BACKUP_JOB_CREATE_FAILED', 'Backup Job could not be queued');

  await writeAuditEvent(db, {
    workspaceId,
    eventType: 'backup_job.manual_requested',
    actor: { type: 'user', userId },
    resourceType: 'backup_job',
    resourceId: job.id,
    metadata: { database_source_id: source.id },
  });

  return job;
}

export async function cancelBackupJob(db: Db, workspaceId: string, jobId: string, userId: string) {
  const job = await getBackupJob(db, workspaceId, jobId, userId);

  if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
    throw new ApiError(422, 'BACKUP_JOB_NOT_CANCELLABLE', 'Backup Job is already finished');
  }

  const now = new Date();
  const [updated] = await db
    .update(backupJobs)
    .set({
      cancelRequestedAt: now,
      cancelRequestedByUserId: userId,
      status: job.status === 'queued' ? 'cancelled' : job.status,
      stage: job.status === 'queued' ? 'failed' : job.stage,
      finishedAt: job.status === 'queued' ? now : job.finishedAt,
      updatedAt: now,
    })
    .where(and(eq(backupJobs.id, job.id), eq(backupJobs.workspaceId, workspaceId)))
    .returning();

  const result = updated ?? job;
  await writeAuditEvent(db, {
    workspaceId,
    eventType: 'backup_job.cancel_requested',
    actor: { type: 'user', userId },
    resourceType: 'backup_job',
    resourceId: result.id,
    metadata: { status: result.status },
  });
  return result;
}

export async function getBackupJob(db: Db, workspaceId: string, jobId: string, userId: string) {
  await requireWorkspaceMembership(db, workspaceId, userId);
  const [job] = await db
    .select()
    .from(backupJobs)
    .where(and(eq(backupJobs.id, jobId), eq(backupJobs.workspaceId, workspaceId)))
    .limit(1);

  if (!job) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Backup Job not found');
  return job;
}

export async function listBackupJobs(db: Db, workspaceId: string, userId: string) {
  await requireWorkspaceMembership(db, workspaceId, userId);
  return db.select().from(backupJobs).where(eq(backupJobs.workspaceId, workspaceId));
}

export function toSafeBackupJob(job: typeof backupJobs.$inferSelect) {
  return {
    id: job.id,
    workspace_id: job.workspaceId,
    project_id: job.projectId,
    database_source_id: job.databaseSourceId,
    trigger: job.trigger,
    status: job.status,
    stage: job.stage,
    attempt_count: job.attemptCount,
    max_attempts: job.maxAttempts,
    user_error_message: job.userErrorMessage,
    internal_error_ref: job.internalErrorRef,
    queued_at: job.queuedAt.toISOString(),
    started_at: job.startedAt?.toISOString() ?? null,
    finished_at: job.finishedAt?.toISOString() ?? null,
    created_at: job.createdAt.toISOString(),
    updated_at: job.updatedAt.toISOString(),
  };
}
