import { describe, expect, test } from "bun:test";

import { createApi } from "../../apps/api/src/index";
import { createSqlClient } from "../../packages/db/src/testing";
import { seedHarnessFixtures } from "../harness/fixtures";
import { createMarkerPrinter, shouldRunSecurityGroup } from "../harness/security";

const markers = createMarkerPrinter();

describe("database source security invariants", () => {
  test("SEC-04 and SEC-05 source secret flows stay protected", async () => {
    const needsSecrets = shouldRunSecurityGroup("secrets");
    const needsImpersonation = shouldRunSecurityGroup("impersonation");
    if (!needsSecrets && !needsImpersonation) {
      return;
    }

    const seeded = await seedHarnessFixtures();
    const app = createApi({ auth: { databaseUrl: seeded.databaseUrl }, workspaces: { databaseUrl: seeded.databaseUrl }, storage: { databaseUrl: seeded.databaseUrl }, projects: { databaseUrl: seeded.databaseUrl }, sources: { databaseUrl: seeded.databaseUrl } });

    const detailResponse = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/database-sources/${seeded.sources.postgres.id}`, {
      headers: { cookie: "mba_session=session-a" }
    }));

    expect(detailResponse.status).toBe(200);
    const detailBody = await detailResponse.json() as { source: Record<string, unknown> };
    expect(detailBody.source.password).toBeUndefined();
    expect(detailBody.source.encryptedPassword).toBeUndefined();
    expect(detailBody.source.passwordMasked).toEqual(expect.any(String));
    expect(detailBody.source.credentialFingerprint).toEqual(expect.any(String));
    if (needsSecrets) {
      markers.print("SEC-04");
    }

    const client = createSqlClient(seeded.databaseUrl);
    try {
      await client`
        insert into users (email, name)
        values ('support-admin@example.com', 'Support Admin')
      `;
      await client`
        insert into impersonation_sessions (admin_session_id, admin_user_id, target_user_id, reason)
        select sessions.id, users.id, ${seeded.users.agencyA.id}, 'support'
        from sessions, users
        where sessions.user_id = ${seeded.users.agencyA.id}
          and users.email = 'support-admin@example.com'
        limit 1
      `;
    } finally {
      await client.end();
    }

    const mutateResponse = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/database-sources/${seeded.sources.postgres.id}`, {
      method: "PATCH",
      headers: { cookie: "mba_session=session-a", "content-type": "application/json", "x-csrf-token": "csrf-a" },
      body: JSON.stringify({ password: "new-secret-password" })
    }));

    expect(mutateResponse.status).toBe(403);
    if (needsImpersonation) {
      markers.print("SEC-05");
    }

    const systemClient = createSqlClient(seeded.databaseUrl);
    try {
      const [systemOwner] = await systemClient<{ id: string }[]>`
        insert into users (email, name)
        values ('system-owner@example.com', 'System Owner')
        returning id
      `;
      await systemClient`
        insert into workspace_members (workspace_id, user_id, role)
        values (${seeded.workspaces.agencyA.id}, ${systemOwner.id}, 'admin')
      `;
      await systemClient`
        insert into system_admins (user_id, role)
        values (${systemOwner.id}, 'system_owner')
      `;
      await systemClient`
        insert into sessions (user_id, session_token_hash, csrf_token_hash, active_workspace_id, expires_at)
        values (${systemOwner.id}, ${'48498695bc8b39fd33c8d83eb7f4c6d3d7449764120f42058f2601f7f441f88d'}, ${'1e22b962744ef3a6c51fb387ed1290f25c769d66c58db083727941651461c526'}, ${seeded.workspaces.agencyA.id}, now() + interval '1 day')
      `;
    } finally {
      await systemClient.end();
    }

    const systemRoleMutate = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/database-sources/${seeded.sources.postgres.id}`, {
      method: "PATCH",
      headers: { cookie: "mba_session=session-system-owner", "content-type": "application/json", "x-csrf-token": "csrf-system-owner" },
      body: JSON.stringify({ password: "system-owner-new-secret" })
    }));
    expect(systemRoleMutate.status).toBe(403);
  });
});
