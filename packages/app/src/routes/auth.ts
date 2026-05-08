import { and, eq } from 'drizzle-orm';
import { Elysia } from 'elysia';
import type { Db } from '../db';
import { oauthAccounts, users } from '../db';
import { writeAuditEvent } from '../services/audit';
import { createSessionForUser, makeSessionCookie } from '../services/sessions';

const OAUTH_STATE_COOKIE = 'backup_saas_oauth_state';

function getBaseUrl() {
  return Bun.env.OAUTH_REDIRECT_BASE_URL ?? 'http://localhost:3000';
}

function getWebBaseUrl() {
  return Bun.env.WEB_BASE_URL ?? 'http://localhost:4321';
}

function getGoogleCallbackUrl() {
  return `${getBaseUrl()}/v1/auth/google/callback/`;
}

function getGitHubCallbackUrl() {
  return `${getBaseUrl()}/v1/auth/github/callback`;
}

export function safeReturnTo(value: string | null) {
  if (!value) return '/app';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('://')) return '/app';
  return value;
}

function setCookie(name: string, value: string, options: { maxAge?: number } = {}) {
  const secure = Bun.env.SESSION_COOKIE_SECURE === 'true';
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join('; ');
}

function getCookie(request: Request, name: string) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rawValue] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rawValue.join('='));
  }
  return null;
}

async function hmacSha256Base64Url(input: string) {
  const keyMaterial = Buffer.from(Bun.env.APP_MASTER_KEY_V1 ?? '', 'base64url');
  if (keyMaterial.length !== 32) throw new Error('APP_MASTER_KEY_V1 must decode to 32 bytes');
  const key = await crypto.subtle.importKey('raw', keyMaterial, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return Buffer.from(signature).toString('base64url');
}

export async function createOAuthState(returnTo: string) {
  const nonce = crypto.randomUUID();
  const safePath = safeReturnTo(returnTo);
  const payload = `${nonce}.${Buffer.from(safePath).toString('base64url')}`;
  const signature = await hmacSha256Base64Url(payload);
  return { cookieValue: nonce, state: `${payload}.${signature}` };
}

export async function verifyOAuthState(stateParam: unknown, cookieValue: string | null) {
  if (!cookieValue || typeof stateParam !== 'string') return null;
  const parts = stateParam.split('.');
  if (parts.length !== 3) return null;
  const nonce = parts[0];
  const returnToEncoded = parts[1];
  const signature = parts[2];
  if (!nonce || !returnToEncoded || !signature || nonce !== cookieValue) return null;
  const payload = `${nonce}.${returnToEncoded}`;
  const expectedSignature = await hmacSha256Base64Url(payload);
  if (signature !== expectedSignature) return null;
  return safeReturnTo(Buffer.from(returnToEncoded, 'base64url').toString('utf8'));
}

async function upsertOAuthUser(db: Db, input: { provider: 'github' | 'google'; providerAccountId: string; email: string; name: string; avatarUrl?: string | null }) {
  const [existingAccount] = await db
    .select()
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.provider, input.provider), eq(oauthAccounts.providerAccountId, input.providerAccountId)))
    .limit(1);
  if (existingAccount) {
    const [user] = await db.select().from(users).where(eq(users.id, existingAccount.userId)).limit(1);
    if (!user) throw new Error('OAuth account user missing');
    return user;
  }

  const [user] = await db
    .insert(users)
    .values({ email: input.email, name: input.name, avatarUrl: input.avatarUrl ?? null, lastLoginAt: new Date() })
    .onConflictDoUpdate({ target: users.email, set: { name: input.name, avatarUrl: input.avatarUrl ?? null, lastLoginAt: new Date(), updatedAt: new Date() } })
    .returning();
  if (!user) throw new Error('User create failed');

  await db
    .insert(oauthAccounts)
    .values({ userId: user.id, provider: input.provider, providerAccountId: input.providerAccountId, providerEmail: input.email })
    .onConflictDoNothing();

  return user;
}

