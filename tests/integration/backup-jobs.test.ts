import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";

import { createSqlClient } from "../../packages/db/src/index";
import { createApi } from "../../apps/api/src/index";
import { resetRateLimitsForTests } from "../../apps/api/src/rate-limit";
import { claimNextBackupJob, completeBackupJob, computeRetryBackoffMs, failBackupJob } from "../../apps/worker/src/index";
import { ensureFreshTestSchema, resolveDatabaseUrl } from "../../scripts/db/_test-db";
import { seedHarnessFixtures } from "../harness/fixtures";

const databaseUrl = resolveDatabaseUrl();

setDefaultTimeout(30_000);

async function resetDb() {
  await ensureFreshTestSchema(databaseUrl);
}

async function createSession(email: string): Promise<{ cookie: string; csrf: string; userId: string }> {
  const client = createSqlClient(databaseUrl);
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");

  try {
    const [user] = await client<{ id: string }[]>`
      insert into users (email, name)
      values (${email}, 'Backup Jobs User')
      returning id
    `;
    await client`
      insert into sessions (user_id, session_token_hash, csrf_token_hash, expires_at)
      values (${user.id}, ${createHash("sha256").update(token).digest("hex")}, ${createHash("sha256").update(csrf).digest("hex")}, now() + interval '7 days')
    `;
    return { cookie: `mba_session=${token}; mba_csrf=${csrf}`, csrf, userId: user.id };
  } finally {
    await client.end();
  }
}

function app() {
  return createApi({ auth: { databaseUrl }, workspaces: { databaseUrl }, storage: { databaseUrl }, projects: { databaseUrl }, sources: { databaseUrl }, plans: { databaseUrl }, backupJobs: { databaseUrl } });
}

async function json(response: Response) {
  return await response.json() as Record<string, unknown>;
}

async function createWorkspace(cookie: string, name: string) {
  const csrf = cookie.split("mba_csrf=")[1].split(";")[0];
  const response = await app().handle(new Request("http://localhost/v1/workspaces", {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify({ name })
  }));
  return await json(response) as { workspace: { id: string } };
}

async function createProject(cookie: string, workspaceId: string, name = "Backup Job Project") {
  const csrf = cookie.split("mba_csrf=")[1].split(";")[0];
  const response = await app().handle(new Request(`http://localhost/v1/workspaces/${workspaceId}/projects`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify({ name })
  }));
  return await json(response) as { project: { id: string } };
}

async function createReadySource(cookie: string, workspaceId: string, projectId: string) {
  const csrf = cookie.split("mba_csrf=")[1].split(";")[0];
  const createResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${workspaceId}/projects/${projectId}/database-sources`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify({
      engine: "postgresql",
      displayName: "Primary Backup Source",
      technicalDatabaseName: "app_db",
      host: "db.internal",
      port: 5432,
      username: "postgres",
      password: "super-secret-password",
      sslMode: "require",
      retentionDays: 14
    })
  }));
  const created = await json(createResponse) as { source: { id: string } };

  await app().handle(new Request(`http://localhost/v1/workspaces/${workspaceId}/database-sources/${created.source.id}/test-connection`, {
    method: "POST",
    headers: { cookie, "x-csrf-token": csrf }
  }));
  await app().handle(new Request(`http://localhost/v1/workspaces/${workspaceId}/database-sources/${created.source.id}/enable`, {
    method: "POST",
    headers: { cookie, "x-csrf-token": csrf }
  }));

  return created.source.id;
}

async function activateStorage(workspaceId: string, userId: string) {
  const client = createSqlClient(databaseUrl);
  try {
    await client`
      update workspaces
      set storage_status = 'ready', onboarding_step = 'complete', updated_at = now()
      where id = ${workspaceId}
    `;
    await client`
      insert into backup_storage_configs (workspace_id, provider, mode, display_name, storage_prefix, credential_fingerprint, status, is_current, activated_at, created_by_user_id)
      values (${workspaceId}, 'minio', 'platform_managed', 'Job Storage', 'opaque/jobs', 'fp', 'active', true, now(), ${userId})
    `;
  } finally {
    await client.end();
  }
}

