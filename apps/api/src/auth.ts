import { createHash, randomBytes } from "node:crypto";
import { createSqlClient, getDatabaseUrl } from "@mba/db";
import { assertCsrfPolicy } from "@mba/security";
import { routeName } from "@mba/shared";
import { Elysia } from "elysia";
import { checkRateLimit, clientIp, rateLimitKey, rateLimitResponse, type RateLimitConfig } from "./rate-limit";

export type OAuthProvider = "google" | "github";

export type OAuthIdentity = {
  provider: OAuthProvider;
  providerAccountId: string;
  email: string | null;
  emailVerified: boolean;
  name: string;
  avatarUrl?: string | null;
};

export type AuthConfig = {
  databaseUrl: string;
  nodeEnv: string;
  sessionDays: number;
  rateLimit?: Partial<RateLimitConfig>;
  resolveOAuthIdentity: (provider: OAuthProvider, code: string) => Promise<OAuthIdentity> | OAuthIdentity;
};

type SqlClient = ReturnType<typeof createSqlClient>;

const sessionCookieName = "mba_session";
const csrfCookieName = "mba_csrf";
const oauthStateCookiePrefix = "mba_oauth_state_";
const providerSet = new Set<OAuthProvider>(["google", "github"]);

function defaultAuthConfig(partial: Partial<AuthConfig> = {}): AuthConfig {
  return {
    databaseUrl: partial.databaseUrl ?? getDatabaseUrl(),
    nodeEnv: partial.nodeEnv ?? process.env.NODE_ENV ?? "development",
    sessionDays: partial.sessionDays ?? 7,
    ...(partial.rateLimit ? { rateLimit: partial.rateLimit } : {}),
    resolveOAuthIdentity: partial.resolveOAuthIdentity ?? (() => {
      throw new Error("OAuth provider resolver is not configured");
    })
  };
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sanitizeReturnTo(value: string | null): string {
  if (!value) {
    return "/";
  }

  if (!value.startsWith("/") || value.startsWith("//") || /[\r\n]/u.test(value)) {
    return "/";
  }

  return value;
}

function cookieAttributes(config: AuthConfig, maxAgeSeconds: number): string {
  const secure = config.nodeEnv === "production" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function readableCookie(value: string | null, name: string): string | null {
  if (!value) {
    return null;
  }

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.match(new RegExp(`(?:^|; )${escaped}=([^;]+)`))?.[1] ?? null;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers
    }
  });
}

function redirectResponse(location: string, cookies: string[]): Response {
  const headers = new Headers({ location });
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }

  return new Response(null, { status: 302, headers });
}

async function upsertUserAndAccount(client: SqlClient, identity: OAuthIdentity): Promise<{ id: string; email: string; name: string }> {
  const email = identity.email?.toLowerCase();
  if (!email || !identity.emailVerified) {
    throw new Error("oauth.email_unverified");
  }

  const existingAccount = await client<{ id: string; email: string; name: string }[]>`
    select users.id, users.email, users.name
    from oauth_accounts
    inner join users on users.id = oauth_accounts.user_id
    where oauth_accounts.provider = ${identity.provider} and oauth_accounts.provider_account_id = ${identity.providerAccountId}
    limit 1
  `;

  if (existingAccount[0]) {
    await client`update users set last_login_at = now(), updated_at = now() where id = ${existingAccount[0].id}`;
    return existingAccount[0];
  }

  const [user] = await client<{ id: string; email: string; name: string }[]>`
    insert into users (email, name, avatar_url, last_login_at)
    values (${email}, ${identity.name}, ${identity.avatarUrl ?? null}, now())
    on conflict (email) do update set last_login_at = now(), updated_at = now()
    returning id, email, name
  `;

  if (!user) {
    throw new Error("oauth.user_upsert_failed");
  }

  await client`
    insert into oauth_accounts (user_id, provider, provider_account_id, provider_email)
    values (${user.id}, ${identity.provider}, ${identity.providerAccountId}, ${email})
    on conflict (provider, provider_account_id) do nothing
  `;

  return user;
}

async function createSession(client: SqlClient, config: AuthConfig, userId: string, request: Request): Promise<{ sessionToken: string; csrfToken: string }> {
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const expiresDays = config.sessionDays;
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = request.headers.get("user-agent");

  await client`
    insert into sessions (user_id, session_token_hash, csrf_token_hash, expires_at, created_ip, user_agent)
    values (${userId}, ${hashValue(sessionToken)}, ${hashValue(csrfToken)}, now() + (${`${expiresDays} days`})::interval, ${ip}, ${userAgent})
  `;

  return { sessionToken, csrfToken };
}

async function getSessionPayload(client: SqlClient, sessionToken: string) {
  const [session] = await client<{ id: string; user_id: string; email: string; name: string; avatar_url: string | null; csrf_token_hash: string }[]>`
    select sessions.id, sessions.user_id, users.email, users.name, users.avatar_url, sessions.csrf_token_hash
    from sessions
    inner join users on users.id = sessions.user_id
    where sessions.session_token_hash = ${hashValue(sessionToken)}
      and sessions.invalidated_at is null
      and sessions.expires_at > now()
      and users.disabled_at is null
    limit 1
  `;

  if (!session) {
    return null;
  }

  await client`update sessions set last_seen_at = now(), updated_at = now() where id = ${session.id}`;

  const memberships = await client<{ workspaceId: string; role: string; workspaceSlug: string; workspaceName: string }[]>`
    select workspace_members.workspace_id as "workspaceId", workspace_members.role, workspaces.slug as "workspaceSlug", workspaces.name as "workspaceName"
    from workspace_members
    inner join workspaces on workspaces.id = workspace_members.workspace_id
    where workspace_members.user_id = ${session.user_id} and workspaces.soft_deleted_at is null
    order by workspaces.created_at asc
  `;

  return {
    sessionId: session.id,
    csrfTokenHash: session.csrf_token_hash,
    user: {
      id: session.user_id,
      email: session.email,
      name: session.name,
      avatarUrl: session.avatar_url
    },
    memberships
  };
}

