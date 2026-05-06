import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";

import { createApi } from "../../apps/api/src/index";
import {
  applyBackupJobConnectionState,
  applyBackupJobEvent,
  buildBackupProgressStatusRegion,
  buildDashboardEmptyState,
  buildFormErrorSummary,
  buildFormFieldAccessibilityState,
  buildFirstBackupFailureModel,
  buildWorkspaceMemberListItem,
  createBackupJobDetailState,
  createDatabaseSourceWizardDraft,
  getBackupJobKeyboardOrder,
  getDatabaseSourceEnableIntent,
  type BackupJobEventSnapshot
} from "../../apps/web/src/app";
import { claimNextBackupJob, failBackupJob, processBackupPipeline, provisionWorkspaceStorage } from "../../apps/worker/src/index";
import { createSqlClient } from "../../packages/db/src/index";
import { wrapBackupDataKey } from "../../packages/security/src/index";
import { ensureFreshTestSchema, resolveDatabaseUrl } from "../../scripts/db/_test-db";
import { createE2EHarnessConfig } from "../harness/e2e-config";
import { createFakeDumpProcess } from "../harness/fake-dump";
import { assertVerifiedFakeOAuthIdentity, resolveFakeOAuthIdentity } from "../harness/fake-oauth";
import { FakeS3Storage } from "../harness/fake-storage";

const databaseUrl = resolveDatabaseUrl();
const artifactRoot = "test-results/e2e/onboarding";
const ownerWorkspaceKey = new Uint8Array(32).fill(41);
const ownerBackupDataKey = new Uint8Array(32).fill(42);

setDefaultTimeout(30_000);

type Session = { cookie: string; csrf: string; userId: string };

