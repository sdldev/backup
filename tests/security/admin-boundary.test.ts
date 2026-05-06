import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createApi } from "../../apps/api/src/index";
import { createSqlClient } from "../../packages/db/src/testing";
import { seedHarnessFixtures } from "../harness/fixtures";

async function createSystemSession(databaseUrl: string, role: "system_admin" | "system_owner", token: string, csrf: string, workspaceId: string) {
  const client = createSqlClient(databaseUrl);
  try {
    const [user] = await client<{ id: string }[]>`
      insert into users (email, name)
      values (${`${role}-${token}@example.com`}, ${role})
      returning id
    `;
    await client`insert into workspace_members (workspace_id, user_id, role) values (${workspaceId}, ${user.id}, 'admin')`;
    await client`insert into system_admins (user_id, role) values (${user.id}, ${role})`;
    await client`
      insert into sessions (user_id, session_token_hash, csrf_token_hash, active_workspace_id, expires_at)
      values (${user.id}, ${createHash("sha256").update(token).digest("hex")}, ${createHash("sha256").update(csrf).digest("hex")}, ${workspaceId}, now() + interval '1 day')
    `;
    return { cookie: `mba_session=${token}`, csrf };
  } finally {
    await client.end();
  }
}

describe("system admin customer boundary", () => {
  test("system roles cannot download backups or mutate customer secrets", async () => {
    const seeded = await seedHarnessFixtures();
    const systemAdmin = await createSystemSession(seeded.databaseUrl, "system_admin", "boundary-admin", "csrf-boundary-admin", seeded.workspaces.agencyA.id);
    const systemOwner = await createSystemSession(seeded.databaseUrl, "system_owner", "boundary-owner", "csrf-boundary-owner", seeded.workspaces.agencyA.id);
    const app = createApi({
      auth: { databaseUrl: seeded.databaseUrl },
      backups: { databaseUrl: seeded.databaseUrl, storage: seeded.storage, resolveWorkspaceKey: async () => seeded.workspaceKeys.agencyA },
      sources: { databaseUrl: seeded.databaseUrl }
    });

    for (const session of [systemAdmin, systemOwner]) {
      const download = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/backups/${seeded.backups.agencyA.id}/download-requests`, {
        method: "POST",
        headers: { cookie: session.cookie, "x-csrf-token": session.csrf }
      }));
      expect(download.status).toBe(403);
      expect(await download.json()).toEqual({ error: { code: "backup.download_forbidden" } });

      const mutate = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/database-sources/${seeded.sources.postgres.id}`, {
        method: "PATCH",
        headers: { cookie: session.cookie, "content-type": "application/json", "x-csrf-token": session.csrf },
        body: JSON.stringify({ password: "new-system-secret" })
      }));
      expect(mutate.status).toBe(403);
      expect(await mutate.json()).toEqual({ error: { code: "session.impersonation_denied" } });
    }
  });
});
