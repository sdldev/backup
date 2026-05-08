import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export function createSqlClient(databaseUrl = Bun.env.DATABASE_URL) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  return postgres(databaseUrl, {
    max: Number(Bun.env.DATABASE_POOL_MAX ?? 20),
  });
}

export function createDb(sql = createSqlClient()) {
  return drizzle(sql, { schema });
}

export type SqlClient = ReturnType<typeof createSqlClient>;
export type Db = ReturnType<typeof createDb>;
