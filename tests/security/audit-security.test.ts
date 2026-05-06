import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createApi } from "../../apps/api/src/index";
import { createSqlClient } from "../../packages/db/src/testing";
import { seedHarnessFixtures } from "../harness/fixtures";
import { createMarkerPrinter, shouldRunSecurityGroup } from "../harness/security";

const markers = createMarkerPrinter();

describe("audit security invariants", () => {
  test("SEC-10 sensitive source action emits audit envelope with no secret leakage", async () => {
    if (!shouldRunSecurityGroup("audit")) {
      return;
    }

    const seeded = await seedHarnessFixtures();
    const app = createApi({
      auth: { databaseUrl: seeded.databaseUrl },
      workspaces: { databaseUrl: seeded.databaseUrl },
      storage: { databaseUrl: seeded.databaseUrl },
      projects: { databaseUrl: seeded.databaseUrl },
      sources: { databaseUrl: seeded.databaseUrl },
      audit: { databaseUrl: seeded.databaseUrl }
    });

    const response = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/database-sources/${seeded.sources.postgres.id}`, {
      method: "PATCH",
      headers: {
        cookie: "mba_session=session-a",
        "content-type": "application/json",
        "x-request-id": "sec-10",
        "x-forwarded-for": "127.0.0.20",
        "user-agent": "security-audit-test",
        "x-csrf-token": "csrf-a"
      },
      body: JSON.stringify({ password: "brand-new-secret" })
    }));

    expect(response.status).toBe(200);

    const auditResponse = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/audit-log`, {
      headers: { cookie: "mba_session=session-a" }
    }));
    expect(auditResponse.status).toBe(200);

    const body = await auditResponse.json() as { auditLog: Array<Record<string, unknown>> };
    const latest = body.auditLog.find((entry) => entry.eventType === "database-credential.update");
    expect(latest).toBeDefined();
    expect(latest?.requestId).toBe("sec-10");
    expect(latest?.sessionIdHash).toEqual(expect.any(String));
    expect(latest?.ipAddress).toBe("127.0.0.20");
    expect(latest?.userAgent).toBe("security-audit-test");
    expect(JSON.stringify(latest)).not.toContain("brand-new-secret");
    markers.print("SEC-10");
  });

  test("SEC-10 impersonation audit preserves admin actor, effective actor, and reason", async () => {
    if (!shouldRunSecurityGroup("audit")) {
      return;
    }

    const seeded = await seedHarnessFixtures();
    const client = createSqlClient(seeded.databaseUrl);
    let systemUserId = "";
    try {
      const [user] = await client<{ id: string }[]>`
        insert into users (email, name)
        values ('audit-system-admin@example.com', 'Audit System Admin')
        returning id
      `;
      systemUserId = user.id;
      await client`insert into system_admins (user_id, role) values (${user.id}, 'system_admin')`;
      await client`
        insert into sessions (user_id, session_token_hash, csrf_token_hash, expires_at)
        values (
          ${user.id},
          ${createHash("sha256").update("audit-system-admin").digest("hex")},
          ${createHash("sha256").update("csrf-audit-system-admin").digest("hex")},
          now() + interval '1 day'
        )
      `;
    } finally {
      await client.end();
    }

    const app = createApi({ audit: { databaseUrl: seeded.databaseUrl }, impersonation: { databaseUrl: seeded.databaseUrl } });
    const start = await app.handle(new Request("http://localhost/v1/admin/impersonation/start", {
      method: "POST",
      headers: { cookie: "mba_session=audit-system-admin; mba_csrf=csrf-audit-system-admin", "content-type": "application/json", "x-request-id": "sec-10-imp-start", "x-csrf-token": "csrf-audit-system-admin" },
      body: JSON.stringify({ workspaceId: seeded.workspaces.agencyA.id, targetUserId: seeded.users.agencyA.id, reason: "support audit review" })
    }));
    expect(start.status).toBe(201);

    const auditResponse = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/audit-log`, {
      headers: { cookie: "mba_session=session-a" }
    }));
    const body = await auditResponse.json() as { auditLog: Array<Record<string, unknown>> };
    const latest = body.auditLog.find((entry) => entry.eventType === "impersonation.start");
    expect(latest).toBeDefined();
    expect(latest?.actorUserId).toBe(systemUserId);
    expect(latest?.effectiveActorUserId).toBe(seeded.users.agencyA.id);
    expect(latest?.impersonationReason).toBe("support audit review");
    expect(JSON.stringify(latest)).not.toContain("csrf-audit-system-admin");
    markers.print("SEC-10");
  });
});
