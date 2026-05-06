import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";

import { createApi } from "../../apps/api/src/index";
import { buildWorkspaceMemberListItem, canInviteRole, canUseMemberManagementAction, getWorkspaceDestructiveActionState } from "../../apps/web/src/app";
import { createSqlClient } from "../../packages/db/src/testing";
import { seedHarnessFixtures } from "../harness/fixtures";

async function json(response: Response) {
  return await response.json() as Record<string, unknown>;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function app(databaseUrl: string) {
  return createApi({
    auth: { databaseUrl },
    workspaces: { databaseUrl },
    invites: { databaseUrl }
  });
}

setDefaultTimeout(30_000);

describe("workspace invites and member management", () => {
  test("invite creation stores only token hash and public preview is redacted", async () => {
    const seeded = await seedHarnessFixtures();
    const api = app(seeded.databaseUrl);

    const created = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/invites`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a", "content-type": "application/json", "x-csrf-token": "csrf-a" },
      body: JSON.stringify({ role: "admin" })
    }));
    const createdBody = await json(created) as { invite: { id: string; role: string }; token: string };

    expect(created.status).toBe(201);
    expect(createdBody.invite.role).toBe("admin");
    expect(createdBody.token.length).toBeGreaterThan(30);

    const client = createSqlClient(seeded.databaseUrl);
    try {
      const [stored] = await client<{ token_hash: string }[]>`select token_hash from invites where id = ${createdBody.invite.id}`;
      expect(stored?.token_hash).toBe(hashValue(createdBody.token));
      expect(stored?.token_hash).not.toBe(createdBody.token);
    } finally {
      await client.end();
    }

    const preview = await api.handle(new Request(`http://localhost/v1/invites/${createdBody.token}`));
    const previewBody = await json(preview);
    expect(preview.status).toBe(200);
    expect(previewBody).toEqual({ workspaceName: "Workspace Agency A", role: "admin" });
    expect(JSON.stringify(previewBody)).not.toContain(createdBody.invite.id);
    expect(JSON.stringify(previewBody)).not.toContain(createdBody.token);
    expect(JSON.stringify(previewBody)).not.toContain(seeded.workspaces.agencyA.id);
  });

  test("accept requires session and explicit confirmation, then invite becomes single-use", async () => {
    const seeded = await seedHarnessFixtures();
    const api = app(seeded.databaseUrl);
    const created = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/invites`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a", "content-type": "application/json", "x-csrf-token": "csrf-a" },
      body: JSON.stringify({ role: "member" })
    }));
    const { token } = await json(created) as { token: string };

    const unauthenticated = await api.handle(new Request(`http://localhost/v1/invites/${token}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    }));
    expect(unauthenticated.status).toBe(401);

    const unconfirmed = await api.handle(new Request(`http://localhost/v1/invites/${token}/accept`, {
      method: "POST",
      headers: { cookie: "mba_session=session-admin-a", "content-type": "application/json", "x-csrf-token": "csrf-admin-a" },
      body: JSON.stringify({ confirm: false })
    }));
    expect(unconfirmed.status).toBe(400);

    const accepted = await api.handle(new Request(`http://localhost/v1/invites/${token}/accept`, {
      method: "POST",
      headers: { cookie: "mba_session=session-admin-a", "content-type": "application/json", "x-csrf-token": "csrf-admin-a" },
      body: JSON.stringify({ confirm: true })
    }));
    expect(accepted.status).toBe(200);

    const replay = await api.handle(new Request(`http://localhost/v1/invites/${token}/accept`, {
      method: "POST",
      headers: { cookie: "mba_session=session-admin-a", "content-type": "application/json", "x-csrf-token": "csrf-admin-a" },
      body: JSON.stringify({ confirm: true })
    }));
    expect(replay.status).toBe(404);
  });

  test("revoke and expiry block preview and acceptance", async () => {
    const seeded = await seedHarnessFixtures();
    const api = app(seeded.databaseUrl);
    const revoked = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/invites`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a", "content-type": "application/json", "x-csrf-token": "csrf-a" },
      body: JSON.stringify({ role: "member" })
    }));
    const revokedBody = await json(revoked) as { invite: { id: string }; token: string };

    const revoke = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/invites/${revokedBody.invite.id}/revoke`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a", "x-csrf-token": "csrf-a" }
    }));
    expect(revoke.status).toBe(200);
    expect((await api.handle(new Request(`http://localhost/v1/invites/${revokedBody.token}`))).status).toBe(404);

    const client = createSqlClient(seeded.databaseUrl);
    try {
      await client`
        insert into invites (workspace_id, role, token_hash, created_by_user_id, expires_at)
        values (${seeded.workspaces.agencyA.id}, 'member', ${hashValue("expired-token")}, ${seeded.users.agencyA.id}, now() - interval '1 minute')
      `;
    } finally {
      await client.end();
    }

    expect((await api.handle(new Request("http://localhost/v1/invites/expired-token"))).status).toBe(404);
  });

  test("member role changes, removals, and ownership transfer preserve one owner", async () => {
    const seeded = await seedHarnessFixtures();
    const api = app(seeded.databaseUrl);

    const members = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/members`, {
      headers: { cookie: "mba_session=session-a" }
    }));
    const membersBody = await json(members) as { members: { id: string; userId: string; role: string }[] };
    const admin = membersBody.members.find((member) => member.role === "admin");
    const member = membersBody.members.find((row) => row.role === "member");
    expect(admin).toBeDefined();
    expect(member).toBeDefined();

    const demoted = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/members/${admin?.id}/role`, {
      method: "PATCH",
      headers: { cookie: "mba_session=session-a", "content-type": "application/json", "x-csrf-token": "csrf-a" },
      body: JSON.stringify({ role: "member" })
    }));
    expect(demoted.status).toBe(200);

    const promoted = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/members/${admin?.id}/role`, {
      method: "PATCH",
      headers: { cookie: "mba_session=session-a", "content-type": "application/json", "x-csrf-token": "csrf-a" },
      body: JSON.stringify({ role: "admin" })
    }));
    expect(promoted.status).toBe(200);

    const removed = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/members/${member?.id}`, {
      method: "DELETE",
      headers: { cookie: "mba_session=session-a", "x-csrf-token": "csrf-a" }
    }));
    expect(removed.status).toBe(200);

    const transferred = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/ownership-transfer`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a", "content-type": "application/json", "x-csrf-token": "csrf-a" },
      body: JSON.stringify({ memberId: admin?.id })
    }));
    const transferBody = await json(transferred) as { members: { userId: string; role: string }[] };
    expect(transferred.status).toBe(200);
    expect(transferBody.members.filter((row) => row.role === "owner")).toHaveLength(1);
    expect(transferBody.members.find((row) => row.userId === seeded.users.agencyA.id)?.role).toBe("admin");
    expect(transferBody.members.find((row) => row.userId === seeded.users.agencyAAdmin.id)?.role).toBe("owner");
  });

  test("web member management helpers expose only allowed RBAC actions", () => {
    expect(canInviteRole("owner", "admin")).toBeTrue();
    expect(canInviteRole("admin", "admin")).toBeFalse();
    expect(canInviteRole("admin", "member")).toBeTrue();
    expect(canUseMemberManagementAction("admin", "transfer_ownership")).toBeFalse();

    const adminItem = buildWorkspaceMemberListItem({
      id: "m-admin",
      userId: "u-admin",
      email: "admin@example.com",
      name: "Admin",
      role: "admin"
    }, { userId: "u-owner", role: "owner" });
    expect(adminItem.actions).toMatchObject({
      canDemoteToMember: true,
      canRemove: true,
      canReceiveOwnership: true
    });

    const adminViewingAdmin = buildWorkspaceMemberListItem({
      id: "m-other-admin",
      userId: "u-other-admin",
      email: "other-admin@example.com",
      name: "Other Admin",
      role: "admin"
    }, { userId: "u-admin", role: "admin" });
    expect(adminViewingAdmin.actions.canRemove).toBeFalse();
    expect(adminViewingAdmin.actions.canReceiveOwnership).toBeFalse();

    expect(getWorkspaceDestructiveActionState("member", "delete_backup")).toEqual({
      visible: false,
      enabled: false,
      reason: "member_forbidden"
    });
    expect(getWorkspaceDestructiveActionState("member", "manage_plan")).toEqual({
      visible: false,
      enabled: false,
      reason: "member_forbidden"
    });
    expect(getWorkspaceDestructiveActionState("admin", "delete_project")).toEqual({
      visible: true,
      enabled: true,
      reason: "allowed"
    });
    expect(getWorkspaceDestructiveActionState("admin", "manage_workspace_settings")).toEqual({
      visible: false,
      enabled: false,
      reason: "member_forbidden"
    });
    expect(getWorkspaceDestructiveActionState("owner", "manage_plan")).toEqual({
      visible: true,
      enabled: true,
      reason: "allowed"
    });
  });
});
