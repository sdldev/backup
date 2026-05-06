import type { AuditActorType, AuditResult } from "@mba/shared";
import type { Sql, TransactionSql } from "postgres";

type RetentionSqlClient = Sql | TransactionSql;

export type BackupDeletionReason = "manual" | "retention";
export type BackupDeletionFinalStatus = "deleted" | "expired";

export type BackupDeletionActor = {
  actorType: AuditActorType;
  actorUserId: string | null;
  effectiveActorUserId: string | null;
  systemAdminId?: string | null;
  impersonationSessionId?: string | null;
  requestId?: string | null;
  sessionId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  impersonationReason?: string | null;
};

export type RetentionCandidate = {
  backupId: string;
  workspaceId: string;
  objectKey: string;
  retentionExpiresAt: Date;
  hasActiveLock: boolean;
};

export type BackupDeletionTarget = {
  backupId: string;
  workspaceId: string;
  objectKey: string;
  status: string;
  hasActiveLock: boolean;
};

export type BackupDeletionPreparation =
  | { ok: true; target: BackupDeletionTarget }
  | { ok: false; code: "backup.not_found" | "backup.locked" | "backup.not_active" };

export type BackupDeletionSuccess = {
  ok: true;
  backupId: string;
  workspaceId: string;
  finalStatus: BackupDeletionFinalStatus;
  retainedStorageBytes: bigint;
};

export type BackupDeletionFailure = {
  ok: false;
  code: "backup.not_found" | "backup.delete_conflict";
};

export type BackupDeletionRetryFailure = {
  ok: true;
  backupId: string;
  workspaceId: string;
  retainedStorageBytes: bigint;
  deleteRetryAfter: Date;
  deleteError: string;
};

type RetentionCandidateRow = {
  backupId: string;
  workspaceId: string;
  objectKey: string;
  retentionExpiresAt: Date;
  activeLockCount: string;
};

type DeletionTargetRow = {
  backupId: string;
  workspaceId: string;
  objectKey: string;
  status: string;
  activeLockCount: string;
};

type RetainedBytesRow = { retained_bytes: string };

export async function listRetentionCandidates(client: RetentionSqlClient, now: Date): Promise<RetentionCandidate[]> {
  const rows = await client<RetentionCandidateRow[]>`
    select backups.id as "backupId",
      backups.workspace_id as "workspaceId",
      backups.object_key as "objectKey",
      backups.retention_expires_at as "retentionExpiresAt",
      (
        select count(*)::text
        from backup_download_locks
        where backup_download_locks.backup_id = backups.id
          and backup_download_locks.workspace_id = backups.workspace_id
          and backup_download_locks.expires_at > ${now}
      ) as "activeLockCount"
    from backups
    where backups.status = 'succeeded'
      and backups.retention_expires_at <= ${now}
    order by backups.retention_expires_at asc, backups.id asc
  `;

  return rows.map((row) => ({
    backupId: row.backupId,
    workspaceId: row.workspaceId,
    objectKey: row.objectKey,
    retentionExpiresAt: row.retentionExpiresAt,
    hasActiveLock: Number(row.activeLockCount) > 0
  }));
}

export async function prepareBackupDeletion(
  client: RetentionSqlClient,
  params: { workspaceId: string; backupId: string; now: Date }
): Promise<BackupDeletionPreparation> {
  const [row] = await client<DeletionTargetRow[]>`
    select backups.id as "backupId",
      backups.workspace_id as "workspaceId",
      backups.object_key as "objectKey",
      backups.status::text as status,
      (
        select count(*)::text
        from backup_download_locks
        where backup_download_locks.backup_id = backups.id
          and backup_download_locks.workspace_id = backups.workspace_id
          and backup_download_locks.expires_at > ${params.now}
      ) as "activeLockCount"
    from backups
    where backups.id = ${params.backupId}
      and backups.workspace_id = ${params.workspaceId}
    limit 1
  `;

  if (!row) {
    return { ok: false, code: "backup.not_found" };
  }

  if (row.status !== "succeeded") {
    return { ok: false, code: "backup.not_active" };
  }

  if (Number(row.activeLockCount) > 0) {
    return { ok: false, code: "backup.locked" };
  }

  return {
    ok: true,
    target: {
      backupId: row.backupId,
      workspaceId: row.workspaceId,
      objectKey: row.objectKey,
      status: row.status,
      hasActiveLock: false
    }
  };
}

