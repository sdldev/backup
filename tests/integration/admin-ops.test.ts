import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";

import { createApi } from "../../apps/api/src/index";
import { createSqlClient, resolveWorkspacePlanLimits } from "../../packages/db/src/index";
import { seedHarnessFixtures } from "../harness/fixtures";

setDefaultTimeout(30_000);

async function json(response: Response) {
  return await response.json() as Record<string, unknown>;
}

async function createSystemSession(databaseUrl: string, role: "system_admin" | "system_owner", token: string, csrf: string) {
  const client = createSqlClient(databaseUrl);
  try {
    const [user] = await client<{ id: string }[]>`
      insert into users (email, name)
      values (${`${role}-${token}@example.com`}, ${role})
      returning id
    `;
    const [admin] = await client<{ id: string }[]>`
      insert into system_admins (user_id, role)
      values (${user.id}, ${role})
      returning id
    `;
    await client`
      insert into sessions (user_id, session_token_hash, csrf_token_hash, expires_at)
      values (${user.id}, ${createHash("sha256").update(token).digest("hex")}, ${createHash("sha256").update(csrf).digest("hex")}, now() + interval '1 day')
    `;
    return { userId: user.id, adminId: admin.id, cookie: `mba_session=${token}`, csrf };
  } finally {
    await client.end();
  }
}

