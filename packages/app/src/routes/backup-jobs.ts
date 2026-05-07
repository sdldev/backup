import { Elysia } from 'elysia';
import type { Db } from '../db';
import { cancelBackupJob, createManualBackupJob, getBackupJob, listBackupJobs, toSafeBackupJob } from '../services/backup-jobs';
import { getSessionFromRequest } from '../services/sessions';

type BackupJobRoutesOptions = { db: Db };

export function backupJobRoutes({ db }: BackupJobRoutesOptions) {
  return new Elysia({ prefix: '/v1/workspaces/:workspaceId' })
    .get('/backup-jobs', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

      const rows = await listBackupJobs(db, params.workspaceId, session.user.id);
      return { data: rows.map(toSafeBackupJob) };
    })
    .get('/backup-jobs/:jobId/events', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

      const encoder = new TextEncoder();
      const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled']);
      let lastPayload = '';
      let closed = false;

      const stream = new ReadableStream({
        async start(controller) {
          const emit = async () => {
            if (closed) return;
            const job = await getBackupJob(db, params.workspaceId, params.jobId, session.user.id);
            const safeJob = toSafeBackupJob(job);
            const payload = JSON.stringify(safeJob);
            if (payload !== lastPayload) {
              controller.enqueue(encoder.encode(`event: state\ndata: ${payload}\n\n`));
              lastPayload = payload;
            }
            if (terminalStatuses.has(safeJob.status)) {
              closed = true;
              controller.close();
            }
          };

          await emit();
          const timer = setInterval(() => {
            emit().catch((error) => {
              const safeError = error instanceof Error ? error : new Error('Unknown SSE error');
              controller.enqueue(
                encoder.encode(`event: error\ndata: ${JSON.stringify({ message: 'Backup Job event stream failed' })}\n\n`),
              );
              console.error({ message: safeError.message, name: safeError.name });
              closed = true;
              clearInterval(timer);
              controller.close();
            });
          }, 2000);

          request.signal.addEventListener('abort', () => {
            closed = true;
            clearInterval(timer);
          });
        },
      });

      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        },
      });
    })
    .get('/backup-jobs/:jobId', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

      const job = await getBackupJob(db, params.workspaceId, params.jobId, session.user.id);
      return { data: toSafeBackupJob(job) };
    })
    .post('/backup-jobs/:jobId/cancel', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

      const job = await cancelBackupJob(db, params.workspaceId, params.jobId, session.user.id);
      return { data: toSafeBackupJob(job) };
    })
    .post('/database-sources/:sourceId/backup-jobs', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

      const job = await createManualBackupJob(db, params.workspaceId, params.sourceId, session.user.id);
      return status(201, { data: toSafeBackupJob(job) });
    });
}
