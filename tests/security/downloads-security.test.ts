import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createApi } from "../../apps/api/src/index";
import { createSqlClient } from "../../packages/db/src/testing";
import { seedHarnessFixtures } from "../harness/fixtures";
import { createMarkerPrinter, shouldRunSecurityGroup } from "../harness/security";

const markers = createMarkerPrinter();

describe("download token security invariants", () => {
  test("SEC-05 and SEC-06 download misuse paths fail and tokens stay single-use", async () => {
    const needsDownloads = shouldRunSecurityGroup("downloads");
    const needsImpersonation = shouldRunSecurityGroup("impersonation");
    if (!needsDownloads && !needsImpersonation) {
      return;
    }

    const seeded = await seedHarnessFixtures();
    const app = createApi({
      auth: { databaseUrl: seeded.databaseUrl },
      workspaces: { databaseUrl: seeded.databaseUrl },
      audit: { databaseUrl: seeded.databaseUrl },
      backups: {
        databaseUrl: seeded.databaseUrl,
        storage: seeded.storage,
        resolveWorkspaceKey: async (workspaceId) => workspaceId === seeded.workspaces.agencyA.id ? seeded.workspaceKeys.agencyA : seeded.workspaceKeys.agencyB
      }
    });

    const createRequest = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/backups/${seeded.backups.agencyA.id}/download-requests`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a; mba_csrf=csrf-a", "x-csrf-token": "csrf-a", "x-request-id": "dl-req-a", "user-agent": "downloads-security" }
    }));
    expect(createRequest.status).toBe(201);
    const created = await createRequest.json() as { downloadToken: string; filename: string };
    expect(created.downloadToken).toEqual(expect.any(String));
    expect(created.filename).toMatch(/\.dump$/);

    const client = createSqlClient(seeded.databaseUrl);
    try {
      const [stored] = await client<{ token_hash: string; consumed_at: Date | null }[]>`
        select token_hash, consumed_at
        from download_requests
        where backup_id = ${seeded.backups.agencyA.id}
        order by created_at desc
        limit 1
      `;
      expect(stored.token_hash).not.toBe(created.downloadToken);
      expect(stored.consumed_at).toBeNull();
    } finally {
      await client.end();
    }

    const streamResponse = await app.handle(new Request(`http://localhost/v1/downloads/${created.downloadToken}`, {
      headers: { cookie: "mba_session=session-a", "x-request-id": "dl-stream-a", "user-agent": "downloads-security" }
    }));
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("content-disposition")).toContain(".dump");
    const bytes = new Uint8Array(await streamResponse.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toContain("fake postgresql dump");

    const replay = await app.handle(new Request(`http://localhost/v1/downloads/${created.downloadToken}`, {
      headers: { cookie: "mba_session=session-a" }
    }));
    expect(replay.status).toBe(403);

    const secondCreate = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/backups/${seeded.backups.agencyA.id}/download-requests`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a; mba_csrf=csrf-a", "x-csrf-token": "csrf-a" }
    }));
    const second = await secondCreate.json() as { downloadToken: string };

    await app.handle(new Request("http://localhost/v1/auth/logout", {
      method: "POST",
      headers: { cookie: "mba_session=session-a; mba_csrf=csrf-a", "x-csrf-token": "csrf-a" }
    }));

    const sessionMismatch = await app.handle(new Request(`http://localhost/v1/downloads/${second.downloadToken}`, {
      headers: { cookie: "mba_session=session-b" }
    }));
    expect([401, 403]).toContain(sessionMismatch.status);

    if (needsDownloads) {
      markers.print("SEC-06");
    }

    const impersonationClient = createSqlClient(seeded.databaseUrl);
    const impersonatedToken = "session-impersonated-a";
    const impersonatedCsrf = "csrf-impersonated-a";
    try {
      const [admin] = await impersonationClient<{ id: string }[]>`
        insert into users (email, name)
        values ('downloads-admin@example.com', 'Downloads Admin')
        returning id
      `;
      const [session] = await impersonationClient<{ id: string }[]>`
        insert into sessions (user_id, session_token_hash, csrf_token_hash, active_workspace_id, expires_at)
        values (
          ${seeded.users.agencyA.id},
          ${createHash("sha256").update(impersonatedToken).digest("hex")},
          ${createHash("sha256").update(impersonatedCsrf).digest("hex")},
          ${seeded.workspaces.agencyA.id},
          now() + interval '1 day'
        )
        returning id
      `;
      await impersonationClient`
        insert into impersonation_sessions (admin_session_id, admin_user_id, target_user_id, reason)
        values (${session.id}, ${admin.id}, ${seeded.users.agencyA.id}, 'support')
      `;
    } finally {
      await impersonationClient.end();
    }

    const impersonated = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/backups/${seeded.backups.agencyA.id}/download-requests`, {
      method: "POST",
      headers: { cookie: `mba_session=${impersonatedToken}; mba_csrf=${impersonatedCsrf}`, "x-csrf-token": impersonatedCsrf }
    }));
    expect(impersonated.status).toBe(403);
    expect(await impersonated.json()).toEqual({ error: { code: "session.impersonation_denied" } });

    if (needsImpersonation) {
      markers.print("SEC-05");
    }
  });
});