describe("system admin operations", () => {
  test("system admin reviews plan requests, applies overrides, and lists workspace health", async () => {
    const seeded = await seedHarnessFixtures();
    const systemAdmin = await createSystemSession(seeded.databaseUrl, "system_admin", "sys-admin-plan", "csrf-sys-admin-plan");
    const api = createApi({ admin: { databaseUrl: seeded.databaseUrl }, plans: { databaseUrl: seeded.databaseUrl }, workspaces: { databaseUrl: seeded.databaseUrl } });

    const ownerRequest = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/plan-requests`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a", "content-type": "application/json", "x-csrf-token": "csrf-a" },
      body: JSON.stringify({ requested_plan: "pro" })
    }));
    expect(ownerRequest.status).toBe(201);
    const ownerRequestBody = await json(ownerRequest) as { planRequest: { id: string } };

    const approved = await api.handle(new Request(`http://localhost/v1/admin/plan-requests/${ownerRequestBody.planRequest.id}/approve`, {
      method: "POST",
      headers: { cookie: systemAdmin.cookie, "content-type": "application/json", "x-csrf-token": systemAdmin.csrf },
      body: JSON.stringify({ note: "approved for beta" })
    }));
    expect(approved.status).toBe(200);
    expect((await json(approved) as { planRequest: { status: string; reviewNote: string } }).planRequest).toMatchObject({ status: "approved", reviewNote: "approved for beta" });

    const requesterView = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/plan-requests`, {
      headers: { cookie: "mba_session=session-a" }
    }));
    expect(JSON.stringify(await json(requesterView))).toContain("approved");

    const planView = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/plan`, {
      headers: { cookie: "mba_session=session-a" }
    }));
    expect((await json(planView) as { plan: { slug: string } }).plan.slug).toBe("pro");

    const missingReason = await api.handle(new Request(`http://localhost/v1/admin/workspaces/${seeded.workspaces.agencyA.id}/limit-overrides`, {
      method: "POST",
      headers: { cookie: systemAdmin.cookie, "content-type": "application/json", "x-csrf-token": systemAdmin.csrf },
      body: JSON.stringify({ databaseSourceLimit: 11 })
    }));
    expect(missingReason.status).toBe(400);

    const override = await api.handle(new Request(`http://localhost/v1/admin/workspaces/${seeded.workspaces.agencyA.id}/limit-overrides`, {
      method: "POST",
      headers: { cookie: systemAdmin.cookie, "content-type": "application/json", "x-csrf-token": systemAdmin.csrf },
      body: JSON.stringify({ databaseSourceLimit: 11, retainedStorageBytesLimit: "2147483648", reason: "temporary beta headroom", expiresAt: "2999-01-01T00:00:00.000Z" })
    }));
    expect(override.status).toBe(201);

    const client = createSqlClient(seeded.databaseUrl);
    try {
      const limits = await resolveWorkspacePlanLimits(client, seeded.workspaces.agencyA.id);
      expect(limits?.databaseSourceLimit).toBe(11);
      expect(limits?.retainedStorageBytesLimit).toBe(2147483648n);
      const [audit] = await client<{ count: string }[]>`
        select count(*)::text as count
        from audit_logs
        where workspace_id = ${seeded.workspaces.agencyA.id}
          and event_type = 'workspace.limit_override.create'
          and system_admin_id = ${systemAdmin.adminId}
      `;
      expect(audit?.count).toBe("1");
    } finally {
      await client.end();
    }

    const workspaces = await api.handle(new Request("http://localhost/v1/admin/workspaces", { headers: { cookie: systemAdmin.cookie } }));
    expect(workspaces.status).toBe(200);
    expect(JSON.stringify(await json(workspaces))).toContain(seeded.workspaces.agencyA.slug);
  });

  test("only system owner manages system admin access", async () => {
    const seeded = await seedHarnessFixtures();
    const systemAdmin = await createSystemSession(seeded.databaseUrl, "system_admin", "sys-admin-access", "csrf-sys-admin-access");
    const systemOwner = await createSystemSession(seeded.databaseUrl, "system_owner", "sys-owner-access", "csrf-sys-owner-access");
    const api = createApi({ admin: { databaseUrl: seeded.databaseUrl } });

    const denied = await api.handle(new Request("http://localhost/v1/admin/system-admins", {
      method: "POST",
      headers: { cookie: systemAdmin.cookie, "content-type": "application/json", "x-csrf-token": systemAdmin.csrf },
      body: JSON.stringify({ userId: seeded.users.agencyAMember.id, role: "system_admin" })
    }));
    expect(denied.status).toBe(403);

    const granted = await api.handle(new Request("http://localhost/v1/admin/system-admins", {
      method: "POST",
      headers: { cookie: systemOwner.cookie, "content-type": "application/json", "x-csrf-token": systemOwner.csrf },
      body: JSON.stringify({ userId: seeded.users.agencyAMember.id, role: "system_admin" })
    }));
    expect(granted.status).toBe(201);

    const disabled = await api.handle(new Request(`http://localhost/v1/admin/system-admins/${seeded.users.agencyAMember.id}`, {
      method: "DELETE",
      headers: { cookie: systemOwner.cookie, "x-csrf-token": systemOwner.csrf }
    }));
    expect(disabled.status).toBe(200);
  });

  test("system admin impersonation requires reason, writes audit, and stop clears active state", async () => {
    const seeded = await seedHarnessFixtures();
    const systemAdmin = await createSystemSession(seeded.databaseUrl, "system_admin", "sys-admin-impersonate", "csrf-sys-admin-impersonate");
    const api = createApi({ admin: { databaseUrl: seeded.databaseUrl }, impersonation: { databaseUrl: seeded.databaseUrl } });

    const missingReason = await api.handle(new Request("http://localhost/v1/admin/impersonation/start", {
      method: "POST",
      headers: { cookie: systemAdmin.cookie, "content-type": "application/json", "x-csrf-token": systemAdmin.csrf },
      body: JSON.stringify({ workspaceId: seeded.workspaces.agencyA.id, targetUserId: seeded.users.agencyA.id, reason: "   " })
    }));
    expect(missingReason.status).toBe(400);

    const started = await api.handle(new Request("http://localhost/v1/admin/impersonation/start", {
      method: "POST",
      headers: { cookie: systemAdmin.cookie, "content-type": "application/json", "x-request-id": "imp-start", "x-csrf-token": systemAdmin.csrf },
      body: JSON.stringify({ workspaceId: seeded.workspaces.agencyA.id, targetUserId: seeded.users.agencyA.id, reason: "support escalation" })
    }));
    expect(started.status).toBe(201);
    const startedBody = await json(started) as { impersonation: { active: boolean; adminUserId: string; targetUserId: string; reason: string; impersonationSessionId: string } };
    expect(startedBody.impersonation).toMatchObject({
      active: true,
      targetUserId: seeded.users.agencyA.id,
      reason: "support escalation"
    });

    const stopped = await api.handle(new Request("http://localhost/v1/admin/impersonation/stop", {
      method: "POST",
      headers: { cookie: systemAdmin.cookie, "x-request-id": "imp-stop", "x-csrf-token": systemAdmin.csrf }
    }));
    expect(stopped.status).toBe(200);
    expect(await json(stopped)).toEqual({ impersonation: null });

    const client = createSqlClient(seeded.databaseUrl);
    try {
      const rows = await client<{
        event_type: string;
        actor_user_id: string | null;
        effective_actor_user_id: string | null;
        impersonation_reason: string | null;
      }[]>`
        select event_type, actor_user_id, effective_actor_user_id, impersonation_reason
        from audit_logs
        where request_id in ('imp-start', 'imp-stop')
        order by created_at asc
      `;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(expect.objectContaining({ event_type: "impersonation.start", actor_user_id: systemAdmin.userId, effective_actor_user_id: seeded.users.agencyA.id, impersonation_reason: "support escalation" }));
      expect(rows[1]).toEqual(expect.objectContaining({ event_type: "impersonation.stop", actor_user_id: systemAdmin.userId, effective_actor_user_id: seeded.users.agencyA.id, impersonation_reason: "support escalation" }));

      const [activeSession] = await client<{ count: string }[]>`
        select count(*)::text as count
        from impersonation_sessions
        where admin_user_id = ${systemAdmin.userId}
          and ended_at is null
      `;
      expect(activeSession.count).toBe("0");
    } finally {
      await client.end();
    }
  });
});
