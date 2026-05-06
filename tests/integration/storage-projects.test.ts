import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";

import { createSqlClient } from "../../packages/db/src/index";
import { createApi } from "../../apps/api/src/index";
import { provisionWorkspaceStorage } from "../../packages/storage/src/index";
import { ensureFreshTestSchema, resolveDatabaseUrl } from "../../scripts/db/_test-db";

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
      values (${email}, 'Storage Projects User')
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
  return createApi({ auth: { databaseUrl }, workspaces: { databaseUrl }, storage: { databaseUrl }, projects: { databaseUrl } });
}

async function json(response: Response) {
  return await response.json() as Record<string, unknown>;
}

async function createWorkspace(cookie: string, name: string) {
  const response = await app().handle(new Request("http://localhost/v1/workspaces", {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-csrf-token": cookie.includes("mba_csrf=") ? cookie.split("mba_csrf=")[1].split(";")[0] : "" },
    body: JSON.stringify({ name })
  }));
  return await json(response) as { workspace: { id: string; slug: string; storageStatus: string } };
}

describe("storage provisioning and project CRUD", () => {
  test("workspace starts provisioning and worker activates opaque platform-managed storage", async () => {
    await resetDb();
    const { cookie } = await createSession("storage-success@example.com");

    const created = await createWorkspace(cookie, "Readable Client Name");
    expect(created.workspace.storageStatus).toBe("provisioning");

    const before = await app().handle(new Request(`http://localhost/v1/workspaces/${created.workspace.id}/storage`, { headers: { cookie } }));
    const beforeBody = await json(before) as { storage: { status: string; config: unknown } };
    expect(before.status).toBe(200);
    expect(beforeBody.storage).toMatchObject({ status: "provisioning", config: null });

    const result = await provisionWorkspaceStorage(created.workspace.id, databaseUrl);
    expect(result.status).toBe("ready");

    const after = await app().handle(new Request(`http://localhost/v1/workspaces/${created.workspace.id}/storage`, { headers: { cookie } }));
    const afterBody = await json(after) as { storage: { status: string; config: { provider: string; mode: string; status: string } } };
    expect(after.status).toBe(200);
    expect(afterBody.storage).toMatchObject({ status: "ready", config: { provider: "minio", mode: "platform_managed", status: "active" } });

    const client = createSqlClient(databaseUrl);
    try {
      const [storage] = await client<{ storage_prefix: string; mode: string; is_current: boolean }[]>`
        select storage_prefix, mode::text, is_current
        from backup_storage_configs
        where workspace_id = ${created.workspace.id}
        limit 1
      `;
      expect(storage?.mode).toBe("platform_managed");
      expect(storage?.is_current).toBe(true);
      expect(storage?.storage_prefix).toStartWith("pm/");
      expect(storage?.storage_prefix).not.toContain("readable");
      expect(storage?.storage_prefix).not.toContain("client");
      expect(storage?.storage_prefix).not.toContain("name");
    } finally {
      await client.end();
    }
  });

  test("retry is owner-only during onboarding and owner/admin after onboarding", async () => {
    await resetDb();
    const owner = await createSession("retry-owner@example.com");
    const member = await createSession("retry-member@example.com");
    const admin = await createSession("retry-admin@example.com");
    const created = await createWorkspace(owner.cookie, "Retry Matrix");

    const client = createSqlClient(databaseUrl);
    try {
      await client`
        insert into workspace_members (workspace_id, user_id, role)
        values (${created.workspace.id}, ${member.userId}, 'member'), (${created.workspace.id}, ${admin.userId}, 'admin')
      `;
      await client`update workspaces set storage_status = 'failed', onboarding_step = 'project' where id = ${created.workspace.id}`;
    } finally {
      await client.end();
    }

    const memberOnboarding = await app().handle(new Request(`http://localhost/v1/workspaces/${created.workspace.id}/storage/retry`, { method: "POST", headers: { cookie: member.cookie, "x-csrf-token": member.csrf } }));
    expect(memberOnboarding.status).toBe(403);
    const adminOnboarding = await app().handle(new Request(`http://localhost/v1/workspaces/${created.workspace.id}/storage/retry`, { method: "POST", headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf } }));
    expect(adminOnboarding.status).toBe(403);
    const ownerOnboarding = await app().handle(new Request(`http://localhost/v1/workspaces/${created.workspace.id}/storage/retry`, { method: "POST", headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf } }));
    expect(ownerOnboarding.status).toBe(200);

    const clientAfterOwner = createSqlClient(databaseUrl);
    try {
      await clientAfterOwner`update workspaces set storage_status = 'failed', onboarding_step = 'complete' where id = ${created.workspace.id}`;
    } finally {
      await clientAfterOwner.end();
    }

    const memberComplete = await app().handle(new Request(`http://localhost/v1/workspaces/${created.workspace.id}/storage/retry`, { method: "POST", headers: { cookie: member.cookie, "x-csrf-token": member.csrf } }));
    expect(memberComplete.status).toBe(403);
    const adminComplete = await app().handle(new Request(`http://localhost/v1/workspaces/${created.workspace.id}/storage/retry`, { method: "POST", headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf } }));
    expect(adminComplete.status).toBe(200);
  });

  test("project CRUD is workspace-scoped, soft-deletes, and enforces active-name uniqueness", async () => {
    await resetDb();
    const first = await createSession("projects-one@example.com");
    const second = await createSession("projects-two@example.com");
    const firstWorkspace = await createWorkspace(first.cookie, "Projects One");
    const secondWorkspace = await createWorkspace(second.cookie, "Projects Two");

    const created = await app().handle(new Request(`http://localhost/v1/workspaces/${firstWorkspace.workspace.id}/projects`, {
      method: "POST",
      headers: { cookie: first.cookie, "content-type": "application/json", "x-csrf-token": first.csrf },
      body: JSON.stringify({ name: "Client Portal", website_url: "https://client.example" })
    }));
    const createdBody = await json(created) as { project: { id: string; name: string; websiteUrl: string; deleted: boolean } };
    expect(created.status).toBe(201);
    expect(createdBody.project).toMatchObject({ name: "Client Portal", websiteUrl: "https://client.example/", deleted: false });

    const duplicate = await app().handle(new Request(`http://localhost/v1/workspaces/${firstWorkspace.workspace.id}/projects`, {
      method: "POST",
      headers: { cookie: first.cookie, "content-type": "application/json", "x-csrf-token": first.csrf },
      body: JSON.stringify({ name: "Client Portal" })
    }));
    expect(duplicate.status).toBe(409);

    const scopedMiss = await app().handle(new Request(`http://localhost/v1/workspaces/${secondWorkspace.workspace.id}/projects/${createdBody.project.id}`, { headers: { cookie: second.cookie } }));
    expect(scopedMiss.status).toBe(404);

    const patched = await app().handle(new Request(`http://localhost/v1/workspaces/${firstWorkspace.workspace.id}/projects/${createdBody.project.id}`, {
      method: "PATCH",
      headers: { cookie: first.cookie, "content-type": "application/json", "x-csrf-token": first.csrf },
      body: JSON.stringify({ name: "Client Portal Renamed", websiteUrl: null })
    }));
    const patchedBody = await json(patched) as { project: { name: string; websiteUrl: string | null } };
    expect(patched.status).toBe(200);
    expect(patchedBody.project).toMatchObject({ name: "Client Portal Renamed", websiteUrl: null });

    const deleted = await app().handle(new Request(`http://localhost/v1/workspaces/${firstWorkspace.workspace.id}/projects/${createdBody.project.id}`, { method: "DELETE", headers: { cookie: first.cookie, "x-csrf-token": first.csrf } }));
    expect(deleted.status).toBe(200);
    const hidden = await app().handle(new Request(`http://localhost/v1/workspaces/${firstWorkspace.workspace.id}/projects/${createdBody.project.id}`, { headers: { cookie: first.cookie } }));
    expect(hidden.status).toBe(404);

    const recreated = await app().handle(new Request(`http://localhost/v1/workspaces/${firstWorkspace.workspace.id}/projects`, {
      method: "POST",
      headers: { cookie: first.cookie, "content-type": "application/json", "x-csrf-token": first.csrf },
      body: JSON.stringify({ name: "Client Portal Renamed" })
    }));
    expect(recreated.status).toBe(201);

    const listed = await app().handle(new Request(`http://localhost/v1/workspaces/${firstWorkspace.workspace.id}/projects`, { headers: { cookie: first.cookie } }));
    const listedBody = await json(listed) as { projects: { name: string; deleted: boolean }[] };
    expect(listedBody.projects).toEqual([expect.objectContaining({ name: "Client Portal Renamed", deleted: false })]);
  });

  test("BYOS mutation routes remain absent", async () => {
    await resetDb();
    const { cookie } = await createSession("byos-absent@example.com");
    const created = await createWorkspace(cookie, "BYOS Absent");

    for (const path of ["backup-storage", "backup-storage/test", "backup-storage/activate", "backup-storage/retire"]) {
      const response = await app().handle(new Request(`http://localhost/v1/workspaces/${created.workspace.id}/${path}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-csrf-token": cookie.includes("mba_csrf=") ? cookie.split("mba_csrf=")[1].split(";")[0] : "" },
        body: JSON.stringify({ provider: "aws_s3" })
      }));
      expect(response.status).toBe(404);
    }
  });
});
