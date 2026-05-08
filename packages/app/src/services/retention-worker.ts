import type { Db } from '../db';
import { expireDueBackups } from './backups';

export function startRetentionWorkerScaffold(db: Db) {
  const intervalMs = Number(Bun.env.RETENTION_WORKER_POLL_MS ?? 60_000);
  const timer = setInterval(() => {
    expireDueBackups(db).catch((error) => {
      const safeError = error instanceof Error ? error : new Error('Unknown retention worker error');
      console.error({ message: safeError.message, name: safeError.name });
    });
  }, intervalMs);

  return () => clearInterval(timer);
}
