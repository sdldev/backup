import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createApi } from "../../apps/api/src/index";
import { seedHarnessFixtures } from "../harness/fixtures";

async function json(response: Response) {
  return await response.json() as Record<string, unknown>;
}

function app(databaseUrl: string) {
  return createApi({
    auth: { databaseUrl },
    workspaces: { databaseUrl },
    invites: { databaseUrl }
  });
}

describe("invite and member RBAC security", () => {
  test("source persists only token_hash and never raw invite token", () => {
    const source = readFileSync(join(import.meta.dir, "../../apps/api/src/invites.ts"), "utf8");
    expect(source).toContain("token_hash");
    expect(source).not.toMatch(/insert into invites[\s\S]*raw_token/u);
    const inviteInsertStatements = source.match(/insert into invites[\s\S]*?`;/gu) ?? [];
    expect(inviteInsertStatements.length).toBeGreaterThan(0);
    for (const statement of inviteInsertStatements) {
      expect(statement).toContain("token_hash");
      const columnList = statement.match(/insert into invites \(([^)]*)\)/u)?.[1] ?? "";
      expect(columnList.split(",").map((column) => column.trim())).not.toContain("token");
      expect(statement).not.toMatch(/returning[\s\S]*token_hash/u);
    }
  });

  test("admin cannot invite admin, change admin roles, remove admin, or transfer ownership", async () => {
    const seeded = await seedHarnessFixtures();
    const api = app(seeded.databaseUrl);

    const adminInvite = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/invites`, {
      method: "POST",
      headers: { cookie: "mba_session=session-admin-a", "content-type": "application/json", "x-csrf-token": "csrf-admin-a" },
      body: JSON.stringify({ role: "admin" })
    }));
    expect(adminInvite.status).toBe(403);
    expect(await json(adminInvite)).toEqual({ error: { code: "workspace.permission_denied" } });

    const listed = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/members`, {
      headers: { cookie: "mba_session=session-admin-a" }
    }));
    const listedBody = await json(listed) as { members: { id: string; role: string }[] };
    const admin = listedBody.members.find((member) => member.role === "admin");
    const owner = listedBody.members.find((member) => member.role === "owner");
    expect(admin).toBeDefined();
    expect(owner).toBeDefined();

    const demoteAdmin = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/members/${admin?.id}/role`, {
      method: "PATCH",
      headers: { cookie: "mba_session=session-admin-a", "content-type": "application/json", "x-csrf-token": "csrf-admin-a" },
      body: JSON.stringify({ role: "member" })
    }));
    expect(demoteAdmin.status).toBe(403);

    const removeAdmin = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/members/${admin?.id}`, {
      method: "DELETE",
      headers: { cookie: "mba_session=session-admin-a", "x-csrf-token": "csrf-admin-a" }
    }));
    expect(removeAdmin.status).toBe(403);

    const transfer = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/ownership-transfer`, {
      method: "POST",
      headers: { cookie: "mba_session=session-admin-a", "content-type": "application/json", "x-csrf-token": "csrf-admin-a" },
      body: JSON.stringify({ memberId: owner?.id })
    }));
    expect(transfer.status).toBe(403);
  });

  test("workspace ID swaps miss with sanitized errors", async () => {
    const seeded = await seedHarnessFixtures();
    const api = app(seeded.databaseUrl);

    const created = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/invites`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a", "content-type": "application/json", "x-csrf-token": "csrf-a" },
      body: JSON.stringify({ role: "member" })
    }));
    const createdBody = await json(created) as { invite: { id: string }; token: string };

    const swappedRevoke = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyB.id}/invites/${createdBody.invite.id}/revoke`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a", "x-csrf-token": "csrf-a" }
    }));
    const body = await json(swappedRevoke);
    expect(swappedRevoke.status).toBe(404);
    expect(JSON.stringify(body)).not.toContain(createdBody.token);
    expect(JSON.stringify(body)).not.toContain(createdBody.invite.id);
  });

  test("non-owner workspace and plan mutations return sanitized deny codes", async () => {
    const seeded = await seedHarnessFixtures();
    const api = createApi({
      auth: { databaseUrl: seeded.databaseUrl },
      workspaces: { databaseUrl: seeded.databaseUrl },
      plans: { databaseUrl: seeded.databaseUrl },
      invites: { databaseUrl: seeded.databaseUrl }
    });

    const adminWorkspacePatch = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}`, {
      method: "PATCH",
      headers: { cookie: "mba_session=session-admin-a", "content-type": "application/json", "x-csrf-token": "csrf-admin-a" },
      body: JSON.stringify({ slug: "forbidden-admin-edit" })
    }));
    expect(adminWorkspacePatch.status).toBe(403);
    expect(await json(adminWorkspacePatch)).toEqual({ error: { code: "workspace.permission_denied" } });

    const memberPlanCreate = await api.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/plan-requests`, {
      method: "POST",
      headers: { cookie: "mba_session=session-member-a", "content-type": "application/json", "x-csrf-token": "csrf-member-a" },
      body: JSON.stringify({ requested_plan: "pro" })
    }));
    const memberPlanBody = await json(memberPlanCreate);
    expect(memberPlanCreate.status).toBe(403);
    expect(memberPlanBody).toEqual({ error: { code: "workspace.permission_denied" } });
    expect(JSON.stringify(memberPlanBody)).not.toContain("forbidden-admin-edit");
    expect(JSON.stringify(memberPlanBody)).not.toContain(seeded.workspaces.agencyA.id);
  });
});
