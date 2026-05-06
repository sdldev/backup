export { provisionWorkspaceStorage, provisionWorkspaceStorageWithClient, type ProvisionWorkspaceStorageResult } from "@mba/storage";

import { randomUUID } from "node:crypto";
import { appendAuditLogWithClient, cleanupExpiredDownloadLocks, computeDeleteRetryAfter, finalizeBackupDeletion, getWorkspaceRetainedStorageBytes, listRetentionCandidates, markBackupDeleteFailed, type BackupJobRow, type createSqlClient } from "@mba/db";
import type { ConnectionTestInput, DumpCommand, DumpFormat, SupportedDatabaseEngine } from "@mba/engine-adapters";
import { createEngineAdapter } from "@mba/engine-adapters";
import { encryptBackupStream, generateBackupDataKey, readEncryptedBackupHeader, wrapBackupDataKey } from "@mba/security";
import type { BackupObjectStorage } from "@mba/storage";
import { StorageLimitExceededError, createOpaqueBackupObjectKey } from "@mba/storage";

type SqlClient = ReturnType<typeof createSqlClient>;

export type ClaimedBackupJob = BackupJobRow;

export type BackupJobProcessFailure = {
  category: "transient" | "permanent";
  message: string;
  internalErrorRef?: string | null;
};

export type BackupPipelineDumpRunner = (command: DumpCommand, source: BackupPipelineSource) => Promise<ReadableStream<Uint8Array>>;

export type BackupPipelineSource = ConnectionTestInput & {
  id: string;
  workspaceId: string;
  projectId: string;
  displayName: string;
  retentionDays: number;
};

export type BackupPipelineStorageConfig = {
  id: string;
  storagePrefix: string;
};

export type BackupPipelineResult = {
  backupId: string;
  objectKey: string;
  originalDumpSizeBytes: bigint;
  storedSizeBytes: bigint;
  encryptedChecksum: string;
  idempotencyKey: string;
  headerVersion: 1;
};

export type BackupPipelineOptions = {
  client: SqlClient;
  storage: BackupObjectStorage;
  job: ClaimedBackupJob;
  workspaceKey: Uint8Array;
  remainingStorageBytes: bigint;
  dumpRunner: BackupPipelineDumpRunner;
  now?: Date;
};

export type ReconciliationDryRunAction = {
  objectKey: string;
  action: "delete_orphan" | "keep_committed";
  reason: string;
};

export type ReconciliationDryRunReport = {
  dryRun: true;
  scannedPrefix: string;
  actions: ReconciliationDryRunAction[];
};

export type RetentionWorkerAction = {
  backupId: string;
  workspaceId: string;
  objectKey: string;
  action: "delete" | "skip_locked";
  reason: string;
};

export type RetentionWorkerReport = {
  dryRun: boolean;
  scannedAt: string;
  expiredLockCount: number;
  actions: RetentionWorkerAction[];
};

export type WorkspacePurgeAction = {
  workspaceId: string;
  storagePrefix: string | null;
  objectKeys: string[];
  action: "purge_workspace";
  reason: string;
};

export type WorkspacePurgeReport = {
  dryRun: boolean;
  scannedAt: string;
  actions: WorkspacePurgeAction[];
};

export function computeRetryBackoffMs(attemptCount: number): number {
  const normalizedAttempt = Math.max(1, attemptCount);
  return Math.min(4 * 60 * 1000, 30_000 * 2 ** (normalizedAttempt - 1));
}

