import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createSqlClient, applySqlFile, seedPlans } from "@mba/db";
import { createApi } from "../src/index";
import type { OAuthIdentity, OAuthProvider } from "../src/auth";
import { resetRateLimitsForTests } from "../src/rate-limit";
import { ensureTestDatabase, resetPublicSchema, resolveDatabaseUrl } from "../../../scripts/db/_test-db";

const databaseUrl = resolveDatabaseUrl();

const identities: Record<string, OAuthIdentity> = {
  "google:google-ok": {
    provider: "google",
    providerAccountId: "acct-shared-email",
    email: "linked@example.com",
    emailVerified: true,
    name: "Linked User"
  },
  "github:github-ok": {
    provider: "github",
    providerAccountId: "acct-github-same-email",
    email: "linked@example.com",
    emailVerified: true,
    name: "Linked User GitHub"
  },
  "google:unverified": {
    provider: "google",
    providerAccountId: "acct-unverified",
    email: "private@example.com",
    emailVerified: false,
    name: "Private Email"
  }
};

function resolveOAuthIdentity(provider: OAuthProvider, code: string): OAuthIdentity {
  const identity = identities[`${provider}:${code}`];
  if (!identity) {
    throw new Error("unknown test identity");
  }

  return identity;
}

async function resetDb() {
  await ensureTestDatabase();
  await resetPublicSchema(databaseUrl);
  await applySqlFile("0001_initial.sql", databaseUrl);
  await seedPlans(databaseUrl);
}

async function seedWorkspace(email: string) {
  const client = createSqlClient(databaseUrl);
  try {
    const [plan] = await client<{ id: string }[]>`select id from plans where slug = 'basic' limit 1`;
    const [user] = await client<{ id: string }[]>`
      insert into users (email, name)
      values (${email}, 'Existing Owner')
      returning id
    `;
    const [workspace] = await client<{ id: string }[]>`
      insert into workspaces (name, slug, timezone, plan_id, storage_status, onboarding_step)
      values ('Linked Workspace', 'linked_ws', 'UTC', ${plan.id}, 'ready', 'complete')
      returning id
    `;
    await client`insert into workspace_members (workspace_id, user_id, role) values (${workspace.id}, ${user.id}, 'owner')`;
  } finally {
    await client.end();
  }
}

function app() {
  return createApi({ auth: { databaseUrl, nodeEnv: "production", resolveOAuthIdentity } });
}

