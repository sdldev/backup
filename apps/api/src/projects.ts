import { createHash } from "node:crypto";
import { createSqlClient, getDatabaseUrl } from "@mba/db";
import { Elysia } from "elysia";

type SqlClient = ReturnType<typeof createSqlClient>;

export type ProjectsConfig = {
  databaseUrl: string;
};

type SessionUser = { id: string };
type WorkspaceAccess = { id: string; role: string };
type ProjectRow = { id: string; workspaceId: string; name: string; websiteUrl: string | null; createdAt: Date; updatedAt: Date; softDeletedAt: Date | null };

const sessionCookieName = "mba_session";

function defaultProjectsConfig(partial: Partial<ProjectsConfig> = {}): ProjectsConfig {
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
    headers: { "content-type": "application/json; charset=utf-8", ...init.headers }
  });
}

function parseJsonObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  return body as Record<string, unknown>;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 120 ? trimmed : null;
}

function cleanWebsiteUrl(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > 2048) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function withClient<T>(config: ProjectsConfig, run: (client: SqlClient) => Promise<T>): Promise<T> {
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
      workspace_members.role::text as role
    from workspaces
    inner join workspace_members on workspace_members.workspace_id = workspaces.id
    where workspace_members.user_id = ${userId}
      and workspaces.id = ${workspaceId}
      and workspaces.soft_deleted_at is null
    limit 1
  `;

  return workspace ?? null;
}

function canManageProjects(role: string): boolean {
  return role === "owner" || role === "admin";
}

function serializeProject(row: ProjectRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    websiteUrl: row.websiteUrl,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deleted: row.softDeletedAt !== null
  };
}

async function selectProject(client: SqlClient, workspaceId: string, projectId: string, includeDeleted = false): Promise<ProjectRow | null> {
  const [project] = await client<ProjectRow[]>`
    select id,
      workspace_id as "workspaceId",
      name,
      website_url as "websiteUrl",
      created_at as "createdAt",
      updated_at as "updatedAt",
      soft_deleted_at as "softDeletedAt"
    from projects
    where id = ${projectId}
      and workspace_id = ${workspaceId}
      and (${includeDeleted}::boolean or soft_deleted_at is null)
    limit 1
  `;

  return project ?? null;
}

export function createProjectRoutes(partialConfig: Partial<ProjectsConfig> = {}) {
  const config = defaultProjectsConfig(partialConfig);

  return new Elysia()
    .get("/workspaces/:workspaceId/projects", async ({ request, params, query }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const includeDeleted = query.include_deleted === "true";
      const rows = await client<ProjectRow[]>`
        select id,
          workspace_id as "workspaceId",
          name,
          website_url as "websiteUrl",
          created_at as "createdAt",
          updated_at as "updatedAt",
          soft_deleted_at as "softDeletedAt"
        from projects
        where workspace_id = ${workspace.id}
          and (${includeDeleted}::boolean or soft_deleted_at is null)
        order by created_at asc
      `;

      return jsonResponse({ projects: rows.map(serializeProject) });
    }))
    .post("/workspaces/:workspaceId/projects", async ({ request, params, body }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (!canManageProjects(workspace.role)) {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const payload = parseJsonObject(body);
      const name = cleanName(payload.name);
      if (!name) {
        return jsonResponse({ error: { code: "project.name_required" } }, { status: 400 });
      }
      const websiteUrl = cleanWebsiteUrl(payload.website_url ?? payload.websiteUrl);
      if (websiteUrl === undefined) {
        return jsonResponse({ error: { code: "project.website_url_invalid" } }, { status: 400 });
      }

      try {
        const [created] = await client<ProjectRow[]>`
          insert into projects (workspace_id, name, website_url, created_by_user_id)
          values (${workspace.id}, ${name}, ${websiteUrl}, ${user.id})
          returning id, workspace_id as "workspaceId", name, website_url as "websiteUrl", created_at as "createdAt", updated_at as "updatedAt", soft_deleted_at as "softDeletedAt"
        `;
        if (!created) {
          throw new Error("project.create_failed");
        }
        return jsonResponse({ project: serializeProject(created) }, { status: 201 });
      } catch (error) {
        if (String(error).includes("projects_active_name_per_workspace_idx")) {
          return jsonResponse({ error: { code: "project.name_exists" } }, { status: 409 });
        }
        throw error;
      }
    }))
    .get("/workspaces/:workspaceId/projects/:projectId", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }

      const project = await selectProject(client, workspace.id, params.projectId);
      return project ? jsonResponse({ project: serializeProject(project) }) : jsonResponse({ error: { code: "project.not_found" } }, { status: 404 });
    }))
    .patch("/workspaces/:workspaceId/projects/:projectId", async ({ request, params, body }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (!canManageProjects(workspace.role)) {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const existing = await selectProject(client, workspace.id, params.projectId);
      if (!existing) {
        return jsonResponse({ error: { code: "project.not_found" } }, { status: 404 });
      }

      const payload = parseJsonObject(body);
      const name = Object.hasOwn(payload, "name") ? cleanName(payload.name) : existing.name;
      if (!name) {
        return jsonResponse({ error: { code: "project.name_required" } }, { status: 400 });
      }
      const websiteUrl = Object.hasOwn(payload, "website_url") || Object.hasOwn(payload, "websiteUrl") ? cleanWebsiteUrl(payload.website_url ?? payload.websiteUrl) : existing.websiteUrl;
      if (websiteUrl === undefined) {
        return jsonResponse({ error: { code: "project.website_url_invalid" } }, { status: 400 });
      }

      try {
        await client`
          update projects
          set name = ${name}, website_url = ${websiteUrl}, updated_at = now()
          where id = ${existing.id}
            and workspace_id = ${workspace.id}
            and soft_deleted_at is null
        `;
      } catch (error) {
        if (String(error).includes("projects_active_name_per_workspace_idx")) {
          return jsonResponse({ error: { code: "project.name_exists" } }, { status: 409 });
        }
        throw error;
      }

      const updated = await selectProject(client, workspace.id, existing.id);
      return updated ? jsonResponse({ project: serializeProject(updated) }) : jsonResponse({ error: { code: "project.not_found" } }, { status: 404 });
    }))
    .delete("/workspaces/:workspaceId/projects/:projectId", async ({ request, params }) => withClient(config, async (client) => {
      const user = await requireSession(client, request);
      if (user instanceof Response) {
        return user;
      }

      const workspace = await selectWorkspaceAccess(client, user.id, params.workspaceId);
      if (!workspace) {
        return jsonResponse({ error: { code: "workspace.not_found" } }, { status: 404 });
      }
      if (!canManageProjects(workspace.role)) {
        return jsonResponse({ error: { code: "workspace.permission_denied" } }, { status: 403 });
      }

      const project = await selectProject(client, workspace.id, params.projectId);
      if (!project) {
        return jsonResponse({ error: { code: "project.not_found" } }, { status: 404 });
      }

      await client.begin(async (transaction) => {
        await transaction`
          update projects
          set soft_deleted_at = now(), updated_at = now()
          where id = ${project.id}
            and workspace_id = ${workspace.id}
            and soft_deleted_at is null
        `;
        await transaction`
          update database_sources
          set state = 'deleted', updated_at = now()
          where project_id = ${project.id}
            and workspace_id = ${workspace.id}
            and state <> 'deleted'
        `;
      });

      return jsonResponse({ ok: true });
    }));
}
