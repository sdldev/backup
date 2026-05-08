import { Elysia, t } from 'elysia';
import type { Db } from '../db';
import { createDatabaseSource, listDatabaseSourcesForProject, setDatabaseSourceState, testSavedDatabaseSource, toSafeDatabaseSource } from '../services/database-sources';
import { getSessionFromRequest } from '../services/sessions';

type DatabaseSourceRoutesOptions = { db: Db };

const createDatabaseSourceBody = t.Object({
  engine: t.Union([t.Literal('mysql'), t.Literal('postgresql')]),
  display_name: t.String({ minLength: 1, maxLength: 120 }),
  technical_database_name: t.String({ minLength: 1, maxLength: 120 }),
  host: t.String({ minLength: 1, maxLength: 255 }),
  port: t.Number({ minimum: 1, maximum: 65535 }),
  username: t.String({ minLength: 1, maxLength: 120 }),
  password: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
  ssl_mode: t.Optional(t.String({ minLength: 1, maxLength: 40 })),
  retention_days: t.Number({ minimum: 7, maximum: 30 }),
});

export function databaseSourceRoutes({ db }: DatabaseSourceRoutesOptions) {
  return new Elysia({ prefix: '/v1/workspaces/:workspaceId/projects/:projectId/database-sources' })
    .get('/', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

      const rows = await listDatabaseSourcesForProject(db, params.workspaceId, params.projectId, session.user.id);
      return { data: rows.map(toSafeDatabaseSource) };
    })
    .post('/:sourceId/enable', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

      const source = await setDatabaseSourceState(
        db,
        params.workspaceId,
        params.projectId,
        params.sourceId,
        session.user.id,
        'enabled',
      );
      return { data: toSafeDatabaseSource(source) };
    })
    .post('/:sourceId/disable', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

      const source = await setDatabaseSourceState(
        db,
        params.workspaceId,
        params.projectId,
        params.sourceId,
        session.user.id,
        'disabled',
      );
      return { data: toSafeDatabaseSource(source) };
    })
    .post('/:sourceId/test-connection', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

      const { source, result } = await testSavedDatabaseSource(
        db,
        params.workspaceId,
        params.projectId,
        params.sourceId,
        session.user.id,
      );

      return {
        data: {
          source: toSafeDatabaseSource(source),
          test: result,
        },
      };
    })
    .post(
      '/',
      async ({ body, params, request, status }) => {
        const session = await getSessionFromRequest(db, request);
        if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

        const source = await createDatabaseSource(db, {
          workspaceId: params.workspaceId,
          projectId: params.projectId,
          userId: session.user.id,
          engine: body.engine,
          displayName: body.display_name,
          technicalDatabaseName: body.technical_database_name,
          host: body.host,
          port: body.port,
          username: body.username,
          password: body.password,
          sslMode: body.ssl_mode,
          retentionDays: body.retention_days,
        });

        return status(201, { data: toSafeDatabaseSource(source) });
      },
      { body: createDatabaseSourceBody },
    );
}
