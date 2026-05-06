import { describe, expect, test } from "bun:test";

import {
  FUTURE_SCOPE_ROUTE_SEGMENTS,
  OAUTH_STATE_EXEMPT_ROUTE_NAMES,
  PROTECTED_IMPERSONATION_ACTIONS,
  assertAllowedRouteName,
  assertWorkspaceScopedRepositoryMethod,
  backupJobStatuses,
  backupStatuses,
  csrfUnsafeMethods,
  errorCodes,
  routeName,
  sseEventStages,
  workspacePermissions,
  workspaceRoles
} from "../../packages/shared/src/index";
import {
  assertCsrfPolicy,
  assertTenantAccess,
  createSessionPolicy,
  createTenantGuard,
  type AppSession
} from "../../packages/security/src/index";

const baseSession: AppSession = {
  sessionId: "session-1",
  userId: "user-1",
  systemRole: null,
  memberships: [
    {
      workspaceId: "ws-1",
      role: "admin"
    }
  ],
  impersonation: null
};

describe("shared contract baselines", () => {
  test("exports exact v1 SSE stages", () => {
    expect(sseEventStages).toEqual([
      "queued",
      "connected",
      "dumping",
      "compressing",
      "encrypting",
      "uploading",
      "verifying",
      "succeeded",
      "failed"
    ]);
  });

  test("excludes cancelled from safe SSE stages", () => {
    expect(sseEventStages).not.toContain("cancelled");
    expect(sseEventStages).not.toContain("finalizing");
  });

  test("exports route/status/error/permission surfaces", () => {
    expect(workspaceRoles).toContain("owner");
    expect(workspacePermissions).toContain("backup.run");
    expect(backupJobStatuses).toContain("queued");
    expect(backupStatuses).toContain("expired");
    expect(errorCodes).toContain("csrf.required");
    expect(PROTECTED_IMPERSONATION_ACTIONS).toEqual([
      "backup.download",
      "secret.mutate",
      "secret.reveal"
    ]);
    expect(FUTURE_SCOPE_ROUTE_SEGMENTS).toEqual(["notification", "notifications", "webhook", "byos", "schedule"]);
    expect(OAUTH_STATE_EXEMPT_ROUTE_NAMES).toEqual(["auth.google.callback", "auth.github.callback"]);
    expect(csrfUnsafeMethods).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
  });
});

describe("tenant guard", () => {
  test("requires workspace membership for scoped resource access", () => {
    const guard = createTenantGuard();

    expect(() =>
      guard.requireAccess({
        workspaceId: "ws-2",
        session: baseSession,
        minRole: "member"
      })
    ).toThrow(/tenant|workspace|membership/i);
  });

  test("route/service contract requires workspaceId first", () => {
    expect(() =>
      assertWorkspaceScopedRepositoryMethod({
        methodName: "findById",
        allowedUnscoped: false,
        params: ["id", "workspaceId"]
      })
    ).toThrow(/workspaceId/i);

    expect(() =>
      assertWorkspaceScopedRepositoryMethod({
        methodName: "findByWorkspace",
        allowedUnscoped: false,
        params: ["workspaceId", "actorSession", "projectId"]
      })
    ).not.toThrow();
  });
});

describe("impersonation deny list", () => {
  test("blocks protected action classes before handler work", () => {
    const policy = createSessionPolicy();
    const impersonatedSession: AppSession = {
      ...baseSession,
      systemRole: "system_admin",
      impersonation: {
        active: true,
        adminUserId: "admin-1",
        targetUserId: "user-1",
        reason: "support",
        startedAt: "2026-05-06T00:00:00.000Z"
      }
    };

    expect(() =>
      policy.assertActionAllowed({
        session: impersonatedSession,
        action: "backup.download"
      })
    ).toThrow(/impersonation|denied/i);

    expect(() =>
      policy.assertActionAllowed({
        session: impersonatedSession,
        action: "workspace.read"
      })
    ).not.toThrow();

    const systemRoleSession: AppSession = {
      ...baseSession,
      systemRole: "system_admin",
      impersonation: null
    };

    expect(() =>
      policy.assertActionAllowed({
        session: systemRoleSession,
        action: "secret.mutate"
      })
    ).toThrow(/system_role_denied|denied/i);

    expect(() =>
      policy.assertActionAllowed({
        session: systemRoleSession,
        action: "secret.reveal"
      })
    ).toThrow(/system_role_denied|denied/i);

    expect(() =>
      policy.assertActionAllowed({
        session: systemRoleSession,
        action: "workspace.read"
      })
    ).not.toThrow();
  });
});

describe("csrf policy", () => {
  test("requires csrf token for unsafe cookie-auth routes", () => {
    expect(() =>
      assertCsrfPolicy({
        method: "POST",
        routeName: routeName("workspaces.create"),
        authKind: "cookie",
        hasCsrfToken: false,
        hasOAuthState: false
      })
    ).toThrow(/csrf/i);
  });

  test("allows oauth callback exception with validated state", () => {
    expect(() =>
      assertCsrfPolicy({
        method: "GET",
        routeName: routeName("auth.google.callback"),
        authKind: "cookie",
        hasCsrfToken: false,
        hasOAuthState: true
      })
    ).not.toThrow();
  });
});

describe("static route contract gates", () => {
  test("rejects future-scope route names", () => {
    expect(() => assertAllowedRouteName(routeName("workspaces.notifications.update"))).toThrow(/future|scope|notification/i);
    expect(() => assertAllowedRouteName(routeName("workspaces.backups.list"))).not.toThrow();
  });
});

describe("security helpers interop", () => {
  test("tenant helper exposes membership when access granted", () => {
    const access = assertTenantAccess({
      workspaceId: "ws-1",
      session: baseSession,
      minRole: "member"
    });

    expect(access.workspaceId).toBe("ws-1");
    expect(access.membership.role).toBe("admin");
  });
});