export async function claimNextBackupJob(client: SqlClient): Promise<ClaimedBackupJob | null> {
  const [job] = await client<ClaimedBackupJob[]>`
    update backup_jobs
    set status = 'running',
      stage = 'dumping',
      attempt_count = attempt_count + 1,
      started_at = coalesce(started_at, now()),
      finished_at = null,
      updated_at = now()
    where id = (
      select id
      from backup_jobs
      where status = 'queued'
        and queued_at <= now()
        and trigger = 'manual'
      order by queued_at asc, created_at asc
      for update skip locked
      limit 1
    )
    returning id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      database_source_id as "databaseSourceId",
      trigger::text as trigger,
      requested_by_user_id as "requestedByUserId",
      status::text as status,
      stage::text as stage,
      attempt_count as "attemptCount",
      max_attempts as "maxAttempts",
      error_category as "errorCategory",
      user_error_message as "userErrorMessage",
      internal_error_ref as "internalErrorRef",
      queued_at as "queuedAt",
      started_at as "startedAt",
      finished_at as "finishedAt",
      cancel_requested_at as "cancelRequestedAt",
      cancel_requested_by_user_id as "cancelRequestedByUserId"
  `;

  return job ?? null;
}

export async function completeBackupJob(client: SqlClient, workspaceId: string, jobId: string): Promise<ClaimedBackupJob | null> {
  const [job] = await client<ClaimedBackupJob[]>`
    update backup_jobs
    set status = 'succeeded',
      stage = 'succeeded',
      error_category = null,
      user_error_message = null,
      internal_error_ref = null,
      finished_at = now(),
      updated_at = now()
    where id = ${jobId}
      and workspace_id = ${workspaceId}
      and status = 'running'
    returning id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      database_source_id as "databaseSourceId",
      trigger::text as trigger,
      requested_by_user_id as "requestedByUserId",
      status::text as status,
      stage::text as stage,
      attempt_count as "attemptCount",
      max_attempts as "maxAttempts",
      error_category as "errorCategory",
      user_error_message as "userErrorMessage",
      internal_error_ref as "internalErrorRef",
      queued_at as "queuedAt",
      started_at as "startedAt",
      finished_at as "finishedAt",
      cancel_requested_at as "cancelRequestedAt",
      cancel_requested_by_user_id as "cancelRequestedByUserId"
  `;

  return job ?? null;
}

export async function failBackupJob(client: SqlClient, job: ClaimedBackupJob, failure: BackupJobProcessFailure): Promise<ClaimedBackupJob | null> {
  if (job.cancelRequestedAt) {
    const [cancelled] = await client<ClaimedBackupJob[]>`
      update backup_jobs
      set status = 'cancelled',
        stage = 'cancelled',
        error_category = ${failure.category},
        user_error_message = ${failure.message},
        internal_error_ref = ${failure.internalErrorRef ?? null},
        finished_at = now(),
        updated_at = now()
      where id = ${job.id}
        and workspace_id = ${job.workspaceId}
        and status = 'running'
      returning id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        database_source_id as "databaseSourceId",
        trigger::text as trigger,
        requested_by_user_id as "requestedByUserId",
        status::text as status,
        stage::text as stage,
        attempt_count as "attemptCount",
        max_attempts as "maxAttempts",
        error_category as "errorCategory",
        user_error_message as "userErrorMessage",
        internal_error_ref as "internalErrorRef",
        queued_at as "queuedAt",
        started_at as "startedAt",
        finished_at as "finishedAt",
        cancel_requested_at as "cancelRequestedAt",
        cancel_requested_by_user_id as "cancelRequestedByUserId"
    `;

    return cancelled ?? null;
  }

  if (failure.category === "transient" && job.attemptCount < job.maxAttempts) {
    const backoffMs = computeRetryBackoffMs(job.attemptCount);
    const [retried] = await client<ClaimedBackupJob[]>`
      update backup_jobs
      set status = 'queued',
        stage = 'queued',
        error_category = ${failure.category},
        user_error_message = ${failure.message},
        internal_error_ref = ${failure.internalErrorRef ?? null},
        queued_at = now() + (${backoffMs}::text || ' milliseconds')::interval,
        started_at = null,
        finished_at = null,
        updated_at = now()
      where id = ${job.id}
        and workspace_id = ${job.workspaceId}
        and status = 'running'
      returning id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        database_source_id as "databaseSourceId",
        trigger::text as trigger,
        requested_by_user_id as "requestedByUserId",
        status::text as status,
        stage::text as stage,
        attempt_count as "attemptCount",
        max_attempts as "maxAttempts",
        error_category as "errorCategory",
        user_error_message as "userErrorMessage",
        internal_error_ref as "internalErrorRef",
        queued_at as "queuedAt",
        started_at as "startedAt",
        finished_at as "finishedAt",
        cancel_requested_at as "cancelRequestedAt",
        cancel_requested_by_user_id as "cancelRequestedByUserId"
    `;

    return retried ?? null;
  }

  const [failed] = await client<ClaimedBackupJob[]>`
    update backup_jobs
    set status = 'failed',
      stage = 'failed',
      error_category = ${failure.category},
      user_error_message = ${failure.message},
      internal_error_ref = ${failure.internalErrorRef ?? null},
      finished_at = now(),
      updated_at = now()
    where id = ${job.id}
      and workspace_id = ${job.workspaceId}
      and status = 'running'
    returning id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      database_source_id as "databaseSourceId",
      trigger::text as trigger,
      requested_by_user_id as "requestedByUserId",
      status::text as status,
      stage::text as stage,
      attempt_count as "attemptCount",
      max_attempts as "maxAttempts",
      error_category as "errorCategory",
      user_error_message as "userErrorMessage",
      internal_error_ref as "internalErrorRef",
      queued_at as "queuedAt",
      started_at as "startedAt",
      finished_at as "finishedAt",
      cancel_requested_at as "cancelRequestedAt",
      cancel_requested_by_user_id as "cancelRequestedByUserId"
  `;

  return failed ?? null;
}

