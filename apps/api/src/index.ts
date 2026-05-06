import { createHash } from "node:crypto";
import { createAuditRoutes, type AuditRoutesConfig } from "./audit";
import { createAdminRoutes, type AdminConfig } from "./admin";
import { createSqlClient, getDatabaseUrl } from "@mba/db";
import { Elysia } from "elysia";
import { buildApiBasePath } from "./app";
import { createAuthRoutes, type AuthConfig } from "./auth";
import { createBackupJobRoutes, type BackupJobsConfig } from "./backup-jobs";
import { createBackupRoutes, type BackupRoutesConfig } from "./backups";
import { createImpersonationRoutes, type ImpersonationRoutesConfig } from "./impersonation";
import { createInviteRoutes, type InvitesConfig } from "./invites";
import { createPlanRoutes, type PlansConfig } from "./plans";
import { createProjectRoutes, type ProjectsConfig } from "./projects";
import { createSourceRoutes, type SourcesConfig } from "./sources";
import { createStorageRoutes, type StorageConfig } from "./storage";
import { createWorkspaceRoutes, type WorkspaceConfig } from "./workspaces";

const sessionCookieName = "mba_session";
const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type CreateApiOptions = {
  audit?: Partial<AuditRoutesConfig>;
  admin?: Partial<AdminConfig>;
  auth?: Partial<AuthConfig>;
  backupJobs?: Partial<BackupJobsConfig>;
  backups?: Partial<BackupRoutesConfig>;
  impersonation?: Partial<ImpersonationRoutesConfig>;
  invites?: Partial<InvitesConfig>;
  plans?: Partial<PlansConfig>;
  projects?: Partial<ProjectsConfig>;
  sources?: Partial<SourcesConfig>;
  storage?: Partial<StorageConfig>;
  workspaces?: Partial<WorkspaceConfig>;
};

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

async function hasValidCsrfToken(databaseUrl: string, sessionToken: string, csrfToken: string | null): Promise<boolean> {
  if (!csrfToken) {
    return false;
  }

  const client = createSqlClient(databaseUrl);
  try {
    const [session] = await client<{ id: string }[]>`
      select sessions.id
      from sessions
      inner join users on users.id = sessions.user_id
      where sessions.session_token_hash = ${hashValue(sessionToken)}
        and sessions.csrf_token_hash = ${hashValue(csrfToken)}
        and sessions.invalidated_at is null
        and sessions.expires_at > now()
        and users.disabled_at is null
      limit 1
    `;
    return Boolean(session);
  } finally {
    await client.end();
  }
}

export function createApi(options: CreateApiOptions = {}) {
  const app = new Elysia({ prefix: buildApiBasePath() });
  const csrfDatabaseUrl = options.auth?.databaseUrl ?? options.workspaces?.databaseUrl ?? getDatabaseUrl();
  const workspaceOptions = options.workspaces ?? (options.auth?.databaseUrl ? { databaseUrl: options.auth.databaseUrl } : {});
  const auditOptions = options.audit ?? workspaceOptions;
  const adminOptions = options.admin ?? workspaceOptions;
  const backupJobOptions = options.backupJobs ?? workspaceOptions;
  const planOptions = options.plans ?? workspaceOptions;
  const backupsOptions = options.backups ?? workspaceOptions;
  const invitesOptions = options.invites ?? workspaceOptions;
  const impersonationOptions = options.impersonation ?? workspaceOptions;
  const projectOptions = options.projects ?? workspaceOptions;
  const sourceOptions = options.sources ?? workspaceOptions;
  const storageOptions = options.storage ?? workspaceOptions;

  app.get("/health", () => ({ ok: true }));
  app.onBeforeHandle(async ({ request }) => {
    if (!unsafeMethods.has(request.method)) {
      return undefined;
    }

    const sessionToken = readableCookie(request.headers.get("cookie"), sessionCookieName);
    if (!sessionToken) {
      return undefined;
    }

    const valid = await hasValidCsrfToken(csrfDatabaseUrl, sessionToken, request.headers.get("x-csrf-token"));
    return valid ? undefined : jsonResponse({ error: { code: "csrf.required" } }, { status: 403 });
  });
  app.use(createAuthRoutes(options.auth));
  app.use(createAdminRoutes(adminOptions));
  app.use(createWorkspaceRoutes(workspaceOptions));
  app.use(createAuditRoutes(auditOptions));
  app.use(createBackupJobRoutes(backupJobOptions));
  app.use(createBackupRoutes(backupsOptions));
  app.use(createImpersonationRoutes(impersonationOptions));
  app.use(createInviteRoutes(invitesOptions));
  app.use(createPlanRoutes(planOptions));
  app.use(createStorageRoutes(storageOptions));
  app.use(createProjectRoutes(projectOptions));
  app.use(createSourceRoutes(sourceOptions));
  return app;
}
