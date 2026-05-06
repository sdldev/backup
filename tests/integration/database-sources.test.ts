import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";

import { createSqlClient } from "../../packages/db/src/index";
import { createApi } from "../../apps/api/src/index";
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
      values (${email}, 'Database Sources User')
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
  return createApi({ auth: { databaseUrl }, workspaces: { databaseUrl }, storage: { databaseUrl }, projects: { databaseUrl }, sources: { databaseUrl } });
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
  return await json(response) as { workspace: { id: string } };
}

async function createProject(cookie: string, workspaceId: string, name = "Source Project") {
  const response = await app().handle(new Request(`http://localhost/v1/workspaces/${workspaceId}/projects`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-csrf-token": cookie.includes("mba_csrf=") ? cookie.split("mba_csrf=")[1].split(";")[0] : "" },
    body: JSON.stringify({ name })
  }));
  return await json(response) as { project: { id: string } };
}

describe("database source API", () => {
  test("source CRUD hides secrets, ignores schedule fields, and enforces member delete deny", async () => {
    await resetDb();
    const owner = await createSession("sources-owner@example.com");
    const createdWorkspace = await createWorkspace(owner.cookie, "Sources Workspace");
    const createdProject = await createProject(owner.cookie, createdWorkspace.workspace.id);

    const createResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${createdWorkspace.workspace.id}/projects/${createdProject.project.id}/database-sources`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({
        engine: "postgresql",
        displayName: "Primary Source",
        technicalDatabaseName: "app_db",
        host: "db.internal",
        port: 5432,
        username: "postgres",
        password: "super-secret-password",
        sslMode: "require",
        retentionDays: 14,
        scheduleEnabled: true,
        scheduleFrequencyPerDay: 5
      })
    }));

    expect(createResponse.status).toBe(201);
    const createdBody = await json(createResponse) as { source: Record<string, unknown> };
    expect(createdBody.source.password).toBeUndefined();
    expect(createdBody.source.encryptedPassword).toBeUndefined();
    expect(createdBody.source.credentialFingerprint).toEqual(expect.any(String));
    expect(createdBody.source.passwordMasked).toEqual(expect.any(String));
    expect(createdBody.source.scheduleEnabled).toBe(false);
    expect(createdBody.source.scheduleFrequencyPerDay).toBe(1);

    const detailResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${createdWorkspace.workspace.id}/database-sources/${createdBody.source.id}`, {
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }
    }));
    expect(detailResponse.status).toBe(200);
    const detailBody = await json(detailResponse) as { source: Record<string, unknown> };
    expect(detailBody.source.password).toBeUndefined();
    expect(detailBody.source.encryptedPassword).toBeUndefined();
    expect(detailBody.source.passwordMasked).toEqual(expect.any(String));
    expect(detailBody.source.credentialFingerprint).toEqual(expect.any(String));
    expect(detailBody.source.scheduleEnabled).toBe(false);
    expect(detailBody.source.scheduleFrequencyPerDay).toBe(1);

    const enableBeforeTestResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${createdWorkspace.workspace.id}/database-sources/${createdBody.source.id}/enable`, {
      method: "POST",
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }
    }));
    expect(enableBeforeTestResponse.status).toBe(409);

    const savedTestResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${createdWorkspace.workspace.id}/database-sources/${createdBody.source.id}/test-connection`, {
      method: "POST",
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }
    }));
    expect(savedTestResponse.status).toBe(200);

    const enableAfterTestResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${createdWorkspace.workspace.id}/database-sources/${createdBody.source.id}/enable`, {
      method: "POST",
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }
    }));
    expect(enableAfterTestResponse.status).toBe(200);

    const patchSecretResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${createdWorkspace.workspace.id}/database-sources/${createdBody.source.id}`, {
      method: "PATCH",
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({ password: "replacement-secret-password" })
    }));
    expect(patchSecretResponse.status).toBe(200);
    const patchSecretBody = await json(patchSecretResponse) as { source: Record<string, unknown> };
    expect(patchSecretBody.source.state).toBe("disabled");
    expect(patchSecretBody.source.lastConnectionTestStatus).toBe("pending");

    const movedProject = await createProject(owner.cookie, createdWorkspace.workspace.id, "Moved Target Project");
    const moveResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${createdWorkspace.workspace.id}/database-sources/${createdBody.source.id}/move`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({ projectId: movedProject.project.id })
    }));
    expect(moveResponse.status).toBe(200);
    const moveBody = await json(moveResponse) as { source: Record<string, unknown> };
    expect(moveBody.source.projectId).toBe(movedProject.project.id);

    await resetDb();
    const ownerTwo = await createSession("sources-owner-2@example.com");
    const member = await createSession("sources-member@example.com");
    const createdWorkspaceTwo = await createWorkspace(ownerTwo.cookie, "Source Role Matrix");
    const createdProjectTwo = await createProject(ownerTwo.cookie, createdWorkspaceTwo.workspace.id);

    const client = createSqlClient(databaseUrl);
    try {
      await client`
        insert into workspace_members (workspace_id, user_id, role)
        values (${createdWorkspaceTwo.workspace.id}, ${member.userId}, 'member')
      `;
    } finally {
      await client.end();
    }

    const memberCreateResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${createdWorkspaceTwo.workspace.id}/projects/${createdProjectTwo.project.id}/database-sources`, {
      method: "POST",
      headers: { cookie: member.cookie, "content-type": "application/json", "x-csrf-token": member.csrf },
      body: JSON.stringify({
        engine: "mysql",
        displayName: "Member Source",
        technicalDatabaseName: "member_db",
        host: "mysql.internal",
        port: 3306,
        username: "root",
        password: "member-secret-password",
        sslMode: "required",
        retentionDays: 14
      })
    }));
    expect(memberCreateResponse.status).toBe(201);
    const memberCreateBody = await json(memberCreateResponse) as { source: { id: string } };

    const testResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${createdWorkspaceTwo.workspace.id}/database-sources/${memberCreateBody.source.id}/test-connection`, {
      method: "POST",
      headers: { cookie: member.cookie, "x-csrf-token": member.csrf }
    }));
    expect(testResponse.status).toBe(200);

    const deleteResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${createdWorkspaceTwo.workspace.id}/database-sources/${memberCreateBody.source.id}`, {
      method: "DELETE",
      headers: { cookie: member.cookie, "x-csrf-token": member.csrf }
    }));
    expect(deleteResponse.status).toBe(403);
  });
});