function cookieJar(headers: Headers): string {
  return headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

async function start(provider: OAuthProvider, returnTo: string) {
  const response = await app().handle(new Request(`http://localhost/v1/auth/${provider}/start?return_to=${encodeURIComponent(returnTo)}`));
  const location = response.headers.get("location") ?? "";
  const state = new URL(location, "http://localhost").searchParams.get("state") ?? "";

  return { response, state, cookie: cookieJar(response.headers) };
}

describe("auth.verified oauth flow", () => {
  test("verified OAuth creates session cookie and exposes session", async () => {
    await resetDb();
    await seedWorkspace("linked@example.com");
    const started = await start("google", "/dashboard");

    const callback = await app().handle(new Request(`http://localhost/v1/auth/google/callback?code=google-ok&state=${started.state}`, {
      headers: { cookie: started.cookie }
    }));

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/dashboard");
    const setCookies = callback.headers.getSetCookie().join("\n");
    expect(setCookies).toContain("mba_session=");
    expect(setCookies).toContain("HttpOnly");
    expect(setCookies).toContain("Secure");
    expect(setCookies).toContain("SameSite=Lax");

    const sessionCookie = cookieJar(callback.headers);
    const session = await app().handle(new Request("http://localhost/v1/session", { headers: { cookie: sessionCookie } }));
    const body = await session.json() as { user: { email: string }; memberships: { workspaceSlug: string }[] };

    expect(session.status).toBe(200);
    expect(body.user.email).toBe("linked@example.com");
    expect(body.memberships).toEqual([{ workspaceId: expect.any(String), role: "owner", workspaceSlug: "linked_ws", workspaceName: "Linked Workspace" }]);
  });

  test("verified email links Google and GitHub to one user", async () => {
    await resetDb();
    const google = await start("google", "/");
    await app().handle(new Request(`http://localhost/v1/auth/google/callback?code=google-ok&state=${google.state}`, {
      headers: { cookie: google.cookie }
    }));
    const github = await start("github", "/");
    await app().handle(new Request(`http://localhost/v1/auth/github/callback?code=github-ok&state=${github.state}`, {
      headers: { cookie: github.cookie }
    }));

    const client = createSqlClient(databaseUrl);
    try {
      const [counts] = await client<{ users: string; accounts: string; distinct_users: string }[]>`
        select count(*)::text as users,
          (select count(*)::text from oauth_accounts) as accounts,
          (select count(distinct user_id)::text from oauth_accounts) as distinct_users
        from users
      `;
      expect(counts).toEqual({ users: "1", accounts: "2", distinct_users: "1" });
    } finally {
      await client.end();
    }
  });

  test("unverified OAuth email returns sanitized 403", async () => {
    await resetDb();
    const started = await start("google", "/dashboard");
    const response = await app().handle(new Request(`http://localhost/v1/auth/google/callback?code=unverified&state=${started.state}`, {
      headers: { cookie: started.cookie }
    }));
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: { code: "oauth.email_unverified" } });
    expect(JSON.stringify(body)).not.toContain("private@example.com");
  });

  test("excessive auth start requests return 429 safe shape", async () => {
    await resetDb();
    resetRateLimitsForTests();
    const limitedApp = createApi({ auth: { databaseUrl, nodeEnv: "production", resolveOAuthIdentity, rateLimit: { max: 1, windowMs: 60_000 } } });

    const first = await limitedApp.handle(new Request("http://localhost/v1/auth/google/start?return_to=%2F"));
    const second = await limitedApp.handle(new Request("http://localhost/v1/auth/google/start?return_to=%2F"));
    const body = await second.json() as { error: { code: string } };

    expect(first.status).toBe(302);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
    expect(body).toEqual({ error: { code: "rate_limit.exceeded" } });
  });

  test("return_to rejects external redirects", async () => {
    await resetDb();
    const started = await start("google", "https://evil.example/phish");
    const response = await app().handle(new Request(`http://localhost/v1/auth/google/callback?code=google-ok&state=${started.state}`, {
      headers: { cookie: started.cookie }
    }));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
  });

  test("logout requires csrf and invalidates session", async () => {
    await resetDb();
    const started = await start("google", "/");
    const callback = await app().handle(new Request(`http://localhost/v1/auth/google/callback?code=google-ok&state=${started.state}`, {
      headers: { cookie: started.cookie }
    }));
    const cookies = cookieJar(callback.headers);
    const csrfToken = cookies.match(/mba_csrf=([^;]+)/)?.[1] ?? "";

    const blocked = await app().handle(new Request("http://localhost/v1/auth/logout", { method: "POST", headers: { cookie: cookies } }));
    expect(blocked.status).toBe(403);

    const logout = await app().handle(new Request("http://localhost/v1/auth/logout", {
      method: "POST",
      headers: { cookie: cookies, "x-csrf-token": csrfToken }
    }));
    expect(logout.status).toBe(200);

    const sessionToken = cookies.match(/mba_session=([^;]+)/)?.[1] ?? "";
    const client = createSqlClient(databaseUrl);
    try {
      const [row] = await client<{ invalidated: boolean }[]>`
        select invalidated_at is not null as invalidated
        from sessions
        where session_token_hash = ${createHash("sha256").update(sessionToken).digest("hex")}
      `;
      expect(row.invalidated).toBeTrue();
    } finally {
      await client.end();
    }
  });
});