async function withClient<T>(config: AuthConfig, run: (client: SqlClient) => Promise<T>): Promise<T> {
  const client = createSqlClient(config.databaseUrl);
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export function createAuthRoutes(partialConfig: Partial<AuthConfig> = {}) {
  const config = defaultAuthConfig(partialConfig);

  return new Elysia()
    .get("/auth/:provider/start", async ({ params, query }) => {
        const limited = checkRateLimit("auth", rateLimitKey(["start", params.provider, "anonymous"]), config.rateLimit);
        if (!limited.ok) {
          return rateLimitResponse(limited.retryAfterSeconds);
        }

        const provider = params.provider as OAuthProvider;
        if (!providerSet.has(provider)) {
          return jsonResponse({ error: { code: "oauth.provider_unsupported" } }, { status: 404 });
        }

        const stateToken = randomToken();
        const returnTo = sanitizeReturnTo(query.return_to ?? null);
        const state = Buffer.from(JSON.stringify({ token: stateToken, returnTo })).toString("base64url");
        return redirectResponse(`/oauth/mock/${provider}?state=${encodeURIComponent(state)}`, [
          `${oauthStateCookiePrefix}${provider}=${stateToken}; ${cookieAttributes(config, 300)}`
        ]);
      })
    .get("/auth/:provider/callback", async ({ params, query, request }) => {
        const limited = checkRateLimit("auth", rateLimitKey(["callback", params.provider, clientIp(request)]), config.rateLimit);
        if (!limited.ok) {
          return rateLimitResponse(limited.retryAfterSeconds);
        }

        const provider = params.provider as OAuthProvider;
        if (!providerSet.has(provider)) {
          return jsonResponse({ error: { code: "oauth.provider_unsupported" } }, { status: 404 });
        }

        const stateValue = query.state ?? "";
        const stateCookie = readableCookie(request.headers.get("cookie"), `${oauthStateCookiePrefix}${provider}`);
        let returnTo = "/";
        let token = "";

        try {
          const parsed = JSON.parse(Buffer.from(stateValue, "base64url").toString("utf8")) as { token?: string; returnTo?: string };
          token = parsed.token ?? "";
          returnTo = sanitizeReturnTo(parsed.returnTo ?? null);
        } catch {
          return jsonResponse({ error: { code: "oauth.state_invalid" } }, { status: 400 });
        }

        try {
          assertCsrfPolicy({
            method: "GET",
            routeName: routeName(`auth.${provider}.callback`),
            authKind: "cookie",
            hasCsrfToken: false,
            hasOAuthState: Boolean(stateCookie && token && stateCookie === token)
          });
        } catch {
          return jsonResponse({ error: { code: "oauth.state_invalid" } }, { status: 400 });
        }

        const identity = await config.resolveOAuthIdentity(provider, query.code ?? "");
        if (!identity.email || !identity.emailVerified) {
          return jsonResponse({ error: { code: "oauth.email_unverified" } }, { status: 403 });
        }

        return withClient(config, async (client) => {
          const user = await upsertUserAndAccount(client, identity);
          const session = await createSession(client, config, user.id, request);
          const maxAge = config.sessionDays * 24 * 60 * 60;
          return redirectResponse(returnTo, [
            `${sessionCookieName}=${session.sessionToken}; ${cookieAttributes(config, maxAge)}`,
            `${csrfCookieName}=${session.csrfToken}; ${cookieAttributes(config, maxAge)}`,
            `${oauthStateCookiePrefix}${provider}=; ${cookieAttributes(config, 0)}`
          ]);
        });
      })
    .get("/session", async ({ request }) => {
        const sessionToken = readableCookie(request.headers.get("cookie"), sessionCookieName);
        if (!sessionToken) {
          return jsonResponse({ user: null, memberships: [] }, { status: 401 });
        }

        return withClient(config, async (client) => {
          const payload = await getSessionPayload(client, sessionToken);
          if (!payload) {
            return jsonResponse({ user: null, memberships: [] }, { status: 401 });
          }

          return jsonResponse({ user: payload.user, memberships: payload.memberships });
        });
      })
    .post("/auth/logout", async ({ request }) => {
        const sessionToken = readableCookie(request.headers.get("cookie"), sessionCookieName);
        const csrfToken = request.headers.get("x-csrf-token");

        if (!sessionToken) {
          return jsonResponse({ ok: true }, { status: 200, headers: { "set-cookie": `${sessionCookieName}=; ${cookieAttributes(config, 0)}` } });
        }

        return withClient(config, async (client) => {
          const payload = await getSessionPayload(client, sessionToken);
          try {
            assertCsrfPolicy({
              method: "POST",
              routeName: routeName("auth.logout"),
              authKind: "cookie",
              hasCsrfToken: Boolean(payload && csrfToken && hashValue(csrfToken) === payload.csrfTokenHash),
              hasOAuthState: false
            });
          } catch {
            return jsonResponse({ error: { code: "csrf.required" } }, { status: 403 });
          }

          await client`update sessions set invalidated_at = now(), updated_at = now() where session_token_hash = ${hashValue(sessionToken)}`;
          const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
          headers.append("set-cookie", `${sessionCookieName}=; ${cookieAttributes(config, 0)}`);
          headers.append("set-cookie", `${csrfCookieName}=; ${cookieAttributes(config, 0)}`);
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
        });
      });
}