export async function processBackupPipeline(options: BackupPipelineOptions): Promise<BackupPipelineResult> {
  const source = await selectPipelineSource(options.client, options.job.workspaceId, options.job.databaseSourceId);
  const storageConfig = await selectPipelineStorageConfig(options.client, options.job.workspaceId);
  const idempotencyKey = `${options.job.workspaceId}:${options.job.databaseSourceId}:${options.job.id}:${String(options.job.attemptCount)}`;
  const adapter = createEngineAdapter(source.engine);
  const dumpCommand = adapter.createDumpCommand(source);
  assertDumpCommandIsArgvOnly(dumpCommand);
  const objectKey = createOpaqueBackupObjectKey(storageConfig.storagePrefix);
  const dataKey = generateBackupDataKey();
  const wrappedDataKey = await wrapBackupDataKey({
    workspaceId: options.job.workspaceId,
    backupId: options.job.id,
    backupDataKey: dataKey,
    workspaceKey: options.workspaceKey
  });

  await updateJobStage(options.client, options.job.workspaceId, options.job.id, "dumping");
  let originalDumpSizeBytes = 0n;
  let storedObjectKey: string | null = null;

  try {
    const dumpStream = await options.dumpRunner(dumpCommand, source);
    const countedDumpStream = countStreamBytes(dumpStream, (count) => {
      originalDumpSizeBytes += BigInt(count);
    });
    const compressedStream = dumpCommand.format === "mysql_sql_gzip" ? gzipStream(countedDumpStream) : countedDumpStream;
    if (dumpCommand.format === "mysql_sql_gzip") {
      await updateJobStage(options.client, options.job.workspaceId, options.job.id, "compressing");
    }
    await updateJobStage(options.client, options.job.workspaceId, options.job.id, "encrypting");
    const encryptedStream = encryptBackupStream(compressedStream, { dataKey });
    await updateJobStage(options.client, options.job.workspaceId, options.job.id, "uploading");
    const stored = await options.storage.putObjectStream({
      key: objectKey,
      body: encryptedStream,
      maxBytes: options.remainingStorageBytes,
      metadata: { idempotencyKey }
    });
    storedObjectKey = stored.key;
    await updateJobStage(options.client, options.job.workspaceId, options.job.id, "verifying");
    const object = await readStoredObjectForHeader(options.storage, stored.key);
    const headerVersion = readEncryptedBackupHeader(object).version;
    const backupId = await insertSucceededBackup(options.client, {
      job: options.job,
      source,
      storageConfig,
      objectKey: stored.key,
      format: dumpCommand.format,
      originalDumpSizeBytes,
      storedSizeBytes: stored.sizeBytes,
      encryptedChecksum: stored.checksum,
      wrappedDataKey: JSON.stringify(wrappedDataKey),
      retentionExpiresAt: retentionExpiry(options.now ?? new Date(), source.retentionDays)
    });
    await completeBackupJob(options.client, options.job.workspaceId, options.job.id);

    return {
      backupId,
      objectKey: stored.key,
      originalDumpSizeBytes,
      storedSizeBytes: stored.sizeBytes,
      encryptedChecksum: stored.checksum,
      idempotencyKey,
      headerVersion
    };
  } catch (error) {
    if (storedObjectKey) {
      await options.storage.deleteObject(storedObjectKey);
    } else {
      await options.storage.deleteObject(objectKey);
    }

    const storageLimitFailure = error instanceof StorageLimitExceededError;
    await failBackupJob(options.client, options.job, {
      category: storageLimitFailure ? "permanent" : "transient",
      message: storageLimitFailure ? "storage_limit_exceeded" : "backup_pipeline_failed",
      internalErrorRef: storageLimitFailure ? null : randomUUID()
    });
    throw error;
  }
}

