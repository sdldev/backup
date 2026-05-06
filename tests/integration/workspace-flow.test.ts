import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";

import { createSqlClient } from "../../packages/db/src/index";
import { createApi } from "../../apps/api/src/index";
import { runWorkspacePurgeWorker } from "../../apps/worker/src/index";
import {
  buildAuthenticatedRouteModel,
  buildFirstBackupFailureModel,
  buildFirstBackupSuccessModel,
  buildManualBackupDashboardModel,
  buildRestoreInstructionsModel,
  buildDatabaseSourceWizardSaveIntent,
  createDatabaseSourceWizardDraft,
  decideAppLauncherRoute,
  decideNewWorkspaceRoute,
  getDatabaseSourceEnableIntent,
  getDatabaseSourceWizardSteps
} from "../../apps/web/src/app";
import { ensureFreshTestSchema, resolveDatabaseUrl } from "../../scripts/db/_test-db";
import { seedHarnessFixtures } from "../harness/fixtures";

const databaseUrl = resolveDatabaseUrl();

setDefaultTimeout(30_000);

async function resetDb() {
  await ensureFreshTestSchema(databaseUrl);
}

async function createSession(email: string): Promise<{ cookie: string; csrf: string }> {
  const client = createSqlClient(databaseUrl);
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");

  try {
    const [user] = await client<{ id: string }[]>`
      insert into users (email, name)
      values (${email}, 'Workspace User')
      returning id
    `;
    if (!user) {
      throw new Error("test user insert failed");
    }

    await client`
      insert into sessions (user_id, session_token_hash, csrf_token_hash, expires_at)
      values (${user.id}, ${createHash("sha256").update(token).digest("hex")}, ${createHash("sha256").update(csrf).digest("hex")}, now() + interval '7 days')
    `;

    return { cookie: `mba_session=${token}; mba_csrf=${csrf}`, csrf };
  } finally {
    await client.end();
  }
}

function app() {
  return createApi({ auth: { databaseUrl }, workspaces: { databaseUrl } });
}

async function json(response: Response) {
  return await response.json() as Record<string, unknown>;
}

