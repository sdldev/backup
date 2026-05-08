import { Elysia } from 'elysia';
import type { Db } from '../db';
import { listAuditEvents, toSafeAuditEvent } from '../services/audit';
import { getSessionFromRequest } from '../services/sessions';

type AuditLogRoutesOptions = { db: Db };

export function auditLogRoutes({ db }: AuditLogRoutesOptions) {
  return new Elysia({ prefix: '/v1/workspaces/:workspaceId/audit-log' }).get('/', async ({ params, request, status }) => {
    const session = await getSessionFromRequest(db, request);
    if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

    const rows = await listAuditEvents(db, params.workspaceId, session.user.id);
    return { data: rows.map(toSafeAuditEvent) };
  });
}