export async function reconcileBackupObjectsDryRun(params: {
  client: SqlClient;
  storage: BackupObjectStorage;
  storagePrefix: string;
}): Promise<ReconciliationDryRunReport> {
  const keys = await params.storage.listKeys(params.storagePrefix);
  const actions: ReconciliationDryRunAction[] = [];

  for (const objectKey of keys) {
    const [row] = await params.client<{ id: string }[]>`
      select id
      from backups
      where object_key = ${objectKey}
        and status = 'succeeded'
      limit 1
    `;

    actions.push(row
      ? { objectKey, action: "keep_committed", reason: "matching succeeded backup metadata exists" }
      : { objectKey, action: "delete_orphan", reason: "no matching succeeded backup metadata" });
  }

  return { dryRun: true, scannedPrefix: params.storagePrefix, actions };
}

export async function runWorkspacePurgeWorker(params: {
  client: SqlClient;
  storage: BackupObjectStorage;
  now: Date;
  dryRun: boolean;
}): Promise<WorkspacePurgeReport> {
  const workspaces = await params.client<{ workspaceId: string; storagePrefix: string | null }[]>`
    select workspaces.id as "workspaceId",
      (
        select backup_storage_configs.storage_prefix
        from backup_storage_configs
        where backup_storage_configs.workspace_id = workspaces.id
          and backup_storage_configs.is_current = true
        order by backup_storage_configs.created_at desc, backup_storage_configs.id desc
        limit 1
      ) as "storagePrefix"
    from workspaces
    where workspaces.soft_deleted_at is not null
      and workspaces.purge_scheduled_at is not null
      and workspaces.purge_scheduled_at <= ${params.now}
    order by workspaces.purge_scheduled_at asc, workspaces.id asc
  `;

  const actions: WorkspacePurgeAction[] = [];

  for (const workspace of workspaces) {
    const objectKeys = workspace.storagePrefix ? await params.storage.listKeys(workspace.storagePrefix) : [];
    actions.push({
      workspaceId: workspace.workspaceId,
      storagePrefix: workspace.storagePrefix,
      objectKeys,
      action: "purge_workspace",
      reason: "workspace soft-delete grace elapsed"
    });

    if (params.dryRun) {
      continue;
    }

    for (const objectKey of objectKeys) {
      await params.storage.deleteObject(objectKey);
    }

    await params.client`
      update sessions
      set active_workspace_id = null,
        updated_at = now()
      where active_workspace_id = ${workspace.workspaceId}
    `;

    await params.client`
      delete from workspaces
      where id = ${workspace.workspaceId}
        and soft_deleted_at is not null
        and purge_scheduled_at is not null
        and purge_scheduled_at <= ${params.now}
    `;
  }

  return {
    dryRun: params.dryRun,
    scannedAt: params.now.toISOString(),
    actions
  };
}