async function raiseManualBackupLimit(workspaceId: string, userId: string, limit: number) {
  const client = createSqlClient(databaseUrl);
  try {
    const [admin] = await client<{ id: string }[]>`
      insert into system_admins (user_id, role)
      values (${userId}, 'system_admin')
      returning id
    `;
    await client`
      insert into workspace_limit_overrides (workspace_id, manual_backup_per_hour_limit, reason, created_by_platform_admin_id)
      values (${workspaceId}, ${limit}, 'backup jobs integration test', ${admin.id})
    `;
  } finally {
    await client.end();
  }
}

describe("backup jobs", () => {
  test("manual route queues when source enabled and storage ready", async () => {
    await resetDb();
    const owner = await createSession("backup-jobs-owner@example.com");
    const workspace = await createWorkspace(owner.cookie, "Backup Jobs Workspace");
    const project = await createProject(owner.cookie, workspace.workspace.id);
    const sourceId = await createReadySource(owner.cookie, workspace.workspace.id, project.project.id);
    await activateStorage(workspace.workspace.id, owner.userId);

    const response = await app().handle(new Request(`http://localhost/v1/workspaces/${workspace.workspace.id}/database-sources/${sourceId}/backup-jobs`, {
      method: "POST",
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }
    }));

    expect(response.status).toBe(201);
    const body = await json(response) as { backupJob: { id: string; status: string; stage: string; databaseSourceId: string } };
    expect(body.backupJob.status).toBe("queued");
    expect(body.backupJob.stage).toBe("queued");
    expect(body.backupJob.databaseSourceId).toBe(sourceId);

    const client = createSqlClient(databaseUrl);
    try {
      const [row] = await client<{ count: string }[]>`
        select count(*)::text as count
        from backup_jobs
        where id = ${body.backupJob.id}
          and workspace_id = ${workspace.workspace.id}
          and status = 'queued'
      `;
      expect(row?.count).toBe("1");
    } finally {
      await client.end();
    }
  });

  test("same-source concurrent manual route returns 409 active_backup_job_exists", async () => {
    await resetDb();
    const owner = await createSession("backup-jobs-lock@example.com");
    const workspace = await createWorkspace(owner.cookie, "Backup Jobs Lock Workspace");
    const project = await createProject(owner.cookie, workspace.workspace.id);
    const sourceId = await createReadySource(owner.cookie, workspace.workspace.id, project.project.id);
    await activateStorage(workspace.workspace.id, owner.userId);

    const first = await app().handle(new Request(`http://localhost/v1/workspaces/${workspace.workspace.id}/database-sources/${sourceId}/backup-jobs`, {
      method: "POST",
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }
    }));
    expect(first.status).toBe(201);

    const second = await app().handle(new Request(`http://localhost/v1/workspaces/${workspace.workspace.id}/database-sources/${sourceId}/backup-jobs`, {
      method: "POST",
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }
    }));
    expect(second.status).toBe(409);
    expect(await json(second)).toEqual({ error: { code: "active_backup_job_exists" } });
  });

  test("manual backup action rate limit returns 429 before creating another job", async () => {
    await resetDb();
    resetRateLimitsForTests();
    const owner = await createSession("backup-jobs-rate@example.com");
    const workspace = await createWorkspace(owner.cookie, "Backup Jobs Rate Workspace");
    const project = await createProject(owner.cookie, workspace.workspace.id);
    const sourceId = await createReadySource(owner.cookie, workspace.workspace.id, project.project.id);
    await activateStorage(workspace.workspace.id, owner.userId);
    await raiseManualBackupLimit(workspace.workspace.id, owner.userId, 100);
    const limitedApp = createApi({ auth: { databaseUrl }, workspaces: { databaseUrl }, storage: { databaseUrl }, projects: { databaseUrl }, sources: { databaseUrl }, plans: { databaseUrl }, backupJobs: { databaseUrl, rateLimit: { max: 1, windowMs: 60_000 } } });

    const request = () => limitedApp.handle(new Request(`http://localhost/v1/workspaces/${workspace.workspace.id}/database-sources/${sourceId}/backup-jobs`, {
      method: "POST",
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }
    }));

    const first = await request();
    const second = await request();
    const body = await second.json() as { error: { code: string } };

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect(body).toEqual({ error: { code: "rate_limit.exceeded" } });
  });

  test("scheduled creation path absent and inaccessible", async () => {
    await resetDb();
    const owner = await createSession("backup-jobs-noschedule@example.com");
    const workspace = await createWorkspace(owner.cookie, "Backup Jobs No Schedule Workspace");

    const response = await app().handle(new Request(`http://localhost/v1/workspaces/${workspace.workspace.id}/scheduled-backup-jobs`, {
      method: "POST",
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }
    }));

    expect(response.status).toBe(404);
  });

  test("dashboard and first-backup routes reflect seeded setup and health data", async () => {
    const seeded = await seedHarnessFixtures();
    const api = createApi({
      auth: { databaseUrl: seeded.databaseUrl },
      workspaces: { databaseUrl: seeded.databaseUrl },
      backups: {
        databaseUrl: seeded.databaseUrl,
        storage: seeded.storage,
        resolveWorkspaceKey: async (workspaceId) => workspaceId === seeded.workspaces.agencyA.id ? seeded.workspaceKeys.agencyA : seeded.workspaceKeys.agencyB
      }
    });

    const dashboardResponse = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/dashboard`, {
      headers: { cookie: "mba_session=session-a" }
    }));
    expect(dashboardResponse.status).toBe(200);
    const dashboardBody = await json(dashboardResponse) as {
      dashboard: {
        status: string;
        setupComplete: boolean;
        storageUsedBytes: string;
        checklist: Array<{ key: string; complete: boolean }>;
        lastBackupFilename: string | null;
      };
    };
    expect(dashboardBody.dashboard.status).toBe("last_succeeded");
    expect(dashboardBody.dashboard.setupComplete).toBeTrue();
    expect(Number(dashboardBody.dashboard.storageUsedBytes)).toBeGreaterThan(0);
    expect(dashboardBody.dashboard.lastBackupFilename).toBe("agency-a-20260506.dump");
    expect(dashboardBody.dashboard.checklist.find((item) => item.key === "team_invited_optional")?.complete).toBeTrue();

    const firstBackupResponse = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/first-backup`, {
      headers: { cookie: "mba_session=session-a" }
    }));
    expect(firstBackupResponse.status).toBe(200);
    const firstBackupBody = await json(firstBackupResponse) as {
      firstBackup: {
        status: string;
        filename?: string;
        downloadReady?: boolean;
      };
    };
    expect(firstBackupBody.firstBackup.status).toBe("succeeded");
    expect(firstBackupBody.firstBackup.filename).toBe("agency-a-20260506.dump");
    expect(firstBackupBody.firstBackup.downloadReady).toBeTrue();

    const client = createSqlClient(seeded.databaseUrl);
    try {
      await client`
        insert into backup_jobs (
          workspace_id, project_id, database_source_id, trigger, requested_by_user_id, status, stage, attempt_count, queued_at, finished_at, user_error_message
        ) values (
          ${seeded.workspaces.agencyA.id},
          ${seeded.projects.agencyA.id},
          ${seeded.sources.postgres.id},
          'manual',
          ${seeded.users.agencyA.id},
          'failed',
          'uploading',
          1,
          now() + interval '1 minute',
          now() + interval '1 minute',
          'Workspace storage limit reached before upload completed.'
        )
      `;
    } finally {
      await client.end();
    }

    const failedDashboardResponse = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/dashboard`, {
      headers: { cookie: "mba_session=session-a" }
    }));
    const failedDashboardBody = await json(failedDashboardResponse) as {
      dashboard: { status: string; lastBackupErrorMessage: string | null };
    };
    expect(failedDashboardBody.dashboard.status).toBe("last_failed");
    expect(failedDashboardBody.dashboard.lastBackupErrorMessage).toBe("Workspace storage limit reached before upload completed.");
  });

  test("worker claim, retry backoff cap, cancel, and final failure transitions persist", async () => {
    await resetDb();
    const owner = await createSession("backup-jobs-worker@example.com");
    const workspace = await createWorkspace(owner.cookie, "Backup Jobs Worker Workspace");
    const project = await createProject(owner.cookie, workspace.workspace.id);
    const sourceId = await createReadySource(owner.cookie, workspace.workspace.id, project.project.id);
    await activateStorage(workspace.workspace.id, owner.userId);
    await raiseManualBackupLimit(workspace.workspace.id, owner.userId, 10);

    const queuedResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${workspace.workspace.id}/database-sources/${sourceId}/backup-jobs`, {
      method: "POST",
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }
    }));
    const queuedBody = await json(queuedResponse) as { backupJob: { id: string } };

    const client = createSqlClient(databaseUrl);
    try {
      const firstClaim = await claimNextBackupJob(client);
      expect(firstClaim?.id).toBe(queuedBody.backupJob.id);
      expect(firstClaim?.status).toBe("running");
      expect(firstClaim?.attemptCount).toBe(1);

      const firstRetry = firstClaim ? await failBackupJob(client, firstClaim, { category: "transient", message: "temporary network issue" }) : null;
      expect(firstRetry?.status).toBe("queued");
      expect(firstRetry?.attemptCount).toBe(1);
      expect(firstRetry ? firstRetry.queuedAt.getTime() - Date.now() : 0).toBeGreaterThan(20_000);
      expect(computeRetryBackoffMs(1)).toBe(30_000);
      expect(computeRetryBackoffMs(3)).toBe(120_000);
      expect(computeRetryBackoffMs(9)).toBe(240_000);

      await client`update backup_jobs set queued_at = now() - interval '1 second' where id = ${queuedBody.backupJob.id}`;
      const secondClaim = await claimNextBackupJob(client);
      expect(secondClaim?.attemptCount).toBe(2);

      const secondRetry = secondClaim ? await failBackupJob(client, secondClaim, { category: "transient", message: "temporary storage issue" }) : null;
      expect(secondRetry?.status).toBe("queued");
      await client`update backup_jobs set queued_at = now() - interval '1 second' where id = ${queuedBody.backupJob.id}`;

      const thirdClaim = await claimNextBackupJob(client);
      expect(thirdClaim?.attemptCount).toBe(3);
      const thirdFailure = thirdClaim ? await failBackupJob(client, thirdClaim, { category: "transient", message: "third transient becomes final" }) : null;
      expect(thirdFailure?.status).toBe("failed");
      expect(thirdFailure?.stage).toBe("failed");

      const secondJobResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${workspace.workspace.id}/database-sources/${sourceId}/backup-jobs`, {
        method: "POST",
        headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }
      }));
      const secondJobBody = await json(secondJobResponse) as { backupJob: { id: string } };

      const runningJob = await claimNextBackupJob(client);
      expect(runningJob?.id).toBe(secondJobBody.backupJob.id);

      const cancelResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${workspace.workspace.id}/backup-jobs/${secondJobBody.backupJob.id}/cancel`, {
        method: "POST",
        headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }
      }));
      expect(cancelResponse.status).toBe(200);

      const refreshed = await getJobRow(client, workspace.workspace.id, secondJobBody.backupJob.id);
      const cancelled = refreshed ? await failBackupJob(client, refreshed, { category: "transient", message: "cancel requested mid-flight" }) : null;
      expect(cancelled?.status).toBe("cancelled");
      expect(cancelled?.stage).toBe("cancelled");

      const thirdJobResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${workspace.workspace.id}/database-sources/${sourceId}/backup-jobs`, {
        method: "POST",
        headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }
      }));
      const thirdJobBody = await json(thirdJobResponse) as { backupJob: { id: string } };
      const successClaim = await claimNextBackupJob(client);
      expect(successClaim?.id).toBe(thirdJobBody.backupJob.id);
      const succeeded = successClaim ? await completeBackupJob(client, workspace.workspace.id, successClaim.id) : null;
      expect(succeeded?.status).toBe("succeeded");
      expect(succeeded?.stage).toBe("succeeded");
    } finally {
      await client.end();
    }
  });

  test("job detail and events expose sanitized safe stages only", async () => {
    await resetDb();
    const owner = await createSession("backup-jobs-events@example.com");
    const workspace = await createWorkspace(owner.cookie, "Backup Jobs Events Workspace");
    const project = await createProject(owner.cookie, workspace.workspace.id);
    const sourceId = await createReadySource(owner.cookie, workspace.workspace.id, project.project.id);
    await activateStorage(workspace.workspace.id, owner.userId);

    const createResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${workspace.workspace.id}/database-sources/${sourceId}/backup-jobs`, {
      method: "POST",
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }
    }));
    const created = await json(createResponse) as { backupJob: { id: string } };

    const client = createSqlClient(databaseUrl);
    try {
      await client`
        update backup_jobs
        set status = 'running',
          stage = 'encrypting',
          started_at = now(),
          user_error_message = 'stdout pg_dump --file secret.sql',
          internal_error_ref = 'err_ref_123'
        where id = ${created.backupJob.id}
      `;

      const detailResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${workspace.workspace.id}/backup-jobs/${created.backupJob.id}`, {
        headers: { cookie: owner.cookie }
      }));
      expect(detailResponse.status).toBe(200);
      const detailBody = await json(detailResponse) as {
        backupJob: { stage: string; status: string; userErrorMessage: string | null; internalErrorRef: string | null };
        event: { stage: string; status: string; terminal: boolean; userErrorMessage: string | null; internalErrorRef: string | null };
      };
      expect(detailBody.backupJob.stage).toBe("encrypting");
      expect(detailBody.event.stage).toBe("encrypting");
      expect(detailBody.event.status).toBe("running");
      expect(detailBody.event.terminal).toBeFalse();
      expect(detailBody.event.internalErrorRef).toBe("err_ref_123");
      expect(detailBody.event.userErrorMessage).toBe("Backup failed before verification completed.");

      const eventsResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${workspace.workspace.id}/backup-jobs/${created.backupJob.id}/events`, {
        headers: { cookie: owner.cookie }
      }));
      expect(eventsResponse.status).toBe(200);
      expect(eventsResponse.headers.get("content-type")).toContain("text/event-stream");

      const reader = eventsResponse.body?.getReader();
      expect(reader).toBeTruthy();
      const first = await reader?.read();
      const second = await reader?.read();
      await reader?.cancel();

      const text = new TextDecoder().decode((first?.value ?? new Uint8Array())) + new TextDecoder().decode((second?.value ?? new Uint8Array()));
      expect(text).toContain("event: connected");
      expect(text).toContain("event: job");
      expect(text).toContain('"stage":"encrypting"');
      expect(text).toContain('"status":"running"');
      expect(text).not.toContain("stdout pg_dump");
      expect(text).not.toContain("super-secret-password");
      expect(text).not.toContain("argv");
    } finally {
      await client.end();
    }
  });
});

