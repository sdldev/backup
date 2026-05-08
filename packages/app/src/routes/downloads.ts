import { and, eq, gt } from 'drizzle-orm';
import { Elysia } from 'elysia';
import type { Db } from '../db';
import { backups, downloadRequests } from '../db';
import { writeAuditEvent } from '../services/audit';
import { decryptBackupArtifactObjectStream } from '../services/backup-artifact-crypto';
import { createObjectStorageProvider } from '../services/object-storage';
import { getSessionFromRequest } from '../services/sessions';

type DownloadRoutesOptions = { db: Db };

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Buffer.from(digest).toString('base64url');
}

export function downloadRoutes({ db }: DownloadRoutesOptions) {
  return new Elysia({ prefix: '/v1/downloads' }).get('/:token', async ({ params, request, status }) => {
    const session = await getSessionFromRequest(db, request);
    if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

    const tokenHash = await hashToken(params.token);
    const [downloadRequest] = await db
      .select()
      .from(downloadRequests)
      .where(
        and(
          eq(downloadRequests.tokenHash, tokenHash),
          eq(downloadRequests.requestedByUserId, session.user.id),
          eq(downloadRequests.sessionId, session.sessionId),
          eq(downloadRequests.status, 'created'),
          gt(downloadRequests.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!downloadRequest) {
      return status(404, { error: { code: 'DOWNLOAD_TOKEN_INVALID', message: 'Download link is invalid or expired' } });
    }

    const [backup] = await db.select().from(backups).where(eq(backups.id, downloadRequest.backupId)).limit(1);
    if (!backup || backup.status !== 'succeeded') {
      return status(404, { error: { code: 'DOWNLOAD_TOKEN_INVALID', message: 'Download link is invalid or expired' } });
    }

    const storage = createObjectStorageProvider();
    const plaintextStream = decryptBackupArtifactObjectStream(await storage.getObject(backup.objectKey));
    const now = new Date();
    await db
      .update(downloadRequests)
      .set({ status: 'used', usedAt: now })
      .where(eq(downloadRequests.id, downloadRequest.id));

    await writeAuditEvent(db, {
      workspaceId: downloadRequest.workspaceId,
      eventType: 'backup.download_started',
      actor: { type: 'user', userId: session.user.id },
      resourceType: 'backup',
      resourceId: downloadRequest.backupId,
      metadata: {},
    });

    return new Response(plaintextStream, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${backup.downloadFilename.replaceAll('"', '')}"`,
      },
    });
  });
}
