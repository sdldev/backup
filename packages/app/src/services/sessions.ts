import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db';
import { sessions, users } from '../db';

export const SESSION_COOKIE_NAME = Bun.env.SESSION_COOKIE_NAME ?? 'backup_saas_session';

export type AuthenticatedSession = {
  sessionId: string;
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
  };
};

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function makeSessionCookie(token: string, maxAgeSeconds = 30 * 24 * 60 * 60) {
  const secure = Bun.env.SESSION_COOKIE_SECURE === 'true';
  const parts = [`${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

export function clearSessionCookie() {
  return makeSessionCookie('', 0);
}

export async function createSessionForUser(db: Db, userId: string, request: Request) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await hashSessionToken(token);
  await db.insert(sessions).values({
    userId,
    tokenHash,
    ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0] ?? null,
    userAgent: request.headers.get('user-agent'),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  await enforceActiveSessionLimit(db, userId);
  return token;
}

export async function enforceActiveSessionLimit(db: Db, userId: string, limit = 5) {
  const activeSessions = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.invalidatedAt), gt(sessions.expiresAt, new Date())))
    .orderBy(asc(sessions.lastActiveAt), asc(sessions.createdAt));

  const sessionsToInvalidate = activeSessions.slice(0, Math.max(0, activeSessions.length - limit));
  if (sessionsToInvalidate.length === 0) return;

  const now = new Date();
  for (const session of sessionsToInvalidate) {
    await db.update(sessions).set({ invalidatedAt: now }).where(eq(sessions.id, session.id));
  }
}

export async function invalidateSessionFromRequest(db: Db, request: Request) {
  const token = getCookieValue(request.headers.get('cookie'), SESSION_COOKIE_NAME);
  if (!token) return false;

  const tokenHash = await hashSessionToken(token);
  const result = await db
    .update(sessions)
    .set({ invalidatedAt: new Date() })
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.invalidatedAt)))
    .returning({ id: sessions.id });
  return result.length > 0;
}

export function getCookieValue(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey === name) return rawValue.join('=') || null;
  }

  return null;
}

export async function getSessionFromRequest(db: Db, request: Request): Promise<AuthenticatedSession | null> {
  const token = getCookieValue(request.headers.get('cookie'), SESSION_COOKIE_NAME);
  if (!token) return null;

  const tokenHash = await hashSessionToken(token);
  const now = new Date();

  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.invalidatedAt),
        gt(sessions.expiresAt, now),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);

  if (!row) return null;

  return {
    sessionId: row.sessionId,
    user: {
      id: row.userId,
      email: row.email,
      name: row.name,
      avatarUrl: row.avatarUrl,
    },
  };
}