describe("workspace onboarding flow", () => {
  test("first workspace creation uses Basic plan, owner membership, slug, timezone default", async () => {
    await resetDb();
    const session = await createSession("first-workspace@example.com");

    const response = await app().handle(new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json", "x-csrf-token": session.csrf },
      body: JSON.stringify({ name: "Acme Backup Co" })
    }));
    const body = await json(response) as { workspace: { slug: string; timezone: string; planSlug: string; storageStatus: string; role: string } };

    expect(response.status).toBe(201);
    expect(body.workspace).toMatchObject({ slug: "acme-backup-co", timezone: "UTC", planSlug: "basic", storageStatus: "provisioning", role: "owner" });

    const client = createSqlClient(databaseUrl);
    try {
      const [ownerCount] = await client<{ count: string }[]>`
        select count(*)::text as count
        from workspace_members
        where workspace_id = (select id from workspaces where slug = 'acme-backup-co')
          and role = 'owner'
      `;
      expect(ownerCount?.count).toBe("1");
    } finally {
      await client.end();
    }
  });

  test("second self-serve workspace returns exact sanitized policy code", async () => {
    await resetDb();
    const session = await createSession("second-blocked@example.com");

    const first = await app().handle(new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json", "x-csrf-token": session.csrf },
      body: JSON.stringify({ name: "First Workspace" })
    }));
    expect(first.status).toBe(201);

    const second = await app().handle(new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json", "x-csrf-token": session.csrf },
      body: JSON.stringify({ name: "Second Workspace" })
    }));
    const body = await json(second);

    expect(second.status).toBe(403);
    expect(body).toEqual({ error: { code: "workspace_limit_requires_admin_approval" } });
    expect(JSON.stringify(body)).not.toContain("Second Workspace");
  });

  test("workspace slug edit and timezone handling round-trip through get/list", async () => {
    await resetDb();
    const session = await createSession("slug-timezone@example.com");

    const created = await app().handle(new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json", "x-csrf-token": session.csrf },
      body: JSON.stringify({ name: "Agency East", timezone: "America/New_York" })
    }));
    expect(created.status).toBe(201);

    const patched = await app().handle(new Request("http://localhost/v1/workspaces/agency-east", {
      method: "PATCH",
      headers: { cookie: session.cookie, "content-type": "application/json", "x-csrf-token": session.csrf },
      body: JSON.stringify({ slug: "Client Portal", timezone: "Europe/London" })
    }));
    const patchBody = await json(patched) as { workspace: { slug: string; timezone: string } };
    expect(patched.status).toBe(200);
    expect(patchBody.workspace).toMatchObject({ slug: "client-portal", timezone: "Europe/London" });

    const listed = await app().handle(new Request("http://localhost/v1/workspaces", { headers: { cookie: session.cookie } }));
    const listBody = await json(listed) as { workspaces: { slug: string; timezone: string }[] };
    expect(listBody.workspaces).toEqual([expect.objectContaining({ slug: "client-portal", timezone: "Europe/London" })]);
  });

  test("delete and restore preserve owner-scoped access", async () => {
    await resetDb();
    const session = await createSession("restore@example.com");
    await app().handle(new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json", "x-csrf-token": session.csrf },
      body: JSON.stringify({ name: "Restorable" })
    }));

    const deleted = await app().handle(new Request("http://localhost/v1/workspaces/restorable", { method: "DELETE", headers: { cookie: session.cookie, "x-csrf-token": session.csrf } }));
    expect(deleted.status).toBe(200);

    const hidden = await app().handle(new Request("http://localhost/v1/workspaces/restorable", { headers: { cookie: session.cookie } }));
    expect(hidden.status).toBe(404);

    const restored = await app().handle(new Request("http://localhost/v1/workspaces/restorable/restore", { method: "POST", headers: { cookie: session.cookie, "x-csrf-token": session.csrf } }));
    const body = await json(restored) as { workspace: { slug: string; deleted: boolean } };
    expect(restored.status).toBe(200);
    expect(body.workspace).toMatchObject({ slug: "restorable", deleted: false });

    const client = createSqlClient(databaseUrl);
    try {
      const [workspace] = await client<{ soft_deleted_at: Date | null; purge_scheduled_at: Date | null }[]>`
        select soft_deleted_at, purge_scheduled_at
        from workspaces
        where slug = 'restorable'
        limit 1
      `;
      expect(workspace.soft_deleted_at).toBeNull();
      expect(workspace.purge_scheduled_at).toBeNull();
    } finally {
      await client.end();
    }
  });

  test("workspace soft-delete uses 7-day grace and purge-after-grace removes workspace objects", async () => {
    const seeded = await seedHarnessFixtures();
    const api = createApi({ auth: { databaseUrl: seeded.databaseUrl }, workspaces: { databaseUrl: seeded.databaseUrl } });
    const client = createSqlClient(seeded.databaseUrl);

    try {
      const deleted = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}`, {
        method: "DELETE",
        headers: { cookie: `mba_session=${seeded.sessions.agencyAOwner.token}; mba_csrf=${seeded.sessions.agencyAOwner.csrf}`, "x-csrf-token": seeded.sessions.agencyAOwner.csrf }
      }));
      expect(deleted.status).toBe(200);

      const [scheduled] = await client<{ soft_deleted_at: Date | null; purge_scheduled_at: Date | null }[]>`
        select soft_deleted_at, purge_scheduled_at
        from workspaces
        where id = ${seeded.workspaces.agencyA.id}
      `;
      expect(scheduled.soft_deleted_at).toBeInstanceOf(Date);
      expect(scheduled.purge_scheduled_at).toBeInstanceOf(Date);
      if (!scheduled.soft_deleted_at || !scheduled.purge_scheduled_at) {
        throw new Error("expected workspace soft-delete schedule");
      }
      const graceMs = scheduled.purge_scheduled_at.getTime() - scheduled.soft_deleted_at.getTime();
      expect(graceMs).toBe(7 * 24 * 60 * 60 * 1000);

      const dryRun = await runWorkspacePurgeWorker({
        client,
        storage: seeded.storage,
        now: new Date(scheduled.purge_scheduled_at.getTime() - 60_000),
        dryRun: true
      });
      expect(dryRun.actions).toEqual([]);
      seeded.storage.assertObjectExists("opaque/o1/objects/fixture01.enc");
      seeded.storage.assertObjectExists("opaque/o2/objects/fixture02.enc");

      const purged = await runWorkspacePurgeWorker({
        client,
        storage: seeded.storage,
        now: new Date(scheduled.purge_scheduled_at.getTime() + 60_000),
        dryRun: false
      });
      expect(purged.actions).toEqual([
        expect.objectContaining({
          workspaceId: seeded.workspaces.agencyA.id,
          storagePrefix: "opaque/o1",
          action: "purge_workspace",
          objectKeys: ["opaque/o1/objects/fixture01.enc"]
        })
      ]);

      seeded.storage.assertObjectAbsent("opaque/o1/objects/fixture01.enc");
      seeded.storage.assertObjectExists("opaque/o2/objects/fixture02.enc");

      const [workspaceAfter] = await client<{ count: string }[]>`
        select count(*)::text as count
        from workspaces
        where id = ${seeded.workspaces.agencyA.id}
      `;
      expect(workspaceAfter.count).toBe("0");
    } finally {
      await client.end();
    }
  });

  test("admin and member cannot change workspace settings but owner still can", async () => {
    const seeded = await seedHarnessFixtures();
    const api = createApi({ auth: { databaseUrl: seeded.databaseUrl }, workspaces: { databaseUrl: seeded.databaseUrl } });

    const adminDenied = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}`, {
      method: "PATCH",
      headers: { cookie: "mba_session=session-admin-a", "content-type": "application/json", "x-csrf-token": "csrf-admin-a" },
      body: JSON.stringify({ slug: "admin-should-not-change", timezone: "Europe/Paris" })
    }));
    expect(adminDenied.status).toBe(403);
    expect(await json(adminDenied)).toEqual({ error: { code: "workspace.permission_denied" } });

    const memberDenied = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}`, {
      method: "PATCH",
      headers: { cookie: "mba_session=session-member-a", "content-type": "application/json", "x-csrf-token": "csrf-member-a" },
      body: JSON.stringify({ name: "Member Rename" })
    }));
    expect(memberDenied.status).toBe(403);
    expect(await json(memberDenied)).toEqual({ error: { code: "workspace.permission_denied" } });

    const ownerAllowed = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}`, {
      method: "PATCH",
      headers: { cookie: "mba_session=session-a", "content-type": "application/json", "x-csrf-token": "csrf-a" },
      body: JSON.stringify({ slug: "owner-can-change", timezone: "Europe/Berlin" })
    }));
    const ownerBody = await json(ownerAllowed) as { workspace: { slug: string; timezone: string } };
    expect(ownerAllowed.status).toBe(200);
    expect(ownerBody.workspace).toMatchObject({ slug: "owner-can-change", timezone: "Europe/Berlin" });
  });

  test("web launcher decisions match /app and /app/new-workspace redirects", () => {
    expect(decideAppLauncherRoute([])).toEqual({ kind: "render" });
    expect(decideNewWorkspaceRoute([])).toEqual({ kind: "render" });
    expect(decideAppLauncherRoute([{ slug: "acme" }])).toEqual({ kind: "redirect", location: "/app/acme" });
    expect(decideNewWorkspaceRoute([{ slug: "acme" }])).toEqual({ kind: "redirect", location: "/app" });
  });

  test("dashboard helper reflects setup incomplete, ready, last failed, and last succeeded", () => {
    expect(buildManualBackupDashboardModel({
      storageStatus: "provisioning",
      storageUsedBytes: 0n,
      storageLimitBytes: 100n,
      projectCount: 0,
      sourceCount: 0,
      testedSourceCount: 0,
      invitedMemberCount: 0,
      lastBackup: null
    }).status).toBe("setup_incomplete");

    expect(buildManualBackupDashboardModel({
      storageStatus: "ready",
      storageUsedBytes: 10n,
      storageLimitBytes: 100n,
      projectCount: 1,
      sourceCount: 1,
      testedSourceCount: 1,
      invitedMemberCount: 0,
      lastBackup: null
    }).status).toBe("ready");

    expect(buildManualBackupDashboardModel({
      storageStatus: "ready",
      storageUsedBytes: 10n,
      storageLimitBytes: 100n,
      projectCount: 1,
      sourceCount: 1,
      testedSourceCount: 1,
      invitedMemberCount: 0,
      lastBackup: {
        id: "job-failed",
        status: "failed",
        filename: null,
        createdAt: "2026-05-06T00:00:00.000Z",
        errorMessage: "sanitized failure"
      }
    }).status).toBe("last_failed");

    const succeeded = buildManualBackupDashboardModel({
      storageStatus: "ready",
      storageUsedBytes: 25n,
      storageLimitBytes: 100n,
      projectCount: 1,
      sourceCount: 1,
      testedSourceCount: 1,
      invitedMemberCount: 1,
      lastBackup: {
        id: "backup-1",
        status: "succeeded",
        filename: "agency-a-20260506.dump",
        createdAt: "2026-05-06T00:00:00.000Z",
        errorMessage: null
      }
    });
    expect(succeeded.status).toBe("last_succeeded");
    expect(succeeded.storageUsagePercent).toBe(25);
    expect(succeeded.checklist.find((item) => item.key === "first_backup_succeeded")?.complete).toBeTrue();
  });

  test("first backup helper models expose success/failure UX without restore action", () => {
    expect(buildFirstBackupSuccessModel({
      backupId: "backup-1",
      filename: "agency-a-20260506.dump",
      storedSizeBytes: "2048",
      startedAt: "2026-05-06T00:00:00.000Z",
      finishedAt: "2026-05-06T00:00:45.000Z",
      viewerRole: "owner"
    })).toMatchObject({
      status: "succeeded",
      downloadReady: true,
      durationSeconds: 45,
      invitePromptVisible: true
    });

    expect(buildFirstBackupFailureModel({
      backupJobId: "job-1",
      failedStage: "uploading",
      failureReason: "Workspace storage limit reached before upload completed."
    })).toEqual({
      status: "failed",
      backupJobId: "job-1",
      failedStage: "uploading",
      failureReason: "Workspace storage limit reached before upload completed.",
      actions: ["retry", "edit"]
    });
  });

  test("restore instructions helper returns docs-only mysql and postgresql guidance", () => {
    const mysql = buildRestoreInstructionsModel({ engine: "mysql", filename: "backup.sql.gz" });
    const postgresql = buildRestoreInstructionsModel({ engine: "postgresql", filename: "backup.dump" });

    expect(mysql.formatLabel).toBe(".sql.gz");
    expect(mysql.commands.join("\n")).toContain("gunzip -c backup.sql.gz");
    expect(mysql.commands.join("\n")).toContain("mysql --host <HOST>");
    expect(mysql.warnings.join(" ")).toContain("overwrite live production data");
    expect(mysql.hasExecutionAction).toBeFalse();

    expect(postgresql.formatLabel).toBe(".dump");
    expect(postgresql.commands.join("\n")).toContain("pg_restore --host <HOST>");
    expect(postgresql.warnings.join(" ")).toContain("overwrite live production data");
    expect(postgresql.hasExecutionAction).toBeFalse();
  });

  test("authenticated route model exposes impersonation banner for all authenticated pages", () => {
    expect(buildAuthenticatedRouteModel({ impersonation: null })).toEqual({
      impersonationBanner: {
        visible: false,
        adminUserId: null,
        targetUserId: null,
        reason: null,
        startedAt: null
      }
    });

    expect(buildAuthenticatedRouteModel({
      impersonation: {
        active: true,
        adminUserId: "admin-1",
        targetUserId: "user-1",
        reason: "support investigation",
        startedAt: "2026-05-06T00:00:00.000Z"
      }
    })).toEqual({
      impersonationBanner: {
        visible: true,
        adminUserId: "admin-1",
        targetUserId: "user-1",
        reason: "support investigation",
        startedAt: "2026-05-06T00:00:00.000Z"
      }
    });
  });

  test("database source wizard preserves v1 step flow, hides schedule controls, and models save intent", () => {
    expect(getDatabaseSourceWizardSteps()).toEqual([
      "engine",
      "identity",
      "connection",
      "test",
      "retention",
      "review"
    ]);

    const failedDraft = createDatabaseSourceWizardDraft("postgresql");
    failedDraft.displayName = "Primary Source";
    failedDraft.technicalDatabaseName = "app_db";
    failedDraft.host = "db.internal";
    failedDraft.username = "postgres";
    failedDraft.password = "super-secret-password";
    failedDraft.retentionDays = 14;
    failedDraft.connectionTestStatus = "failed";

    const failedSaveIntent = buildDatabaseSourceWizardSaveIntent(failedDraft);
    expect(failedSaveIntent.allowSaveWithoutSuccessfulTest).toBeTrue();
    expect(failedSaveIntent.canEnableAfterSave).toBeFalse();
    expect(failedSaveIntent.state).toBe("disabled");
    expect(getDatabaseSourceEnableIntent(failedDraft.connectionTestStatus)).toEqual({ allowed: false, reason: "test_required" });
    expect(failedSaveIntent.payload).not.toHaveProperty("scheduleEnabled");
    expect(failedSaveIntent.payload).not.toHaveProperty("scheduleFrequencyPerDay");

    const passedDraft = { ...failedDraft, connectionTestStatus: "succeeded" as const };
    const passedSaveIntent = buildDatabaseSourceWizardSaveIntent(passedDraft);
    expect(passedSaveIntent.allowSaveWithoutSuccessfulTest).toBeFalse();
    expect(passedSaveIntent.canEnableAfterSave).toBeTrue();
    expect(passedSaveIntent.state).toBe("enabled");
    expect(getDatabaseSourceEnableIntent(passedDraft.connectionTestStatus)).toEqual({ allowed: true, reason: "ready" });
    expect(passedSaveIntent.payload).not.toHaveProperty("scheduleEnabled");
    expect(passedSaveIntent.payload).not.toHaveProperty("scheduleFrequencyPerDay");
  });
});
