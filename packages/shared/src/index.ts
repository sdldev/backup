export function getAppName(): string {
  return "manual-backup-saas-beta";
}

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; issues: string[] };

function ok<T>(data: T): ValidationResult<T> {
  return { success: true, data };
}

function fail<T>(...issues: string[]): ValidationResult<T> {
  return { success: false, issues };
}

export const workspaceRoles = ["owner", "admin", "member"] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];

export const systemRoles = ["system_owner", "system_admin"] as const;
export type SystemRole = (typeof systemRoles)[number];

export const inviteRoles = ["admin", "member"] as const;
export type InviteRole = (typeof inviteRoles)[number];

export const workspacePermissions = [
  "workspace.read",
  "workspace.update",
  "workspace.delete",
  "workspace.restore",
  "workspace.plan.manage",
  "workspace.storage.retry",
  "project.create",
  "project.read",
  "project.update",
  "project.delete",
  "source.create",
  "source.read",
  "source.update",
  "source.delete",
  "source.move",
  "source.test",
  "source.credential.replace",
  "backup.run",
  "backup.read",
  "backup.download",
  "backup.delete",
  "backup-job.read",
  "backup-job.cancel",
  "invite.create",
  "invite.read",
  "invite.revoke",
  "member.read",
  "member.remove",
  "member.role.update",
  "ownership.transfer",
  "storage.manage",
  "audit.read"
] as const;
export type WorkspacePermission = (typeof workspacePermissions)[number];

export const backupJobStatuses = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type BackupJobStatus = (typeof backupJobStatuses)[number];

export const backupStatuses = ["succeeded", "deleted", "expired"] as const;
export type BackupStatus = (typeof backupStatuses)[number];

export const sseEventStages = [
  "queued",
  "connected",
  "dumping",
  "compressing",
  "encrypting",
  "uploading",
  "verifying",
  "succeeded",
  "failed"
] as const;
export type SseEventStage = (typeof sseEventStages)[number];

export const auditEvents = [
  "auth.login",
  "auth.logout",
  "workspace.member.invite",
  "workspace.member.remove",
  "workspace.member.role.update",
  "workspace.ownership.transfer",
  "database-credential.create",
  "database-credential.update",
  "backup-storage.update",
  "backup.download",
  "backup.delete",
  "database-source.create",
  "database-source.update",
  "database-source.delete",
  "impersonation.start",
  "impersonation.stop"
] as const;
export type AuditEvent = (typeof auditEvents)[number];

export const auditActorTypes = ["user", "system", "worker"] as const;
export type AuditActorType = (typeof auditActorTypes)[number];

export const auditResults = ["succeeded", "failed", "denied"] as const;
export type AuditResult = (typeof auditResults)[number];

export type AuditTargetType =
  | "workspace"
  | "member"
  | "invite"
  | "database_source"
  | "database_credential"
  | "backup"
  | "backup_storage"
  | "session"
  | "impersonation";

export type AuditLogEntry = {
  id: string;
  eventType: AuditEvent;
  actorType: AuditActorType;
  actorUserId: string | null;
  effectiveActorUserId: string | null;
  workspaceId: string | null;
  targetType: AuditTargetType;
  targetId: string;
  requestId: string | null;
  sessionIdHash: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  impersonationReason: string | null;
  result: AuditResult;
  internalErrorRef: string | null;
  createdAt: string;
};

export const errorCodes = [
  "auth.required",
  "csrf.required",
  "csrf.invalid",
  "tenant.membership_required",
  "tenant.workspace_scope_required",
  "tenant.role_required",
  "session.impersonation_denied",
  "route.future_scope_forbidden",
  "repo.workspace_scope_required"
] as const;
export type ErrorCode = (typeof errorCodes)[number];

export const PROTECTED_IMPERSONATION_ACTIONS = ["backup.download", "secret.mutate", "secret.reveal"] as const;
export type ProtectedImpersonationAction = (typeof PROTECTED_IMPERSONATION_ACTIONS)[number];

export const csrfUnsafeMethods = ["POST", "PUT", "PATCH", "DELETE"] as const;
export type CsrfUnsafeMethod = (typeof csrfUnsafeMethods)[number];

export const OAUTH_STATE_EXEMPT_ROUTE_NAMES = ["auth.google.callback", "auth.github.callback"] as const;
export type OAuthStateExemptRouteName = (typeof OAUTH_STATE_EXEMPT_ROUTE_NAMES)[number];

export const FUTURE_SCOPE_ROUTE_SEGMENTS = ["notification", "notifications", "webhook", "byos", "schedule"] as const;
export type FutureScopeRouteSegment = (typeof FUTURE_SCOPE_ROUTE_SEGMENTS)[number];

export type RouteName = string & { readonly __brand: "RouteName" };

export function routeName(value: string): RouteName {
  return value as RouteName;
}

export function assertAllowedRouteName(name: RouteName): RouteName {
  const normalized = name.toLowerCase();

  for (const segment of FUTURE_SCOPE_ROUTE_SEGMENTS) {
    if (normalized.includes(segment)) {
      throw new Error(`route.future_scope_forbidden: route name '${name}' contains future-scope segment '${segment}'`);
    }
  }

  return name;
}

