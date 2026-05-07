import { Elysia } from 'elysia';
import type { Db } from '../db';
import { createDownloadRequest, deleteBackup, getBackup, listBackups, toSafeBackup } from '../services/backups';
import { getSessionFromRequest } from '../services/sessions';

type BackupRoutesOptions = { db: Db };

export function backupRoutes({ db }: BackupRoutesOptions) {
  return new Elysia({ prefix: '/v1/workspaces/:workspaceId/backups' })
    .get('/', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

      const rows = await listBackups(db, params.workspaceId, session.user.id);
      return { data: rows.map(toSafeBackup) };
    })
    .get('/:backupId', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

      const backup = await getBackup(db, params.workspaceId, params.backupId, session.user.id);
      return { data: toSafeBackup(backup) };
    })
    .delete('/:backupId', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

      const backup = await deleteBackup(db, params.workspaceId, params.backupId, session.user.id);
      return { data: toSafeBackup(backup) };
    })
    .post('/:backupId/download-requests', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

      const result = await createDownloadRequest(db, params.workspaceId, params.backupId, session.user.id, session.sessionId);
      return status(201, { data: { download_url: `/v1/downloads/${result.token}`, expires_at: result.expiresAt.toISOString() } });
    });
}
