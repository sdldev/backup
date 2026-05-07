import { Elysia } from 'elysia';
import { ApiError, createErrorReference, readBooleanFlag, toApiErrorResponse, validateAppMasterKey } from '@backup-saas/shared';
import { createDb, createSqlClient } from './db';
import { auditLogRoutes } from './routes/audit-log';
import { authRoutes } from './routes/auth';
import { backupJobRoutes } from './routes/backup-jobs';
import { backupRoutes } from './routes/backups';
import { databaseSourceRoutes } from './routes/database-sources';
import { downloadRoutes } from './routes/downloads';
import { healthRoutes } from './routes/health';
import { inviteRoutes } from './routes/invites';
import { memberRoutes } from './routes/members';
import { projectRoutes } from './routes/projects';
import { sessionRoutes } from './routes/session';
import { startBackupWorkerScaffold } from './services/backup-worker';
import { startRetentionWorkerScaffold } from './services/retention-worker';
import { workspaceRoutes } from './routes/workspaces';

const API_ENABLED = readBooleanFlag(Bun.env.API_ENABLED, true);
const WORKER_ENABLED = readBooleanFlag(Bun.env.WORKER_ENABLED, true);
const PORT = Number(Bun.env.PORT ?? 3000);

function runStartupChecks() {
  validateAppMasterKey(Bun.env.APP_MASTER_KEY_V1);
}

export function apiErrorToResponse(error: ApiError) {
  return new Response(JSON.stringify(toApiErrorResponse(error)), {
    status: error.status,
    headers: {
      'content-type': 'application/json',
      ...(error.retryAfterSeconds ? { 'retry-after': String(error.retryAfterSeconds) } : {}),
    },
  });
}

export function createApp({ db, sql }: { db: ReturnType<typeof createDb>; sql: ReturnType<typeof createSqlClient> }) {
  return new Elysia()
    .use(healthRoutes({ sql }))
    .use(authRoutes({ db }))
    .use(sessionRoutes({ db }))
    .use(workspaceRoutes({ db }))
    .use(projectRoutes({ db }))
    .use(databaseSourceRoutes({ db }))
    .use(backupJobRoutes({ db }))
    .use(backupRoutes({ db }))
    .use(downloadRoutes({ db }))
    .use(inviteRoutes({ db }))
    .use(memberRoutes({ db }))
    .use(auditLogRoutes({ db }))
    .onError(({ error, status }) => {
      if (error instanceof ApiError) return apiErrorToResponse(error);

      const reference = createErrorReference();
      const safeError = error instanceof Error ? error : new Error('Unknown error');
      console.error({ reference, message: safeError.message, name: safeError.name });
      return status(500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          reference,
        },
      });
    });
}

async function startWorker() {
  const sql = createSqlClient();
  const db = createDb(sql);
  startBackupWorkerScaffold(db);
  startRetentionWorkerScaffold(db);
  console.info('worker enabled: backup and retention scaffolds registered');
}

runStartupChecks();

if (WORKER_ENABLED) {
  await startWorker();
}

if (API_ENABLED) {
  const sql = createSqlClient();
  const db = createDb(sql);
  const app = createApp({ db, sql }).listen(PORT);

  console.info(`app api listening on http://localhost:${app.server?.port}`);
} else if (!WORKER_ENABLED) {
  console.warn('API_ENABLED=false and WORKER_ENABLED=false; nothing to start');
}