export async function finalizeBackupDeletion(
  client: Sql,
  params: {
    workspaceId: string;
    backupId: string;
    finalStatus: BackupDeletionFinalStatus;
    deletedByUserId: string | null;
  }
): Promise<BackupDeletionSuccess | BackupDeletionFailure> {
  return client.begin(async (tx: TransactionSql) => {
    const [updated] = await tx<{ backupId: string; workspaceId: string }[]>`
      update backups
      set status = ${params.finalStatus},
        deleted_at = now(),
        expired_at = case when ${params.finalStatus} = 'expired' then now() else expired_at end,
        deleted_by_user_id = ${params.deletedByUserId}
      where id = ${params.backupId}
        and workspace_id = ${params.workspaceId}
        and status = 'succeeded'
      returning id as "backupId", workspace_id as "workspaceId"
    `;

    if (!updated) {
      return { ok: false, code: "backup.delete_conflict" } as const;
    }

    const retainedStorageBytes = await getRetainedStorageBytesForDeletion(tx, params.workspaceId);
    return {
      ok: true,
      backupId: updated.backupId,
      workspaceId: updated.workspaceId,
      finalStatus: params.finalStatus,
      retainedStorageBytes
    } as const;
  });
}

export async function markBackupDeleteFailed(
  client: Sql,
  params: {
    workspaceId: string;
    backupId: string;
    retryAfter: Date;
    errorMessage: string;
  }
): Promise<BackupDeletionRetryFailure | BackupDeletionFailure> {
  return client.begin(async (tx: TransactionSql) => {
    const [updated] = await tx<{ backupId: string; workspaceId: string }[]>`
      update backups
      set deleted_at = deleted_at
      where id = ${params.backupId}
        and workspace_id = ${params.workspaceId}
        and status = 'succeeded'
      returning id as "backupId", workspace_id as "workspaceId"
    `;

    if (!updated) {
      return { ok: false, code: "backup.delete_conflict" } as const;
    }

    await tx`
      insert into cleanup_records (workspace_id, backup_id, object_key, reason, status, attempt_count, delete_retry_after, last_error, updated_at)
      select backups.workspace_id,
        backups.id,
        backups.object_key,
        'backup_delete',
        'pending',
        coalesce((
          select cleanup_records.attempt_count
          from cleanup_records
          where cleanup_records.backup_id = backups.id
            and cleanup_records.workspace_id = backups.workspace_id
            and cleanup_records.reason = 'backup_delete'
          order by cleanup_records.created_at desc, cleanup_records.id desc
          limit 1
        ), 0) + 1,
        ${params.retryAfter},
        ${params.errorMessage},
        now()
      from backups
      where backups.id = ${params.backupId}
        and backups.workspace_id = ${params.workspaceId}
    `;

    const retainedStorageBytes = await getRetainedStorageBytesForDeletion(tx, params.workspaceId);
    return {
      ok: true,
      backupId: updated.backupId,
      workspaceId: updated.workspaceId,
      retainedStorageBytes,
      deleteRetryAfter: params.retryAfter,
      deleteError: params.errorMessage
    } as const;
  });
}

export async function cleanupExpiredDownloadLocks(client: RetentionSqlClient, now: Date): Promise<number> {
  const rows = await client<{ id: string }[]>`
    delete from backup_download_locks
    where expires_at <= ${now}
    returning id
  `;

  return rows.length;
}

async function getRetainedStorageBytesForDeletion(client: RetentionSqlClient, workspaceId: string): Promise<bigint> {
  const [row] = await client<RetainedBytesRow[]>`
    select coalesce(sum(backups.stored_size_bytes), 0)::text as retained_bytes
    from backups
    where backups.workspace_id = ${workspaceId}
      and backups.status = 'succeeded'
  `;

  return BigInt(row?.retained_bytes ?? "0");
}

export function computeDeleteRetryAfter(now: Date, attemptCount: number): Date {
  const normalizedAttempt = Math.max(1, attemptCount);
  const delayMs = Math.min(4 * 60 * 60 * 1000, 5 * 60 * 1000 * 2 ** (normalizedAttempt - 1));
  return new Date(now.getTime() + delayMs);
}

export function buildBackupDeleteAuditMetadata(params: {
  reason: BackupDeletionReason;
  finalStatus?: BackupDeletionFinalStatus;
  retainedStorageBytes: bigint;
  deleteRetryAfter?: Date;
  errorMessage?: string;
}): Record<string, unknown> {
  return {
    reason: params.reason,
    finalStatus: params.finalStatus,
    retainedStorageBytes: params.retainedStorageBytes.toString(),
    deleteRetryAfter: params.deleteRetryAfter?.toISOString(),
    deleteError: params.errorMessage
  };
}

export type BackupDeleteAuditInput = {
  workspaceId: string;
  targetId: string;
  result: AuditResult;
  actor: BackupDeletionActor;
  internalErrorRef?: string | null;
  metadata?: Record<string, unknown>;
};
