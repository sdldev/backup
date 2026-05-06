import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createApi } from "../../apps/api/src/index";
import { createSqlClient } from "../../packages/db/src/testing";
import { seedHarnessFixtures } from "../harness/fixtures";

const apiSourceDir = join(import.meta.dir, "../../apps/api/src");
const forbiddenRoutePatterns = [
  /["'`]\/workspaces\/:workspaceId\/(?:notification|notifications|webhook|webhooks|schedule|schedules|byos)(?:\/|["'`])/u,
  /["'`]\/workspaces\/:workspaceId\/backup-storage(?:\/|["'`])/u,
  /["'`]\/workspaces\/:workspaceId\/storage\/(?:create|test|activate|retire)(?:\/|["'`])/u,
  /["'`]\/workspaces\/:workspaceId\/backups\/:backupId\/restore(?:\/|["'`])/u
];

function sourceFiles(): string[] {
  return readdirSync(apiSourceDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(apiSourceDir, name));
}

async function json(response: Response) {
  return await response.json() as Record<string, unknown>;
}

describe("v1 API route contract layer", () => {
  test("static inventory omits future notification/webhook/BYOS/schedule customer routes", () => {
    const offenders = sourceFiles().flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return forbiddenRoutePatterns.some((pattern) => pattern.test(source)) ? [file] : [];
    });

    expect(offenders).toEqual([]);
  });

  test("registered plugins cover only current v1 route modules", () => {
    const indexSource = readFileSync(join(apiSourceDir, "index.ts"), "utf8");
    expect(indexSource).toContain("new Elysia({ prefix: buildApiBasePath() })");
    expect(indexSource).toContain("app.use(createAuthRoutes(options.auth))");
    expect(indexSource).toContain("app.use(createWorkspaceRoutes(workspaceOptions))");
    expect(indexSource).toContain("app.use(createAuditRoutes(auditOptions))");
    expect(indexSource).toContain("app.use(createImpersonationRoutes(impersonationOptions))");
    expect(indexSource).toContain("app.use(createPlanRoutes(planOptions))");
    expect(indexSource).toContain("app.use(createStorageRoutes(storageOptions))");
    expect(indexSource).toContain("app.use(createProjectRoutes(projectOptions))");
    expect(indexSource).toContain("app.use(createSourceRoutes(sourceOptions))");
    expect(indexSource).not.toMatch(/notification|webhook|byos|schedule/i);
  });

  test("exact status behavior covers auth, validation, create/read, CSRF, and scoped misses", async () => {
    const seeded = await seedHarnessFixtures();
    const app = createApi({ auth: { databaseUrl: seeded.databaseUrl }, workspaces: { databaseUrl: seeded.databaseUrl }, storage: { databaseUrl: seeded.databaseUrl }, projects: { databaseUrl: seeded.databaseUrl }, sources: { databaseUrl: seeded.databaseUrl }, plans: { databaseUrl: seeded.databaseUrl }, audit: { databaseUrl: seeded.databaseUrl } });

    const unauthenticated = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/projects`));
    expect(unauthenticated.status).toBe(401);

    const invalidCreate = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/projects`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a", "content-type": "application/json", "x-csrf-token": "csrf-a" },
      body: JSON.stringify({ name: "" })
    }));
    expect(invalidCreate.status).toBe(400);

    const csrfMissing = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/projects`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ name: "Blocked By CSRF" })
    }));
    expect(csrfMissing.status).toBe(403);
    expect(await json(csrfMissing)).toEqual({ error: { code: "csrf.required" } });

    const csrfInvalid = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/projects`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a", "content-type": "application/json", "x-csrf-token": "wrong" },
      body: JSON.stringify({ name: "Blocked By Bad CSRF" })
    }));
    expect(csrfInvalid.status).toBe(403);

    const created = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/projects`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a", "content-type": "application/json", "x-csrf-token": "csrf-a" },
      body: JSON.stringify({ name: "Contract Project" })
    }));
    expect(created.status).toBe(201);
    const createdBody = await json(created) as { project: { id: string } };

    const read = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/projects/${createdBody.project.id}`, {
      headers: { cookie: "mba_session=session-a" }
    }));
    expect(read.status).toBe(200);

    const swappedProject = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyB.id}/projects/${createdBody.project.id}`, {
      headers: { cookie: "mba_session=session-a" }
    }));
    expect(swappedProject.status).toBe(404);
    expect(JSON.stringify(await json(swappedProject))).not.toContain("Contract Project");

    const swappedSource = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/database-sources/${seeded.sources.mysql.id}`, {
      headers: { cookie: "mba_session=session-a" }
    }));
    expect(swappedSource.status).toBe(404);
    expect(JSON.stringify(await json(swappedSource))).not.toContain("src_mysql_prod_1");
  });

  test("future notification/webhook/BYOS/schedule surfaces are absent and create no storage rows", async () => {
    const seeded = await seedHarnessFixtures();
    const app = createApi({ auth: { databaseUrl: seeded.databaseUrl }, workspaces: { databaseUrl: seeded.databaseUrl }, storage: { databaseUrl: seeded.databaseUrl }, projects: { databaseUrl: seeded.databaseUrl }, sources: { databaseUrl: seeded.databaseUrl }, plans: { databaseUrl: seeded.databaseUrl }, audit: { databaseUrl: seeded.databaseUrl } });
    const client = createSqlClient(seeded.databaseUrl);
    let beforeCount = "0";
    try {
      const [before] = await client<{ count: string }[]>`select count(*)::text as count from backup_storage_configs`;
      beforeCount = before?.count ?? "0";
    } finally {
      await client.end();
    }

    for (const path of ["notification-settings", "notifications", "webhooks", "webhook/test", "schedule", "schedules"]) {
      const response = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/${path}`, {
        headers: { cookie: "mba_session=session-a" }
      }));
      expect(response.status).toBe(404);
    }

    for (const path of ["backup-storage", "backup-storage/test", "backup-storage/activate", "backup-storage/retire", "storage/create", "storage/test", "storage/activate", "storage/retire"]) {
      const response = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/${path}`, {
        method: "POST",
        headers: { cookie: "mba_session=session-a", "content-type": "application/json", "x-csrf-token": "csrf-a" },
        body: JSON.stringify({ provider: "aws_s3", displayName: "Forbidden BYOS" })
      }));
      expect([404, 405]).toContain(response.status);
    }

    const afterClient = createSqlClient(seeded.databaseUrl);
    try {
      const [after] = await afterClient<{ count: string }[]>`select count(*)::text as count from backup_storage_configs`;
      expect(after?.count).toBe(beforeCount);
    } finally {
      await afterClient.end();
    }
  });

  test("restore surface is docs-only and exposes no execution route", async () => {
    const seeded = await seedHarnessFixtures();
    const app = createApi({
      auth: { databaseUrl: seeded.databaseUrl },
      workspaces: { databaseUrl: seeded.databaseUrl },
      backups: {
        databaseUrl: seeded.databaseUrl,
        storage: seeded.storage,
        resolveWorkspaceKey: async (workspaceId) => workspaceId === seeded.workspaces.agencyA.id ? seeded.workspaceKeys.agencyA : seeded.workspaceKeys.agencyB
      }
    });

    const workspaceDocs = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/restore-docs`, {
      headers: { cookie: "mba_session=session-a" }
    }));
    expect(workspaceDocs.status).toBe(200);
    const workspaceHtml = await workspaceDocs.text();
    expect(workspaceHtml).toContain("gunzip -c backup.sql.gz");
    expect(workspaceHtml).toContain("pg_restore --host &lt;HOST&gt;");
    expect(workspaceHtml).not.toContain("<form");
    expect(workspaceHtml).not.toContain("action=");

    const forbiddenPost = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/restore-docs`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a", "x-csrf-token": "csrf-a" }
    }));
    expect(forbiddenPost.status).toBe(404);

    const backupForbiddenPost = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/backups/${seeded.backups.agencyA.id}/restore-docs`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a", "x-csrf-token": "csrf-a" }
    }));
    expect(backupForbiddenPost.status).toBe(404);
  });
});