export function workerSmoke(): string {
  return "worker";
}

export async function runRetentionWorker(params: {
  client: SqlClient;
  storage: BackupObjectStorage;
  now: Date;
  dryRun: boolean;
}): Promise<RetentionWorkerReport> {
  const expiredLockCount = await cleanupExpiredDownloadLocks(params.client, params.now);
  const candidates = await listRetentionCandidates(params.client, params.now);
  const actions: RetentionWorkerAction[] = [];

  for (const candidate of candidates) {
    if (candidate.hasActiveLock) {
      actions.push({
        backupId: candidate.backupId,
        workspaceId: candidate.workspaceId,
        objectKey: candidate.objectKey,
        action: "skip_locked",
        reason: "active download lock present"
      });
      continue;
    }

    actions.push({
      backupId: candidate.backupId,
      workspaceId: candidate.workspaceId,
      objectKey: candidate.objectKey,
      action: "delete",
      reason: "retention expired"
    });

    if (params.dryRun) {
      continue;
    }

    try {
      const deleted = await params.storage.deleteObject(candidate.objectKey);
      const finalized = await finalizeBackupDeletion(params.client, {
        workspaceId: candidate.workspaceId,
        backupId: candidate.backupId,
        finalStatus: "expired",
        deletedByUserId: null
      });

      if (finalized.ok) {
        await appendAuditLogWithClient(params.client, {
          workspaceId: candidate.workspaceId,
          eventType: "backup.delete",
          targetType: "backup",
          targetId: candidate.backupId,
          result: "succeeded",
          metadata: {
            reason: "retention",
            finalStatus: finalized.finalStatus,
            retainedStorageBytes: finalized.retainedStorageBytes.toString(),
            objectMissing: !deleted,
            warning: deleted ? null : "object_missing_already_deleted"
          },
          context: {
            actorType: "worker",
            actorUserId: null,
            effectiveActorUserId: null,
            requestId: `retention:${candidate.backupId}`
          }
        });
      }
    } catch (error) {
      const retryFailure = await markBackupDeleteFailed(params.client, {
        workspaceId: candidate.workspaceId,
        backupId: candidate.backupId,
        retryAfter: computeDeleteRetryAfter(params.now, 1),
        errorMessage: error instanceof Error ? error.message : "retention_delete_failed"
      });
      await appendAuditLogWithClient(params.client, {
        workspaceId: candidate.workspaceId,
        eventType: "backup.delete",
        targetType: "backup",
        targetId: candidate.backupId,
        result: "failed",
        metadata: {
          reason: "retention",
          retainedStorageBytes: retryFailure.ok ? retryFailure.retainedStorageBytes.toString() : (await getWorkspaceRetainedStorageBytes(params.client, candidate.workspaceId)).toString(),
          deleteRetryAfter: retryFailure.ok ? retryFailure.deleteRetryAfter.toISOString() : null,
          deleteError: error instanceof Error ? error.message : "retention_delete_failed"
        },
        context: {
          actorType: "worker",
          actorUserId: null,
          effectiveActorUserId: null,
          requestId: `retention:${candidate.backupId}`
        }
      });
    }
  }

  return {
    dryRun: params.dryRun,
    scannedAt: params.now.toISOString(),
    expiredLockCount,
    actions
  };
}

