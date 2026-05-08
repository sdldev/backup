import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { backups } from '../db';

export async function getRetainedStorageBytes(db: Db, workspaceId: string) {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${backups.encryptedSizeBytes}), 0)::bigint` })
    .from(backups)
    .where(and(eq(backups.workspaceId, workspaceId), eq(backups.status, 'succeeded')));

  return Number(row?.total ?? 0);
}
