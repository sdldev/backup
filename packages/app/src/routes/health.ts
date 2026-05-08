import { Elysia } from 'elysia';
import type { Sql } from 'postgres';

type HealthRoutesOptions = {
  sql: Sql;
};

export function healthRoutes({ sql }: HealthRoutesOptions) {
  return new Elysia({ prefix: '/v1' })
    .get('/health', () => ({ status: 'ok', version: '1.0.0' }))
    .get('/health/live', () => ({ status: 'ok' }))
    .get('/health/ready', async ({ status }) => {
      try {
        await sql`select 1`;

        return status(200, {
          status: 'ok',
          checks: {
            database: 'ok',
            storage: 'skipped',
          },
        });
      } catch {
        return status(503, {
          status: 'unavailable',
          checks: {
            database: 'failed',
            storage: 'skipped',
          },
        });
      }
    });
}
