import { and, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { backupJobs, backupStorageConfigs, backups, databaseSources, projects } from '../db';
import { writeAuditEvent } from './audit';
import { encryptBackupArtifactStreamEnvelope } from './backup-artifact-crypto';
import { buildDumpCommand, runDumpCommandStream } from './database-engine-adapters';
import { createObjectStorageProvider } from './object-storage';
import { decryptSecret, type EncryptedSecret } from './secret-vault';

export async function processQueuedBackupJobScaffold(db: Db) {
  const [job] = await db
    .select()
    .from(backupJobs)
    .where(eq(backupJobs.status, 'queued'))
    .orderBy(backupJobs.queuedAt)
    .limit(1);

  if (!job) return null;

  const now = new Date();
  const [running] = await db
    .update(backupJobs)
    .set({ status: 'running', stage: 'connected', startedAt: now, updatedAt: now })
    .where(and(eq(backupJobs.id, job.id), eq(backupJobs.status, 'queued')))
    .returning();

  if (!running) return null;

  await writeAuditEvent(db, {
    workspaceId: running.workspaceId,
    eventType: 'backup_job.started',
    actor: { type: 'system' },
    resourceType: 'backup_job',
    resourceId: running.id,
    metadata: {},
  });

  const [source] = await db.select().from(databaseSources).where(eq(databaseSources.id, running.databaseSourceId)).limit(1);
  const [project] = await db.select().from(projects).where(eq(projects.id, running.projectId)).limit(1);
  const [storageConfig] = await db
    .select()
    .from(backupStorageConfigs)
    .where(and(eq(backupStorageConfigs.workspaceId, running.workspaceId), eq(backupStorageConfigs.isCurrent, true)))
    .limit(1);

  if (running.cancelRequestedAt) {
    return cancelRunningJob(db, running.id);
  }

  if (!source || !project || !storageConfig || storageConfig.status !== 'active') {
    const finishedAt = new Date();
    const [failed] = await db
      .update(backupJobs)
      .set({
        status: 'failed',
        stage: 'failed',
        attemptCount: running.attemptCount + 1,
        errorCategory: 'storage_or_source_unavailable',
        userErrorMessage: 'Backup could not start because Source or Backup Storage is unavailable.',
        finishedAt,
        updatedAt: finishedAt,
      })
      .where(eq(backupJobs.id, running.id))
      .returning();
    return failed ?? running;
  }

  const timestamp = new Date().toISOString().replaceAll('-', '').replaceAll(':', '').replaceAll('.', '').slice(0, 15) + 'Z';
  const ext = source.engine === 'postgresql' ? 'dump' : 'sql.gz';
  const safeProject = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  const safeSource = source.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'source';
  const filename = `${safeProject}-${safeSource}-${timestamp}.${ext}`;
  const objectKey = `workspace/${running.workspaceId}/backups/${running.id}/${crypto.randomUUID()}.${ext}`;
  let dump: Awaited<ReturnType<typeof createBackupPlaintext>>;
  try {
    dump = await createBackupPlaintext(source, running.workspaceId, project.id);
  } catch (error) {
    return failRunningJob(db, running.id, 'dump_failed', sanitizeWorkerError(error));
  }

  const [latestAfterDump] = await db.select().from(backupJobs).where(eq(backupJobs.id, running.id)).limit(1);
  if (latestAfterDump?.cancelRequestedAt) {
    return cancelRunningJob(db, running.id);
  }

  let originalSizeBytes = 0;
  let encryptedBody: ReadableStream<Uint8Array>;
  try {
    encryptedBody = encryptBackupArtifactStreamEnvelope(dump.stream, {
      onPlaintextChunk: (chunk) => { originalSizeBytes += chunk.byteLength; },
    });
  } catch (error) {
    return failRunningJob(db, running.id, 'dump_failed', sanitizeWorkerError(error));
  }
  const dumpExit = await dump.processDone;
  const dumpStderr = await dump.stderr;
  if (dumpExit !== 0) {
    return failRunningJob(db, running.id, 'dump_failed', sanitizeWorkerError(new Error(dumpStderr || `Dump command exited with code ${dumpExit}`)));
  }

  const [latestBeforeUpload] = await db.select().from(backupJobs).where(eq(backupJobs.id, running.id)).limit(1);
  if (latestBeforeUpload?.cancelRequestedAt) {
    return cancelRunningJob(db, running.id);
  }

  const storage = createObjectStorageProvider();
  let putResult: Awaited<ReturnType<typeof storage.putObject>>;
  try {
    putResult = await storage.putObject({ key: objectKey, body: cancelAwareStream(encryptedBody, async () => {
      const [latest] = await db.select().from(backupJobs).where(eq(backupJobs.id, running.id)).limit(1);
      return Boolean(latest?.cancelRequestedAt);
    }) });
  } catch (error) {
    await storage.deleteObject(objectKey).catch(() => undefined);
    const [latest] = await db.select().from(backupJobs).where(eq(backupJobs.id, running.id)).limit(1);
    if (latest?.cancelRequestedAt) return cancelRunningJob(db, running.id);
    return failRunningJob(db, running.id, 'storage_upload_failed', sanitizeWorkerError(error));
  }

  const [latestAfterUpload] = await db.select().from(backupJobs).where(eq(backupJobs.id, running.id)).limit(1);
  if (latestAfterUpload?.cancelRequestedAt) {
    await storage.deleteObject(objectKey).catch(() => undefined);
    return cancelRunningJob(db, running.id);
  }

  const finishedAt = new Date();
  const retentionExpiresAt = new Date(Date.now() + source.retentionDays * 24 * 60 * 60 * 1000);
  const [backup] = await db
    .insert(backups)
    .values({
      workspaceId: running.workspaceId,
      projectId: running.projectId,
      databaseSourceId: running.databaseSourceId,
      backupJobId: running.id,
      storageConfigId: storageConfig.id,
      status: 'succeeded',
      format: dump.format,
      objectKey,
      downloadFilename: filename,
      encryptedSizeBytes: putResult.storedBytes,
      originalSizeBytes,
      retentionExpiresAt,
    })
    .returning();

  await db.update(databaseSources).set({ lastSuccessfulBackupAt: finishedAt, health: 'healthy', updatedAt: finishedAt }).where(eq(databaseSources.id, source.id));

  const [succeeded] = await db
    .update(backupJobs)
    .set({ status: 'succeeded', stage: 'succeeded', attemptCount: running.attemptCount + 1, finishedAt, updatedAt: finishedAt })
    .where(eq(backupJobs.id, running.id))
    .returning();

  const result = succeeded ?? running;
  await writeAuditEvent(db, {
    workspaceId: result.workspaceId,
    eventType: 'backup_job.succeeded_scaffold',
    actor: { type: 'system' },
    resourceType: 'backup_job',
    resourceId: result.id,
    metadata: { backup_id: backup?.id ?? null },
  });

  return result;
}

async function createBackupPlaintext(source: typeof databaseSources.$inferSelect, workspaceId: string, projectId: string) {
  if (Bun.env.BACKUP_DUMP_MODE === 'process') {
    const password = source.encryptedPassword ? await decryptSecret(source.encryptedPassword as EncryptedSecret) : undefined;
    const command = buildDumpCommand({
      engine: source.engine,
      host: source.host,
      port: source.port,
      database: source.technicalDatabaseName,
      username: source.username,
      password,
      sslMode: source.sslMode,
    });
    const result = runDumpCommandStream(command);
    return { stream: result.stream, processDone: result.processDone, stderr: result.stderr, format: command.format };
  }

  const bodyText = `-- Backup pipeline scaffold\n-- Workspace: ${workspaceId}\n-- Project: ${projectId}\n-- Source: ${source.id}\n-- Real database dump/encryption not implemented yet.\nselect 1;\n`;
  const bytes = new TextEncoder().encode(bodyText);
  return {
    stream: new Response(bytes).body!,
    processDone: Promise.resolve(0),
    stderr: Promise.resolve(''),
    format: source.engine === 'postgresql' ? 'postgres_custom' as const : 'mysql_sql_gzip' as const,
  };
}

export function cancelAwareStream(stream: ReadableStream<Uint8Array>, isCancelled: () => Promise<boolean>) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          if (await isCancelled()) throw new Error('Backup Job cancellation requested');
          controller.enqueue(chunk);
        }
        if (await isCancelled()) throw new Error('Backup Job cancellation requested');
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function sanitizeWorkerError(error: unknown) {
  if (!(error instanceof Error)) return 'Backup failed';
  return error.message
    .replace(/password=[^\s]+/gi, 'password=REDACTED')
    .replace(/:[^:@\s]+@/g, ':REDACTED@')
    .replace(/(pass(word)?\s*[:=]\s*)[^\s]+/gi, '$1REDACTED');
}

