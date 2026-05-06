import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";

import { createSqlClient, resolveWorkspacePlanLimits } from "../../packages/db/src/index";
import { createApi } from "../../apps/api/src/index";
import { ensureFreshTestSchema, resolveDatabaseUrl } from "../../scripts/db/_test-db";
import { seedHarnessFixtures } from "../harness/fixtures";

const databaseUrl = resolveDatabaseUrl();
const gib = 1024n ** 3n;

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
      values (${email}, 'Plans User')
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
  return createApi({ auth: { databaseUrl }, workspaces: { databaseUrl }, plans: { databaseUrl } });
}

async function json(response: Response) {
  return await response.json() as Record<string, unknown>;
}

async function seedBackupReadySource(userId: string, workspaceId: string) {
  const client = createSqlClient(databaseUrl);
  try {
    const [project] = await client<{ id: string }[]>`
      insert into projects (workspace_id, name, created_by_user_id)
      values (${workspaceId}, 'Limit Project', ${userId})
      returning id
    `;
    const [source] = await client<{ id: string }[]>`
      insert into database_sources (
        workspace_id, project_id, engine, display_name, technical_database_name, host, port, username, encrypted_password, credential_fingerprint,
        ssl_mode, state, health, retention_days, schedule_frequency_per_day, created_by_user_id
      ) values (
        ${workspaceId}, ${project.id}, 'postgresql', 'Primary', 'app', 'db.internal', 5432, 'postgres', 'enc', 'fp',
        'require', 'enabled', 'healthy', 7, 1, ${userId}
      ) returning id
    `;
    return { projectId: project.id, sourceId: source.id };
  } finally {
    await client.end();
  }
}

