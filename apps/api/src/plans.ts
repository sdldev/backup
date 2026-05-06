import { createHash } from "node:crypto";
import { createSqlClient, getDatabaseUrl, getWorkspaceRetainedStorageBytes, resolveWorkspacePlanLimits } from "@mba/db";
import { Elysia } from "elysia";

type SqlClient = ReturnType<typeof createSqlClient>;

export type PlansConfig = {
  databaseUrl: string;
};

type SessionUser = {
  id: string;
};

type WorkspaceAccess = {
  id: string;
  role: string;
  planSlug: string;
};

const sessionCookieName = "mba_session";
const requestablePlans = new Set(["pro", "agency"]);

function defaultPlansConfig(partial: Partial<PlansConfig> = {}): PlansConfig {
  return { databaseUrl: partial.databaseUrl ?? getDatabaseUrl() };
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function parseJsonObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  return body as Record<string, unknown>;
}

async function withClient<T>(config: PlansConfig, run: (client: SqlClient) => Promise<T>): Promise<T> {
  const client = createSqlClient(config.databaseUrl);
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function getSessionUser(client: SqlClient, request: Request): Promise<SessionUser | null> {
  const sessionToken = readableCookie(request.headers.get("cookie"), sessionCookieName);
  if (!sessionToken) {
    return null;
  }

  const [session] = await client<{ user_id: string }[]>`
    select sessions.user_id
    from sessions
    inner join users on users.id = sessions.user_id
    where sessions.session_token_hash = ${hashValue(sessionToken)}
      and sessions.invalidated_at is null
      and sessions.expires_at > now()
      and users.disabled_at is null
    limit 1
  `;

  return session ? { id: session.user_id } : null;
}

async function requireSession(client: SqlClient, request: Request): Promise<SessionUser | Response> {
  const user = await getSessionUser(client, request);
  return user ?? jsonResponse({ error: { code: "auth.required" } }, { status: 401 });
}

async function selectWorkspaceAccess(client: SqlClient, userId: string, workspaceId: string): Promise<WorkspaceAccess | null> {
  const [workspace] = await client<WorkspaceAccess[]>`
    select workspaces.id,
      workspace_members.role::text as role,
      plans.slug::text as "planSlug"
    from workspaces
    inner join workspace_members on workspace_members.workspace_id = workspaces.id
    inner join plans on plans.id = workspaces.plan_id
    where workspace_members.user_id = ${userId}
      and workspaces.id = ${workspaceId}
      and workspaces.soft_deleted_at is null
    limit 1
  `;

  return workspace ?? null;
}

function canManagePlan(role: string): boolean {
  return role === "owner";
}

export function createPlanRoutes(partialConfig: Partial<PlansConfig> = {}) {
  const config = defaultPlansConfig(partialConfig);

  return new Elysia()
    .get("/workspaces/:workspaceId/plan", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const limits = await resolveWorkspacePlanLimits(client, workspace.id);
      if (!limits) {
        return jsonResponse({ error: { code: "plan.limits_missing" } }, { status: 500 });
      }

      const retainedStorageBytes = await getWorkspaceRetainedStorageBytes(client, workspace.id);
      return jsonResponse({ plan: { slug: workspace.planSlug, limits: { ...limits, retainedStorageBytesLimit: limits.retainedStorageBytesLimit.toString() }, retainedStorageBytes: retainedStorageBytes.toString() } });
    }))
    .post("/workspaces/:workspaceId/plan-requests", async ({ request, params, body }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (!canManagePlan(workspace.role)) {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const requestedPlan = parseJsonObject(body).requested_plan;
      if (typeof requestedPlan !== "string" || !requestablePlans.has(requestedPlan)) {
        return jsonResponse({ error: { code: "plan.request_invalid" } }, { status: 400 });
      }

      const [plan] = await client<{ id: string; slug: string }[]>`select id, slug::text from plans where slug = ${requestedPlan} limit 1`;
      if (!plan) {
        return jsonResponse({ error: { code: "plan.not_found" } }, { status: 404 });
      }

      try {
        const [created] = await client<{ id: string; status: string; created_at: Date }[]>`
          insert into plan_requests (workspace_id, requested_plan_id, requested_by_user_id, status)
          values (${workspace.id}, ${plan.id}, ${user.id}, 'pending')
          returning id, status::text, created_at
        `;
        if (!created) {
          throw new Error("plan_request.create_failed");
        }
        return jsonResponse({ planRequest: { id: created.id, workspaceId: workspace.id, requestedPlan: plan.slug, status: created.status, createdAt: created.created_at.toISOString() } }, { status: 201 });
      } catch (error) {
        if (String(error).includes("plan_requests_one_pending_per_workspace_idx")) {
          return jsonResponse({ error: { code: "plan_request_pending_exists" } }, { status: 409 });
        }
        throw error;
      }
    }))
    .get("/workspaces/:workspaceId/plan-requests", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const rows = await client<{ id: string; requested_plan: string; status: string; created_at: Date }[]>`
        select plan_requests.id,
          plans.slug::text as requested_plan,
          plan_requests.status::text as status,
          plan_requests.created_at
        from plan_requests
        inner join plans on plans.id = plan_requests.requested_plan_id
        where plan_requests.workspace_id = ${workspace.id}
        order by plan_requests.created_at desc
      `;

      return jsonResponse({ planRequests: rows.map((row) => ({ id: row.id, requestedPlan: row.requested_plan, status: row.status, createdAt: row.created_at.toISOString() })) });
    }))
    .post("/workspaces/:workspaceId/plan-requests/:requestId/cancel", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (!canManagePlan(workspace.role)) {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const [updated] = await client<{ id: string }[]>`
        update plan_requests
        set status = 'cancelled', reviewed_at = now()
        where id = ${params.requestId}
          and workspace_id = ${workspace.id}
          and status = 'pending'
        returning id
      `;

      return updated ? jsonResponse({ ok: true }) : jsonResponse({ error: { code: "plan_request.not_found" } }, { status: 404 });
    }));
}