function assertDumpCommandIsArgvOnly(command: DumpCommand): void {
  if (command.argv.length === 0 || command.argv.some((arg) => /\s[|&;<>`$]/.test(arg))) {
    throw new Error("dump_command.invalid_argv");
  }
}

async function selectPipelineSource(client: SqlClient, workspaceId: string, sourceId: string): Promise<BackupPipelineSource> {
  const [source] = await client<BackupPipelineSource[]>`
    select id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      engine::text as engine,
      display_name as "displayName",
      technical_database_name as database,
      host,
      port,
      username,
      encrypted_password as password,
      ssl_mode as "sslMode",
      retention_days as "retentionDays"
    from database_sources
    where id = ${sourceId}
      and workspace_id = ${workspaceId}
      and state = 'enabled'
      and health = 'healthy'
    limit 1
  `;

  if (!source) {
    throw new Error("backup_pipeline.source_not_ready");
  }
  return source;
}

async function selectPipelineStorageConfig(client: SqlClient, workspaceId: string): Promise<BackupPipelineStorageConfig> {
  const [storage] = await client<BackupPipelineStorageConfig[]>`
    select id,
      storage_prefix as "storagePrefix"
    from backup_storage_configs
    where workspace_id = ${workspaceId}
      and is_current = true
      and status = 'active'
    limit 1
  `;

  if (!storage) {
    throw new Error("backup_pipeline.storage_not_ready");
  }
  return storage;
}

async function updateJobStage(client: SqlClient, workspaceId: string, jobId: string, stage: string): Promise<void> {
  await client`
    update backup_jobs
    set stage = ${stage}, updated_at = now()
    where id = ${jobId}
      and workspace_id = ${workspaceId}
      and status = 'running'
  `;
}

function countStreamBytes(input: ReadableStream<Uint8Array>, onChunk: (byteLength: number) => void): ReadableStream<Uint8Array> {
  const reader = input.getReader();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const read = await reader.read();
          if (read.done) {
            break;
          }
          onChunk(read.value.byteLength);
          controller.enqueue(read.value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });
}

function gzipStream(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const gzip = new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>;
  return input.pipeThrough(gzip);
}

async function readStoredObjectForHeader(storage: BackupObjectStorage, objectKey: string): Promise<Uint8Array> {
  const maybeStorage = storage as BackupObjectStorage & { getObject?: (key: string) => { body: Uint8Array } | undefined };
  const object = maybeStorage.getObject?.(objectKey);
  if (!object) {
    throw new Error("backup_pipeline.verify_object_missing");
  }
  return object.body;
}

async function insertSucceededBackup(client: SqlClient, input: {
  job: ClaimedBackupJob;
  source: BackupPipelineSource;
  storageConfig: BackupPipelineStorageConfig;
  objectKey: string;
  format: DumpFormat;
  originalDumpSizeBytes: bigint;
  storedSizeBytes: bigint;
  encryptedChecksum: string;
  wrappedDataKey: string;
  retentionExpiresAt: Date;
}): Promise<string> {
  const originalDumpSizeBytes = input.originalDumpSizeBytes.toString();
  const storedSizeBytes = input.storedSizeBytes.toString();
  const [backup] = await client<{ id: string }[]>`
    insert into backups (
      workspace_id, project_id, database_source_id, backup_job_id, storage_config_id, status, engine, format, object_key,
      download_filename, original_dump_size_bytes, stored_size_bytes, encrypted_checksum, retention_expires_at
    ) values (
      ${input.job.workspaceId}, ${input.job.projectId}, ${input.job.databaseSourceId}, ${input.job.id}, ${input.storageConfig.id}, 'succeeded', ${input.source.engine},
      ${input.format}, ${input.objectKey}, ${downloadFilename(input.source.engine, input.job.id)}, ${originalDumpSizeBytes}, ${storedSizeBytes},
      ${input.encryptedChecksum}, ${input.retentionExpiresAt}
    )
    returning id
  `;

  if (!backup) {
    throw new Error("backup_pipeline.backup_insert_failed");
  }

  await client`
    insert into backup_encryption_keys (workspace_id, backup_id, wrapped_data_key, workspace_key_version, chunk_size_bytes)
    values (${input.job.workspaceId}, ${backup.id}, ${input.wrappedDataKey}, 1, 65536)
  `;

  return backup.id;
}

function retentionExpiry(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

function downloadFilename(engine: SupportedDatabaseEngine, jobId: string): string {
  const suffix = engine === "mysql" ? "sql.gz" : "dump";
  return `backup-${jobId}.${suffix}`;
}