function hashValue(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function resetDb() {
  await ensureFreshTestSchema(databaseUrl);
}

async function writeArtifact(name: string, value: unknown) {
  await mkdir(artifactRoot, { recursive: true });
  await Bun.write(`${artifactRoot}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
}

async function createMockOAuthSession(provider: "google" | "github", email: string): Promise<Session> {
  const identity = assertVerifiedFakeOAuthIdentity(resolveFakeOAuthIdentity(provider, email));
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const client = createSqlClient(databaseUrl);

  try {
    const [user] = await client<{ id: string }[]>`
      insert into users (email, name)
      values (${identity.email}, ${identity.name})
      on conflict (email) do update set name = excluded.name
      returning id
    `;

    await client`
      insert into oauth_accounts (user_id, provider, provider_account_id, provider_email)
      values (${user.id}, ${identity.provider}, ${identity.providerAccountId}, ${identity.email})
      on conflict (provider, provider_account_id) do nothing
    `;
    await client`
      insert into sessions (user_id, session_token_hash, csrf_token_hash, expires_at)
      values (${user.id}, ${hashValue(token)}, ${hashValue(csrf)}, now() + interval '7 days')
    `;

    return { cookie: `mba_session=${token}; mba_csrf=${csrf}`, csrf, userId: user.id };
  } finally {
    await client.end();
  }
}

function app(storage = new FakeS3Storage()) {
  return createApi({
    auth: { databaseUrl },
    workspaces: { databaseUrl },
    storage: { databaseUrl },
    projects: { databaseUrl },
    sources: { databaseUrl },
    backupJobs: { databaseUrl },
    backups: { databaseUrl, storage, resolveWorkspaceKey: () => ownerWorkspaceKey },
    invites: { databaseUrl }
  });
}

async function json(response: Response) {
  return await response.json() as Record<string, unknown>;
}

async function readSseSnapshots(response: Response): Promise<BackupJobEventSnapshot[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line) as BackupJobEventSnapshot);
}

describe("onboarding e2e", () => {
  test("onboarding.happy covers OAuth mock to permission UI", async () => {
    await resetDb();
    const config = createE2EHarnessConfig();
    const storage = new FakeS3Storage();
    const api = app(storage);
    const owner = await createMockOAuthSession("google", "agency-a@example.com");

    expect(config.useRealExternalServices).toBeFalse();
    expect(config.flow).toEqual(["oauth-mock", "workspace", "project", "source", "backup", "download", "invite"]);

    const workspaceResponse = await api.handle(new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({ name: "Onboarding Agency", timezone: "America/New_York" })
    }));
    const workspaceBody = await json(workspaceResponse) as { workspace: { id: string; slug: string; role: string; storageStatus: string } };
    expect(workspaceResponse.status).toBe(201);
    expect(workspaceBody.workspace).toMatchObject({ slug: "onboarding-agency", role: "owner", storageStatus: "provisioning" });

    const provisioned = await provisionWorkspaceStorage(workspaceBody.workspace.id, databaseUrl);
    expect(provisioned.status).toBe("ready");

    const projectResponse = await api.handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/projects`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({ name: "Client Main", website_url: "https://client.example" })
    }));
    const projectBody = await json(projectResponse) as { project: { id: string; name: string } };
    expect(projectResponse.status).toBe(201);

    const draft = createDatabaseSourceWizardDraft("postgresql");
    Object.assign(draft, {
      displayName: "Primary Postgres",
      technicalDatabaseName: "app_db",
      host: "db.internal",
      username: "postgres",
      password: "super-secret-password",
      retentionDays: 14
    });
    const sourceResponse = await api.handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/projects/${projectBody.project.id}/database-sources`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify(draft)
    }));
    const sourceBody = await json(sourceResponse) as { source: { id: string } };
    expect(sourceResponse.status).toBe(201);

    const tested = await api.handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/database-sources/${sourceBody.source.id}/test-connection`, { method: "POST", headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf } }));
    expect(tested.status).toBe(200);
    expect(getDatabaseSourceEnableIntent("succeeded")).toEqual({ allowed: true, reason: "ready" });
    const enabled = await api.handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/database-sources/${sourceBody.source.id}/enable`, { method: "POST", headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf } }));
    expect(enabled.status).toBe(200);

    const queued = await api.handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/database-sources/${sourceBody.source.id}/backup-jobs`, { method: "POST", headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf } }));
    const queuedBody = await json(queued) as { backupJob: { id: string } };
    expect(queued.status).toBe(201);

    const client = createSqlClient(databaseUrl);
    try {
      const job = await claimNextBackupJob(client);
      expect(job?.id).toBe(queuedBody.backupJob.id);
      if (!job) {
        throw new Error("Expected queued backup job to be claimable");
      }
      const result = await processBackupPipeline({
        client,
        storage,
        job,
        workspaceKey: ownerWorkspaceKey,
        remainingStorageBytes: 10_000_000n,
        dumpRunner: async (_command, source) => new ReadableStream({ start(controller) { controller.enqueue(createFakeDumpProcess(source.engine, source.displayName).stdout); controller.close(); } })
      });
      const [backup] = await client<{ id: string }[]>`
        select id
        from backups
        where backup_job_id = ${job.id}
        limit 1
      `;
      if (!backup) {
        throw new Error("Expected first backup metadata to be committed");
      }
      const wrappedDataKey = await wrapBackupDataKey({ workspaceId: job.workspaceId, backupId: backup.id, backupDataKey: ownerBackupDataKey, workspaceKey: ownerWorkspaceKey });
      await client`
        update backup_encryption_keys
        set wrapped_data_key = ${JSON.stringify(wrappedDataKey)}
        where backup_id = ${backup.id}
      `;
      expect(storage.hasObject(result.objectKey)).toBeTrue();
    } finally {
      await client.end();
    }

    const eventsResponse = await api.handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/backup-jobs/${queuedBody.backupJob.id}/events`, { headers: { cookie: owner.cookie } }));
    const events = await readSseSnapshots(eventsResponse);
    const terminal = events.at(-1);
    if (!terminal) {
      throw new Error("Expected SSE terminal backup event");
    }
    const detail = applyBackupJobEvent(applyBackupJobConnectionState(createBackupJobDetailState(queuedBody.backupJob.id), "live"), terminal);
    const statusRegion = buildBackupProgressStatusRegion(terminal);
    expect(detail.status).toBe("succeeded");
    expect(detail.actions.map((action) => action.kind)).toEqual(["download"]);
    expect(statusRegion).toEqual({
      role: "status",
      ariaLive: "polite",
      ariaAtomic: true,
      message: "Backup finished. Download ready."
    });
    expect(getBackupJobKeyboardOrder(detail)).toEqual(["download"]);

    const firstBackup = await json(await api.handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/first-backup`, { headers: { cookie: owner.cookie } }))) as { firstBackup: { backupId: string; invitePromptVisible: boolean } };
    expect(firstBackup.firstBackup.invitePromptVisible).toBeTrue();
    expect(buildDashboardEmptyState("team_invite").description).toContain("No notification or webhook setup required in v1.");

    const downloadRequest = await api.handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/backups/${firstBackup.firstBackup.backupId}/download-requests`, { method: "POST", headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf } }));
    const downloadBody = await json(downloadRequest) as { downloadToken: string; filename: string };
    expect(downloadRequest.status).toBe(201);
    const downloaded = await api.handle(new Request(`http://localhost/v1/downloads/${downloadBody.downloadToken}`, { headers: { cookie: owner.cookie } }));
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-disposition")).toContain(downloadBody.filename);

    const invite = await api.handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/invites`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({ role: "member" })
    }));
    const inviteBody = await json(invite) as { token: string };
    expect(invite.status).toBe(201);

    const invitee = await createMockOAuthSession("github", "agency-b@example.com");
    const accepted = await api.handle(new Request(`http://localhost/v1/invites/${inviteBody.token}/accept`, {
      method: "POST",
      headers: { cookie: invitee.cookie, "content-type": "application/json", "x-csrf-token": invitee.csrf },
      body: JSON.stringify({ confirm: true })
    }));
    const acceptedBody = await json(accepted) as { member: { id: string; userId: string; email: string; name: string; role: "member" } };
    expect(accepted.status).toBe(200);
    const memberUi = buildWorkspaceMemberListItem(acceptedBody.member, { userId: acceptedBody.member.userId, role: "member" });
    expect(memberUi.actions).toEqual({ canPromoteToAdmin: false, canDemoteToMember: false, canRemove: false, canReceiveOwnership: false });

    await writeArtifact("onboarding.happy", { workspace: workspaceBody.workspace.slug, backupId: firstBackup.firstBackup.backupId, sseStages: events.map((event) => event.stage), download: downloadBody.filename, memberUi });
  });

  test("onboarding.backup-failure covers retry/edit recovery surface", async () => {
    await resetDb();
    const api = app();
    const owner = await createMockOAuthSession("google", "agency-a@example.com");

    const workspaceBody = await json(await api.handle(new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({ name: "Failure Recovery" })
    }))) as { workspace: { id: string } };
    await provisionWorkspaceStorage(workspaceBody.workspace.id, databaseUrl);

    const projectBody = await json(await api.handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/projects`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({ name: "Failure Project" })
    }))) as { project: { id: string } };
    const sourceBody = await json(await api.handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/projects/${projectBody.project.id}/database-sources`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({ engine: "postgresql", displayName: "Failing Source", technicalDatabaseName: "app_db", host: "db.internal", port: 5432, username: "postgres", password: "secret", sslMode: "require", retentionDays: 7 })
    }))) as { source: { id: string } };
    expect((await api.handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/database-sources/${sourceBody.source.id}/test-connection`, { method: "POST", headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf } }))).status).toBe(200);
    expect((await api.handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/database-sources/${sourceBody.source.id}/enable`, { method: "POST", headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf } }))).status).toBe(200);

    const queuedBody = await json(await api.handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/database-sources/${sourceBody.source.id}/backup-jobs`, { method: "POST", headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf } }))) as { backupJob: { id: string } };

    const client = createSqlClient(databaseUrl);
    try {
      const job = await claimNextBackupJob(client);
      expect(job?.id).toBe(queuedBody.backupJob.id);
      if (!job) {
        throw new Error("Expected queued backup job to be claimable");
      }
      await failBackupJob(client, job, { category: "permanent", message: "Backup failed before verification completed.", internalErrorRef: "internal-secret-ref-42" });
    } finally {
      await client.end();
    }

    const events = await readSseSnapshots(await api.handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/backup-jobs/${queuedBody.backupJob.id}/events`, { headers: { cookie: owner.cookie } })));
    const failed = events.at(-1);
    if (!failed) {
      throw new Error("Expected SSE failed backup event");
    }
    const detail = applyBackupJobEvent(createBackupJobDetailState(queuedBody.backupJob.id), failed);
    const failureUi = buildFirstBackupFailureModel({ backupJobId: queuedBody.backupJob.id, failedStage: detail.stage, failureReason: detail.failureMessage });
    const statusRegion = buildBackupProgressStatusRegion(failed);
    const fieldState = buildFormFieldAccessibilityState({
      formId: "source-edit",
      field: "host",
      required: true,
      errorMessage: "Host is required.",
      description: "Private hostname or IP for database connection."
    });
    const errorSummary = buildFormErrorSummary([{ field: "host", message: "Host is required." }]);

    expect(detail.status).toBe("failed");
    expect(failureUi.actions).toEqual(["retry", "edit"]);
    expect(failureUi.failureReason).toBe("Backup failed before verification completed.");
    expect(JSON.stringify(failureUi)).not.toContain("internal-secret-ref-42");
    expect(detail.internalErrorRef).toBe("internal-secret-ref-42");
    expect(statusRegion.message).toBe("Backup failed before verification completed.");
    expect(getBackupJobKeyboardOrder(detail)).toEqual(["retry", "edit"]);
    expect(fieldState.invalid).toBeTrue();
    expect(fieldState.describedBy).toEqual(["source-edit-host-description", "source-edit-host-error"]);
    expect(errorSummary?.role).toBe("alert");

    await writeArtifact("onboarding.backup-failure", { backupJobId: queuedBody.backupJob.id, failedStage: failureUi.failedStage, actions: failureUi.actions, sanitized: failureUi.failureReason });
  });
});