async function failRunningJob(db: Db, jobId: string, errorCategory: string, userErrorMessage: string) {
  const finishedAt = new Date();
  const [failed] = await db
    .update(backupJobs)
    .set({ status: 'failed', stage: 'failed', errorCategory, userErrorMessage, finishedAt, updatedAt: finishedAt })
    .where(eq(backupJobs.id, jobId))
    .returning();

  if (failed) {
    await writeAuditEvent(db, {
      workspaceId: failed.workspaceId,
      eventType: 'backup_job.failed',
      actor: { type: 'system' },
      resourceType: 'backup_job',
      resourceId: failed.id,
      metadata: { error_category: errorCategory, user_error_message: userErrorMessage },
    });
  }

  return failed ?? null;
}

async function cancelRunningJob(db: Db, jobId: string) {
  const finishedAt = new Date();
  const [cancelled] = await db
    .update(backupJobs)
    .set({ status: 'cancelled', stage: 'cancelled', finishedAt, updatedAt: finishedAt })
    .where(eq(backupJobs.id, jobId))
    .returning();

  if (cancelled) {
    await writeAuditEvent(db, {
      workspaceId: cancelled.workspaceId,
      eventType: 'backup_job.cancelled',
      actor: { type: 'system' },
      resourceType: 'backup_job',
      resourceId: cancelled.id,
      metadata: {},
    });
  }

  return cancelled ?? null;
}

export function startBackupWorkerScaffold(db: Db) {
  const intervalMs = Number(Bun.env.BACKUP_WORKER_POLL_MS ?? 5000);
  const timer = setInterval(() => {
    processQueuedBackupJobScaffold(db).catch((error) => {
      const safeError = error instanceof Error ? error : new Error('Unknown backup worker error');
      console.error({ message: safeError.message, name: safeError.name });
    });
  }, intervalMs);

  return () => clearInterval(timer);
}