async function fetchGitHubProfile(code: string) {
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: Bun.env.GITHUB_CLIENT_ID,
      client_secret: Bun.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: getGitHubCallbackUrl(),
    }),
  });
  const tokenPayload = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenPayload.access_token) throw new Error('GitHub token exchange failed');

  const [profileResponse, emailsResponse] = await Promise.all([
    fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${tokenPayload.access_token}`, accept: 'application/vnd.github+json' } }),
    fetch('https://api.github.com/user/emails', { headers: { authorization: `Bearer ${tokenPayload.access_token}`, accept: 'application/vnd.github+json' } }),
  ]);
  const profile = (await profileResponse.json()) as { id: number; name?: string | null; login: string; avatar_url?: string | null };
  const emails = (await emailsResponse.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
  const email = emails.find((item) => item.primary && item.verified)?.email ?? emails.find((item) => item.verified)?.email;
  if (!email) throw new Error('AUTH_EMAIL_NOT_VERIFIED');

  return { provider: 'github' as const, providerAccountId: String(profile.id), email, name: profile.name ?? profile.login, avatarUrl: profile.avatar_url ?? null };
}

async function fetchGoogleProfile(code: string) {
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Bun.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: Bun.env.GOOGLE_CLIENT_SECRET ?? '',
      code,
      redirect_uri: getGoogleCallbackUrl(),
      grant_type: 'authorization_code',
    }),
  });
  const tokenPayload = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenPayload.access_token) throw new Error('Google token exchange failed');

  const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${tokenPayload.access_token}` },
  });
  const profile = (await profileResponse.json()) as { sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
  if (!profile.email || !profile.email_verified) throw new Error('AUTH_EMAIL_NOT_VERIFIED');

  return { provider: 'google' as const, providerAccountId: profile.sub, email: profile.email, name: profile.name ?? profile.email, avatarUrl: profile.picture ?? null };
}

export function authRoutes({ db }: { db: Db }) {
  return new Elysia({ prefix: '/v1/auth' })
    .get('/github/start', async ({ query }) => {
      const returnTo = safeReturnTo(typeof query.return_to === 'string' ? query.return_to : null);
      const { cookieValue, state } = await createOAuthState(returnTo);
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', Bun.env.GITHUB_CLIENT_ID ?? '');
      url.searchParams.set('redirect_uri', getGitHubCallbackUrl());
      url.searchParams.set('scope', 'read:user user:email');
      url.searchParams.set('state', state);
      return new Response(null, { status: 302, headers: { location: url.toString(), 'set-cookie': setCookie(OAUTH_STATE_COOKIE, cookieValue, { maxAge: 600 }) } });
    })
    .get('/google/start', async ({ query }) => {
      const returnTo = safeReturnTo(typeof query.return_to === 'string' ? query.return_to : null);
      const { cookieValue, state } = await createOAuthState(returnTo);
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('client_id', Bun.env.GOOGLE_CLIENT_ID ?? '');
      url.searchParams.set('redirect_uri', getGoogleCallbackUrl());
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('state', state);
      return new Response(null, { status: 302, headers: { location: url.toString(), 'set-cookie': setCookie(OAUTH_STATE_COOKIE, cookieValue, { maxAge: 600 }) } });
    })
    .get('/github/callback', async ({ query, request }) => handleCallback(db, request, query.code, query.state, fetchGitHubProfile))
    .get('/google/callback', async ({ query, request }) => handleCallback(db, request, query.code, query.state, fetchGoogleProfile))
    .get('/google/callback/', async ({ query, request }) => handleCallback(db, request, query.code, query.state, fetchGoogleProfile));
}

async function handleCallback(
  db: Db,
  request: Request,
  code: unknown,
  stateParam: unknown,
  fetchProfile: (code: string) => Promise<{ provider: 'github' | 'google'; providerAccountId: string; email: string; name: string; avatarUrl?: string | null }>,
) {
  const returnTo = await verifyOAuthState(stateParam, getCookie(request, OAUTH_STATE_COOKIE));
  if (!returnTo || typeof code !== 'string') return Response.redirect(`${getWebBaseUrl()}/login?error=oauth_state`, 302);

  try {
    const profile = await fetchProfile(code);
    const user = await upsertOAuthUser(db, profile);
    const token = await createSessionForUser(db, user.id, request);
    await writeAuditEvent(db, { workspaceId: null, eventType: 'auth.login', actor: { type: 'user', userId: user.id }, resourceType: 'user', resourceId: user.id, metadata: { provider: profile.provider } });
    const headers = new Headers({ location: `${getWebBaseUrl()}${returnTo}` });
    headers.append('set-cookie', makeSessionCookie(token));
    headers.append('set-cookie', setCookie(OAUTH_STATE_COOKIE, '', { maxAge: 0 }));
    return new Response(null, { status: 302, headers });
  } catch (error) {
    const message = error instanceof Error && error.message === 'AUTH_EMAIL_NOT_VERIFIED' ? 'email_not_verified' : 'oauth_failed';
    return Response.redirect(`${getWebBaseUrl()}/login?error=${message}`, 302);
  }
}