async function getJobRow(client: ReturnType<typeof createSqlClient>, workspaceId: string, jobId: string) {
  const [job] = await client<{
    id: string;
    workspaceId: string;
    projectId: string;
    databaseSourceId: string;
    trigger: string;
    requestedByUserId: string | null;
    status: string;
    stage: string;
    attemptCount: number;
    maxAttempts: number;
    errorCategory: string | null;
    userErrorMessage: string | null;
    internalErrorRef: string | null;
    queuedAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
    cancelRequestedAt: Date | null;
    cancelRequestedByUserId: string | null;
  }[]>`
    select id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      database_source_id as "databaseSourceId",
      trigger::text as trigger,
      requested_by_user_id as "requestedByUserId",
      status::text as status,
      stage::text as stage,
      attempt_count as "attemptCount",
      max_attempts as "maxAttempts",
      error_category as "errorCategory",
      user_error_message as "userErrorMessage",
      internal_error_ref as "internalErrorRef",
      queued_at as "queuedAt",
      started_at as "startedAt",
      finished_at as "finishedAt",
      cancel_requested_at as "cancelRequestedAt",
      cancel_requested_by_user_id as "cancelRequestedByUserId"
    from backup_jobs
    where id = ${jobId}
      and workspace_id = ${workspaceId}
    limit 1
  `;

  return job ?? null;
}
