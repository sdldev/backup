import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { ApiError } from '@backup-saas/shared';
import type { Db } from '../db';
import { databaseSources, plans, workspaceLimitOverrides, workspaces } from '../db';

export type EffectivePlanLimits = {
  databaseSourceLimit: number;
  retainedStorageBytes: number;
  maxRetentionDays: number;
  scheduledBackupsPerDay: number;
  memberLimit: number;
  manualBackupsPerSourcePerHour: number;
};

export async function getEffectivePlanLimits(db: Db, workspaceId: string): Promise<EffectivePlanLimits> {
  const [workspacePlan] = await db
    .select({ plan: plans })
    .from(workspaces)
    .innerJoin(plans, eq(workspaces.planId, plans.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (!workspacePlan) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Workspace not found');

  const [override] = await db
    .select()
    .from(workspaceLimitOverrides)
    .where(
      and(
        eq(workspaceLimitOverrides.workspaceId, workspaceId),
        or(isNull(workspaceLimitOverrides.expiresAt), gt(workspaceLimitOverrides.expiresAt, new Date())),
      ),
    )
    .limit(1);

  return {
    databaseSourceLimit: override?.databaseSourceLimit ?? workspacePlan.plan.databaseSourceLimit,
    retainedStorageBytes: override?.retainedStorageBytes ?? workspacePlan.plan.retainedStorageBytes,
    maxRetentionDays: override?.maxRetentionDays ?? workspacePlan.plan.maxRetentionDays,
    scheduledBackupsPerDay: override?.scheduledBackupsPerDay ?? workspacePlan.plan.scheduledBackupsPerDay,
    memberLimit: override?.memberLimit ?? workspacePlan.plan.memberLimit,
    manualBackupsPerSourcePerHour:
      override?.manualBackupsPerSourcePerHour ?? workspacePlan.plan.manualBackupsPerSourcePerHour,
  };
}

export async function assertCanCreateDatabaseSource(db: Db, workspaceId: string, retentionDays: number) {
  const limits = await getEffectivePlanLimits(db, workspaceId);

  if (retentionDays > limits.maxRetentionDays) {
    throw new ApiError(422, 'PLAN_RETENTION_LIMIT_EXCEEDED', `Retention Period cannot exceed ${limits.maxRetentionDays} days`);
  }

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(databaseSources)
    .where(and(eq(databaseSources.workspaceId, workspaceId), isNull(databaseSources.softDeletedAt)));

  const currentCount = countRow?.count ?? 0;
  if (currentCount >= limits.databaseSourceLimit) {
    throw new ApiError(422, 'PLAN_SOURCE_LIMIT_EXCEEDED', 'Workspace Database Source limit reached');
  }

  return limits;
}