export type WorkspaceScopedRepositoryMethodShape = {
  methodName: string;
  allowedUnscoped: boolean;
  params: readonly string[];
};

export function assertWorkspaceScopedRepositoryMethod(shape: WorkspaceScopedRepositoryMethodShape): WorkspaceScopedRepositoryMethodShape {
  if (shape.allowedUnscoped) {
    return shape;
  }

  const [firstParam, secondParam] = shape.params;
  if (firstParam !== "workspaceId" || secondParam !== "actorSession") {
    throw new Error(
      `repo.workspace_scope_required: method '${shape.methodName}' must start with params [workspaceId, actorSession]`
    );
  }

  return shape;
}

export type PermissionMatrix = Record<WorkspaceRole, readonly WorkspacePermission[]>;

export const workspaceRolePermissions: PermissionMatrix = {
  member: [
    "workspace.read",
    "project.read",
    "source.create",
    "source.read",
    "source.update",
    "source.move",
    "source.test",
    "source.credential.replace",
    "backup.run",
    "backup.read",
    "backup.download",
    "backup-job.read",
    "backup-job.cancel",
    "member.read",
    "audit.read"
  ],
  admin: [
    "workspace.read",
    "workspace.storage.retry",
    "project.create",
    "project.read",
    "project.update",
    "project.delete",
    "source.create",
    "source.read",
    "source.update",
    "source.delete",
    "source.move",
    "source.test",
    "source.credential.replace",
    "backup.run",
    "backup.read",
    "backup.download",
    "backup.delete",
    "backup-job.read",
    "backup-job.cancel",
    "invite.create",
    "invite.read",
    "invite.revoke",
    "member.read",
    "member.remove",
    "storage.manage",
    "audit.read"
  ],
  owner: [...new Set<WorkspacePermission>([
    ...workspaceRolePermissionsForAdmin(),
    "workspace.update",
    "workspace.delete",
    "workspace.restore",
    "workspace.plan.manage",
    "member.role.update",
    "ownership.transfer"
  ])]
};

function workspaceRolePermissionsForAdmin(): readonly WorkspacePermission[] {
  return [
    "workspace.read",
    "workspace.storage.retry",
    "project.create",
    "project.read",
    "project.update",
    "project.delete",
    "source.create",
    "source.read",
    "source.update",
    "source.delete",
    "source.move",
    "source.test",
    "source.credential.replace",
    "backup.run",
    "backup.read",
    "backup.download",
    "backup.delete",
    "backup-job.read",
    "backup-job.cancel",
    "invite.create",
    "invite.read",
    "invite.revoke",
    "member.read",
    "member.remove",
    "storage.manage",
    "audit.read"
  ];
}

export type OAuthStartPayload = {
  returnTo?: string;
};

export type LogoutPayload = {
  everywhere?: boolean;
};

export type WorkspaceCreatePayload = {
  name: string;
  slug?: string;
  timezone: string;
  requestedPlan?: "basic" | "pro" | "agency";
};

export type ProjectCreatePayload = {
  name: string;
  websiteUrl?: string;
};

export type ManualBackupRunPayload = {
  reason?: string;
};

export const payloadValidators = {
  oauthStart(payload: OAuthStartPayload): ValidationResult<OAuthStartPayload> {
    if (!payload.returnTo) {
      return ok(payload);
    }

    if (!payload.returnTo.startsWith("/") || payload.returnTo.startsWith("//")) {
      return fail("returnTo must be safe relative path");
    }

    return ok(payload);
  },

  logout(payload: LogoutPayload): ValidationResult<LogoutPayload> {
    if (payload.everywhere === undefined || typeof payload.everywhere === "boolean") {
      return ok(payload);
    }

    return fail("everywhere must be boolean when provided");
  },

  workspaceCreate(payload: WorkspaceCreatePayload): ValidationResult<WorkspaceCreatePayload> {
    const issues: string[] = [];

    if (!payload.name.trim()) {
      issues.push("name is required");
    }

    if (!payload.timezone.trim()) {
      issues.push("timezone is required");
    }

    if (payload.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.slug)) {
      issues.push("slug must be lowercase kebab-case");
    }

    if (payload.requestedPlan && !["basic", "pro", "agency"].includes(payload.requestedPlan)) {
      issues.push("requestedPlan must be basic, pro, or agency");
    }

    return issues.length > 0 ? fail(...issues) : ok(payload);
  },

  projectCreate(payload: ProjectCreatePayload): ValidationResult<ProjectCreatePayload> {
    if (!payload.name.trim()) {
      return fail("name is required");
    }

    return ok(payload);
  },

  manualBackupRun(payload: ManualBackupRunPayload): ValidationResult<ManualBackupRunPayload> {
    if (payload.reason !== undefined && payload.reason.length > 500) {
      return fail("reason must be 500 chars or fewer");
    }

    return ok(payload);
  }
};
