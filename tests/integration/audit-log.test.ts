import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";

import { createApi } from "../../apps/api/src/index";
import { AuditLogService, createSqlClient } from "../../packages/db/src/index";
import { ensureFreshTestSchema, resolveDatabaseUrl } from "../../scripts/db/_test-db";

const databaseUrl = resolveDatabaseUrl();

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
      values (${email}, 'Audit User')
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
  return createApi({
    auth: { databaseUrl },
    workspaces: { databaseUrl },
    storage: { databaseUrl },
    projects: { databaseUrl },
    sources: { databaseUrl },
    audit: { databaseUrl }
  });
}

async function json(response: Response) {
  return await response.json() as Record<string, unknown>;
}

describe("audit log integration", () => {
  test("append-only service blocks mutation and audit API returns required fields for sensitive source actions", async () => {
    await resetDb();
    const owner = await createSession("audit-owner@example.com");

    const workspaceResponse = await app().handle(new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({ name: "Audit Workspace" })
    }));
    const workspaceBody = await json(workspaceResponse) as { workspace: { id: string } };

    const projectResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/projects`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({ name: "Audit Project" })
    }));
    const projectBody = await json(projectResponse) as { project: { id: string } };

    const createResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/projects/${projectBody.project.id}/database-sources`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "x-request-id": "req-audit-create",
        "x-forwarded-for": "127.0.0.10",
        "user-agent": "audit-test",
        "x-csrf-token": owner.csrf
      },
      body: JSON.stringify({
        engine: "postgresql",
        displayName: "Audit Source",
        technicalDatabaseName: "audit_db",
        host: "db.internal",
        port: 5432,
        username: "postgres",
        password: "secret-password",
        sslMode: "require",
        retentionDays: 14
      })
    }));
    expect(createResponse.status).toBe(201);
    const createdBody = await json(createResponse) as { source: { id: string } };

    const patchResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/database-sources/${createdBody.source.id}`, {
      method: "PATCH",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "x-request-id": "req-audit-patch",
        "x-forwarded-for": "127.0.0.10",
        "user-agent": "audit-test",
        "x-csrf-token": owner.csrf
      },
      body: JSON.stringify({ password: "replacement-secret-password" })
    }));
    expect(patchResponse.status).toBe(200);

    const auditResponse = await app().handle(new Request(`http://localhost/v1/workspaces/${workspaceBody.workspace.id}/audit-log`, {
      headers: { cookie: owner.cookie }
    }));
    expect(auditResponse.status).toBe(200);

    const auditBody = await json(auditResponse) as { auditLog: Array<Record<string, unknown>> };
    const credentialAudit = auditBody.auditLog.find((entry) => entry.eventType === "database-credential.update");
    expect(credentialAudit).toBeDefined();
    expect(credentialAudit?.actorUserId).toEqual(expect.any(String));
    expect(credentialAudit?.effectiveActorUserId).toEqual(expect.any(String));
    expect(credentialAudit?.workspaceId).toBe(workspaceBody.workspace.id);
    expect(credentialAudit?.targetType).toBe("database_credential");
    expect(credentialAudit?.targetId).toBe(createdBody.source.id);
    expect(credentialAudit?.requestId).toBe("req-audit-patch");
    expect(credentialAudit?.sessionIdHash).toEqual(expect.any(String));
    expect(credentialAudit?.ipAddress).toBe("127.0.0.10");
    expect(credentialAudit?.userAgent).toBe("audit-test");
    expect(credentialAudit?.impersonationReason).toBeNull();
    expect(credentialAudit?.result).toBe("succeeded");
    expect(credentialAudit?.internalErrorRef).toBeNull();

    const service = new AuditLogService(databaseUrl);
    await expect(service.update()).rejects.toThrow(/append_only|forbidden/i);
    await expect(service.delete()).rejects.toThrow(/append_only|forbidden/i);
  });
});