describe("plans, requests, limits, and storage gates", () => {
  test("workspace creation requesting Pro keeps Basic active and creates one pending request", async () => {
    await resetDb();
    const { cookie } = await createSession("request-pro@example.com");

    const response = await app().handle(new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": cookie.includes("mba_csrf=") ? cookie.split("mba_csrf=")[1].split(";")[0] : "" },
      body: JSON.stringify({ name: "Request Pro", requested_plan: "pro" })
    }));
    const body = await json(response) as { workspace: { id: string; planSlug: string } };

    expect(response.status).toBe(201);
    expect(body.workspace.planSlug).toBe("basic");

    const client = createSqlClient(databaseUrl);
    try {
      const rows = await client<{ requested_plan: string; status: string }[]>`
        select plans.slug::text as requested_plan, plan_requests.status::text as status
        from plan_requests
        inner join plans on plans.id = plan_requests.requested_plan_id
        where workspace_id = ${body.workspace.id}
      `;
      expect(rows).toEqual([{ requested_plan: "pro", status: "pending" }]);
    } finally {
      await client.end();
    }
  });

  test("API and DB enforce one pending plan request per workspace", async () => {
    await resetDb();
    const { cookie } = await createSession("one-pending@example.com");
    const created = await app().handle(new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": cookie.includes("mba_csrf=") ? cookie.split("mba_csrf=")[1].split(";")[0] : "" },
      body: JSON.stringify({ name: "One Pending" })
    }));
    const createdBody = await json(created) as { workspace: { id: string } };

    const first = await app().handle(new Request(`http://localhost/v1/workspaces/${createdBody.workspace.id}/plan-requests`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": cookie.includes("mba_csrf=") ? cookie.split("mba_csrf=")[1].split(";")[0] : "" },
      body: JSON.stringify({ requested_plan: "agency" })
    }));
    expect(first.status).toBe(201);

    const second = await app().handle(new Request(`http://localhost/v1/workspaces/${createdBody.workspace.id}/plan-requests`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": cookie.includes("mba_csrf=") ? cookie.split("mba_csrf=")[1].split(";")[0] : "" },
      body: JSON.stringify({ requested_plan: "pro" })
    }));
    expect(second.status).toBe(409);
    expect(await json(second)).toEqual({ error: { code: "plan_request_pending_exists" } });

    const client = createSqlClient(databaseUrl);
    try {
      const [pro] = await client<{ id: string }[]>`select id from plans where slug = 'pro' limit 1`;
      const [user] = await client<{ id: string }[]>`select user_id as id from workspace_members where workspace_id = ${createdBody.workspace.id} limit 1`;
      const duplicate = await client<{ id: string }[]>`
        insert into plan_requests (workspace_id, requested_plan_id, requested_by_user_id, status)
        values (${createdBody.workspace.id}, ${pro.id}, ${user.id}, 'pending')
        on conflict do nothing
        returning id
      `;
      expect(duplicate).toEqual([]);

      const [pendingCount] = await client<{ count: string }[]>`
        select count(*)::text as count
        from plan_requests
        where workspace_id = ${createdBody.workspace.id}
          and status = 'pending'
      `;
      expect(pendingCount?.count).toBe("1");
    } finally {
      await client.end({ timeout: 0 });
    }
  });

  test("only owner can create and cancel plan requests", async () => {
    const seeded = await seedHarnessFixtures();
    const api = createApi({ auth: { databaseUrl: seeded.databaseUrl }, workspaces: { databaseUrl: seeded.databaseUrl }, plans: { databaseUrl: seeded.databaseUrl } });

    const adminDenied = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/plan-requests`, {
      method: "POST",
      headers: { cookie: "mba_session=session-admin-a", "content-type": "application/json", "x-csrf-token": "csrf-admin-a" },
      body: JSON.stringify({ requested_plan: "pro" })
    }));
    expect(adminDenied.status).toBe(403);
    expect(await json(adminDenied)).toEqual({ error: { code: "workspace.permission_denied" } });

    const memberDenied = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/plan-requests`, {
      method: "POST",
      headers: { cookie: "mba_session=session-member-a", "content-type": "application/json", "x-csrf-token": "csrf-member-a" },
      body: JSON.stringify({ requested_plan: "pro" })
    }));
    expect(memberDenied.status).toBe(403);
    expect(await json(memberDenied)).toEqual({ error: { code: "workspace.permission_denied" } });

    const ownerCreated = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/plan-requests`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a", "content-type": "application/json", "x-csrf-token": "csrf-a" },
      body: JSON.stringify({ requested_plan: "pro" })
    }));
    const ownerCreatedBody = await json(ownerCreated) as { planRequest: { id: string } };
    expect(ownerCreated.status).toBe(201);

    const adminCancelDenied = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/plan-requests/${ownerCreatedBody.planRequest.id}/cancel`, {
      method: "POST",
      headers: { cookie: "mba_session=session-admin-a", "x-csrf-token": "csrf-admin-a" }
    }));
    expect(adminCancelDenied.status).toBe(403);
    expect(await json(adminCancelDenied)).toEqual({ error: { code: "workspace.permission_denied" } });

    const ownerCancel = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/plan-requests/${ownerCreatedBody.planRequest.id}/cancel`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a", "x-csrf-token": "csrf-a" }
    }));
    expect(ownerCancel.status).toBe(200);
    expect(await json(ownerCancel)).toEqual({ ok: true });
  });

  test("limit resolver uses active override before default and ignores expired override", async () => {
    await resetDb();
    const { cookie, userId } = await createSession("limits@example.com");
    const created = await app().handle(new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": cookie.includes("mba_csrf=") ? cookie.split("mba_csrf=")[1].split(";")[0] : "" },
      body: JSON.stringify({ name: "Limits" })
    }));
    const body = await json(created) as { workspace: { id: string } };

    const client = createSqlClient(databaseUrl);
    try {
      const [admin] = await client<{ id: string }[]>`
        insert into system_admins (user_id, role)
        values (${userId}, 'system_admin')
        returning id
      `;
      await client`
        insert into workspace_limit_overrides (workspace_id, retained_storage_bytes_limit, database_source_limit, reason, created_by_platform_admin_id, expires_at)
        values (${body.workspace.id}, ${1n * gib}, 9, 'expired test', ${admin.id}, now() - interval '1 minute')
      `;
      await client`
        insert into workspace_limit_overrides (workspace_id, retained_storage_bytes_limit, database_source_limit, reason, created_by_platform_admin_id)
        values (${body.workspace.id}, ${2n * gib}, 8, 'active test', ${admin.id})
      `;

      const limits = await resolveWorkspacePlanLimits(client, body.workspace.id);
      expect(limits?.databaseSourceLimit).toBe(8);
      expect(limits?.retainedStorageBytesLimit).toBe(2n * gib);
      expect(limits?.workspaceMemberLimit).toBe(2);
    } finally {
      await client.end();
    }
  });

  test("manual backup job creation is blocked at retained storage limit before queue insert", async () => {
    await resetDb();
    const { cookie, userId } = await createSession("storage-gate@example.com");
    const created = await app().handle(new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": cookie.includes("mba_csrf=") ? cookie.split("mba_csrf=")[1].split(";")[0] : "" },
      body: JSON.stringify({ name: "Storage Gate" })
    }));
    const body = await json(created) as { workspace: { id: string } };
    const { projectId, sourceId } = await seedBackupReadySource(userId, body.workspace.id);

    const client = createSqlClient(databaseUrl);
    try {
      const [storage] = await client<{ id: string }[]>`
        insert into backup_storage_configs (workspace_id, provider, mode, display_name, storage_prefix, credential_fingerprint, status, is_current, activated_at, created_by_user_id)
        values (${body.workspace.id}, 'minio', 'platform_managed', 'Limit Storage', 'opaque/o-limit', 'fp', 'active', true, now(), ${userId})
        returning id
      `;
      const [job] = await client<{ id: string }[]>`
        insert into backup_jobs (workspace_id, project_id, database_source_id, trigger, requested_by_user_id, status, stage, started_at, finished_at)
        values (${body.workspace.id}, ${projectId}, ${sourceId}, 'manual', ${userId}, 'succeeded', 'succeeded', now(), now())
        returning id
      `;
      await client`
        insert into backups (workspace_id, project_id, database_source_id, backup_job_id, storage_config_id, status, engine, format, object_key, download_filename, original_dump_size_bytes, stored_size_bytes, encrypted_checksum, retention_expires_at)
        values (${body.workspace.id}, ${projectId}, ${sourceId}, ${job.id}, ${storage.id}, 'succeeded', 'postgresql', 'postgres_custom', 'opaque/o-limit/objects/fixture04.enc', 'full.dump', ${10n * gib}, ${10n * gib}, 'checksum', now() + interval '7 days')
      `;
    } finally {
      await client.end();
    }

    const denied = await app().handle(new Request(`http://localhost/v1/workspaces/${body.workspace.id}/database-sources/${sourceId}/backup-jobs`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": cookie.includes("mba_csrf=") ? cookie.split("mba_csrf=")[1].split(";")[0] : "" },
    }));
    expect(denied.status).toBe(409);
    expect(await json(denied)).toEqual({ code: "storage_limit_exceeded" });

    const checkClient = createSqlClient(databaseUrl);
    try {
      const [queued] = await checkClient<{ count: string }[]>`
        select count(*)::text as count
        from backup_jobs
        where workspace_id = ${body.workspace.id}
          and status = 'queued'
      `;
      expect(queued?.count).toBe("0");
    } finally {
      await checkClient.end();
    }
  });
});
