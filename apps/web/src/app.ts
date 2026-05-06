export function getWebAppName(): string {
  return "web";
}

export const databaseSourceWizardSteps = [
  "engine",
  "identity",
  "connection",
  "test",
  "retention",
  "review"
] as const;

export type DatabaseSourceWizardStep = (typeof databaseSourceWizardSteps)[number];

export type DatabaseEngine = "mysql" | "postgresql";

export type ConnectionTestStatus = "idle" | "succeeded" | "failed";

export type DatabaseSourceWizardDraft = {
  engine: DatabaseEngine;
  displayName: string;
  technicalDatabaseName: string;
  host: string;
  port: number;
  username: string;
  password: string;
  sslMode: string;
  retentionDays: number;
  connectionTestStatus: ConnectionTestStatus;
};

export type DatabaseSourceWizardSaveIntent = {
  mode: "create" | "update";
  allowSaveWithoutSuccessfulTest: boolean;
  canEnableAfterSave: boolean;
  payload: {
    engine: DatabaseEngine;
    displayName: string;
    technicalDatabaseName: string;
    host: string;
    port: number;
    username: string;
    password: string;
    sslMode: string;
    retentionDays: number;
  };
  state: "enabled" | "disabled";
};

export type DatabaseSourceEnableIntent = {
  allowed: boolean;
  reason: "test_required" | "ready";
};

export type WorkspaceSummary = {
  slug: string;
};

export type WorkspaceRole = "owner" | "admin" | "member";

export type SystemRole = "system_owner" | "system_admin";

export type InviteRole = "admin" | "member";

export type MemberManagementAction = "invite_admin" | "invite_member" | "change_role" | "remove_member" | "transfer_ownership";

export type WorkspaceMemberListItem = {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  isCurrentUser: boolean;
  actions: {
    canPromoteToAdmin: boolean;
    canDemoteToMember: boolean;
    canRemove: boolean;
    canReceiveOwnership: boolean;
  };
};

export type AppRouteDecision = {
  kind: "render" | "redirect";
  location?: string;
};

export type AuthenticatedRouteImpersonationBanner = {
  visible: boolean;
  adminUserId: string | null;
  targetUserId: string | null;
  reason: string | null;
  startedAt: string | null;
};

export type AuthenticatedRouteModel = {
  impersonationBanner: AuthenticatedRouteImpersonationBanner;
};

export type AuditLogListItem = {
  id: string;
  eventType: string;
  actorLabel: string;
  targetLabel: string;
  result: string;
  internalErrorRef: string | null;
  createdAt: string;
};

export type BackupJobSafeStage = "queued" | "connected" | "dumping" | "compressing" | "encrypting" | "uploading" | "verifying" | "succeeded" | "failed";

export type BackupJobEventSnapshot = {
  eventId: string;
  jobId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: BackupJobSafeStage;
  terminal: boolean;
  attemptCount: number;
  maxAttempts: number;
  userErrorMessage: string | null;
  internalErrorRef: string | null;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  queuedAt: string;
};

export type BackupJobDetailConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "closed";

export type BackupJobAction = {
  kind: "cancel" | "retry" | "edit" | "download";
  enabled: boolean;
};

export type FormFieldAccessibilityState = {
  fieldId: string;
  labelId: string;
  descriptionId: string | null;
  errorId: string | null;
  required: boolean;
  invalid: boolean;
  describedBy: string[];
};

export type FormErrorSummaryItem = {
  field: string;
  message: string;
};

export type FormErrorSummary = {
  role: "alert";
  ariaLive: "assertive";
  title: string;
  items: FormErrorSummaryItem[];
};

export type BackupProgressStatusRegion = {
  role: "status";
  ariaLive: "polite";
  ariaAtomic: true;
  message: string;
};

export type EmptyStateAction = {
  kind: "create_project" | "add_source" | "run_backup" | "invite_team";
  enabled: boolean;
};

export type DashboardEmptyState = {
  title: string;
  description: string;
  actions: EmptyStateAction[];
};

export type ResponsivePanelLayout = {
  variant: "stack" | "split";
  columns: 1 | 2;
  stickySummary: boolean;
};

export type WorkspaceDestructiveAction = "delete_backup" | "delete_project" | "delete_source" | "manage_members" | "manage_workspace_settings" | "manage_plan";

export type WorkspaceActionState = {
  visible: boolean;
  enabled: boolean;
  reason: "allowed" | "member_forbidden";
};

export type AdminDashboardAction = "review_plan" | "apply_override" | "manage_system_admins";

export type AdminDashboardActionState = {
  visible: boolean;
  enabled: boolean;
  reason: "allowed" | "owner_required";
};

export type BackupJobStageTimelineItem = {
  stage: BackupJobSafeStage;
  status: "pending" | "current" | "done" | "failed";
};

export type BackupJobDetailState = {
  jobId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: BackupJobSafeStage;
  connectionState: BackupJobDetailConnectionState;
  latestEventId: string | null;
  latestKnownSnapshot: BackupJobEventSnapshot | null;
  failureMessage: string | null;
  internalErrorRef: string | null;
  canReconnect: boolean;
  actions: BackupJobAction[];
  timeline: BackupJobStageTimelineItem[];
};

export type ManualBackupDashboardHealthStatus = "setup_incomplete" | "ready" | "last_failed" | "last_succeeded";

export type SetupChecklistItemKey =
  | "workspace_created"
  | "storage_provisioned"
  | "project_created"
  | "database_source_added"
  | "connection_tested"
  | "first_backup_succeeded"
  | "team_invited_optional";

export type SetupChecklistItem = {
  key: SetupChecklistItemKey;
  label: string;
  complete: boolean;
  optional: boolean;
};

export type ManualBackupDashboardModel = {
  status: ManualBackupDashboardHealthStatus;
  storageUsedBytes: string;
  storageLimitBytes: string;
  storageUsagePercent: number;
  setupComplete: boolean;
  lastBackupAt: string | null;
  lastBackupId: string | null;
  lastBackupFilename: string | null;
  lastBackupErrorMessage: string | null;
  checklist: SetupChecklistItem[];
};

export type FirstBackupSuccessModel = {
  status: "succeeded";
  backupId: string;
  filename: string;
  storedSizeBytes: string;
  durationSeconds: number | null;
  downloadReady: true;
  invitePromptVisible: boolean;
};

export type FirstBackupFailureModel = {
  status: "failed";
  backupJobId: string;
  failedStage: string;
  failureReason: string;
  actions: Array<"retry" | "edit">;
};

export type RestoreInstructionsModel = {
  title: string;
  formatLabel: string;
  warningTitle: string;
  warnings: string[];
  steps: string[];
  commands: string[];
  hasExecutionAction: false;
};

export type DashboardEmptyStateKind = "no_projects" | "no_sources" | "ready_for_first_backup" | "team_invite";

type ManualBackupDashboardInput = {
  storageStatus: string;
  storageUsedBytes: bigint;
  storageLimitBytes: bigint;
  projectCount: number;
  sourceCount: number;
  testedSourceCount: number;
  invitedMemberCount: number;
  lastBackup: {
    id: string;
    status: "succeeded" | "failed";
    filename: string | null;
    createdAt: string;
    errorMessage: string | null;
  } | null;
};

const backupJobSafeStages: readonly BackupJobSafeStage[] = [
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

export function buildAuditLogListItem(entry: {
  id: string;
  eventType: string;
  actorUserId: string | null;
  effectiveActorUserId: string | null;
  targetType: string;
  targetId: string;
  result: string;
  internalErrorRef: string | null;
  createdAt: string;
}): AuditLogListItem {
  return {
    id: entry.id,
    eventType: entry.eventType,
    actorLabel: entry.effectiveActorUserId ?? entry.actorUserId ?? "system",
    targetLabel: `${entry.targetType}:${entry.targetId}`,
    result: entry.result,
    internalErrorRef: entry.internalErrorRef,
    createdAt: entry.createdAt
  };
}

export function canInviteRole(actorRole: WorkspaceRole, inviteRole: InviteRole): boolean {
  return actorRole === "owner" || (actorRole === "admin" && inviteRole === "member");
}

export function canUseMemberManagementAction(actorRole: WorkspaceRole, action: MemberManagementAction): boolean {
  if (action === "invite_member") {
    return actorRole === "owner" || actorRole === "admin";
  }

  return actorRole === "owner";
}

export function buildWorkspaceMemberListItem(member: {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
}, viewer: { userId: string; role: WorkspaceRole }): WorkspaceMemberListItem {
  const ownerViewing = viewer.role === "owner";
  const adminViewing = viewer.role === "admin";
  const isCurrentUser = member.userId === viewer.userId;

  return {
    ...member,
    isCurrentUser,
    actions: {
      canPromoteToAdmin: ownerViewing && member.role === "member",
      canDemoteToMember: ownerViewing && member.role === "admin",
      canRemove: !isCurrentUser && member.role !== "owner" && (ownerViewing || (adminViewing && member.role === "member")),
      canReceiveOwnership: ownerViewing && member.role === "admin" && !isCurrentUser
    }
  };
}

export function getWorkspaceDestructiveActionState(role: WorkspaceRole, action: WorkspaceDestructiveAction): WorkspaceActionState {
  if (role === "member") {
    return { visible: false, enabled: false, reason: "member_forbidden" };
  }

  if (role === "admin") {
    if (action === "manage_workspace_settings" || action === "manage_plan") {
      return { visible: false, enabled: false, reason: "member_forbidden" };
    }

    return { visible: true, enabled: true, reason: "allowed" };
  }

  return { visible: true, enabled: true, reason: "allowed" };
}

function createChecklist(input: ManualBackupDashboardInput): SetupChecklistItem[] {
  const hasConfiguredSource = input.sourceCount > 0;
  return [
    { key: "workspace_created", label: "Workspace created", complete: true, optional: false },
    { key: "storage_provisioned", label: "Storage provisioned", complete: input.storageStatus === "ready", optional: false },
    { key: "project_created", label: "Project created", complete: input.projectCount > 0, optional: false },
    { key: "database_source_added", label: "Database Source added", complete: hasConfiguredSource, optional: false },
    { key: "connection_tested", label: "Connection tested", complete: input.testedSourceCount > 0, optional: false },
    { key: "first_backup_succeeded", label: "First Backup succeeded", complete: input.lastBackup?.status === "succeeded", optional: false },
    { key: "team_invited_optional", label: "Team invite optional", complete: input.invitedMemberCount > 0, optional: true }
  ];
}

function toPercent(usedBytes: bigint, limitBytes: bigint): number {
  if (limitBytes <= 0n) {
    return 0;
  }

  const scaled = Number((usedBytes * 10_000n) / limitBytes) / 100;
  return Math.max(0, Math.min(100, scaled));
}

export function buildManualBackupDashboardModel(input: ManualBackupDashboardInput): ManualBackupDashboardModel {
  const checklist = createChecklist(input);
  const setupComplete = checklist.every((item) => item.optional || item.complete);
  const readyForFirstBackup = input.storageStatus === "ready"
    && input.projectCount > 0
    && input.sourceCount > 0
    && input.testedSourceCount > 0;
  let status: ManualBackupDashboardHealthStatus = "setup_incomplete";

  if (input.lastBackup?.status === "failed") {
    status = "last_failed";
  } else if (input.lastBackup?.status === "succeeded") {
    status = "last_succeeded";
  } else if (readyForFirstBackup) {
    status = "ready";
  }

  return {
    status,
    storageUsedBytes: input.storageUsedBytes.toString(),
    storageLimitBytes: input.storageLimitBytes.toString(),
    storageUsagePercent: toPercent(input.storageUsedBytes, input.storageLimitBytes),
    setupComplete,
    lastBackupAt: input.lastBackup?.createdAt ?? null,
    lastBackupId: input.lastBackup?.id ?? null,
    lastBackupFilename: input.lastBackup?.filename ?? null,
    lastBackupErrorMessage: input.lastBackup?.status === "failed" ? input.lastBackup.errorMessage ?? "Backup failed before verification completed." : null,
    checklist
  };
}

export function buildFirstBackupSuccessModel(input: {
  backupId: string;
  filename: string;
  storedSizeBytes: string;
  startedAt: string | null;
  finishedAt: string | null;
  viewerRole: WorkspaceRole;
}): FirstBackupSuccessModel {
  const durationSeconds = input.startedAt && input.finishedAt
    ? Math.max(0, Math.round((Date.parse(input.finishedAt) - Date.parse(input.startedAt)) / 1000))
    : null;

  return {
    status: "succeeded",
    backupId: input.backupId,
    filename: input.filename,
    storedSizeBytes: input.storedSizeBytes,
    durationSeconds,
    downloadReady: true,
    invitePromptVisible: input.viewerRole === "owner" || input.viewerRole === "admin"
  };
}

export function buildFirstBackupFailureModel(input: {
  backupJobId: string;
  failedStage: string;
  failureReason: string | null;
}): FirstBackupFailureModel {
  return {
    status: "failed",
    backupJobId: input.backupJobId,
    failedStage: input.failedStage,
    failureReason: input.failureReason ?? "Backup failed before verification completed.",
    actions: ["retry", "edit"]
  };
}

export function buildFormFieldAccessibilityState(input: {
  formId: string;
  field: string;
  required: boolean;
  errorMessage?: string | null;
  description?: string | null;
}): FormFieldAccessibilityState {
  const baseId = `${input.formId}-${input.field}`;
  const descriptionId = input.description ? `${baseId}-description` : null;
  const errorId = input.errorMessage ? `${baseId}-error` : null;

  return {
    fieldId: `${baseId}-input`,
    labelId: `${baseId}-label`,
    descriptionId,
    errorId,
    required: input.required,
    invalid: Boolean(input.errorMessage),
    describedBy: [descriptionId, errorId].filter((value): value is string => Boolean(value))
  };
}

export function buildFormErrorSummary(errors: Array<FormErrorSummaryItem | null | undefined>): FormErrorSummary | null {
  const items = errors.filter((item): item is FormErrorSummaryItem => Boolean(item));
  if (items.length === 0) {
    return null;
  }

  return {
    role: "alert",
    ariaLive: "assertive",
    title: "Fix highlighted fields before continuing.",
    items
  };
}

export function buildBackupProgressStatusRegion(snapshot: BackupJobEventSnapshot | null): BackupProgressStatusRegion {
  const message = snapshot
    ? snapshot.terminal
      ? snapshot.status === "succeeded"
        ? "Backup finished. Download ready."
        : buildFailureMessage(snapshot) ?? "Backup finished with error."
      : `Backup ${snapshot.stage}. Attempt ${Math.max(1, snapshot.attemptCount)} of ${snapshot.maxAttempts}.`
    : "Waiting for backup updates.";

  return {
    role: "status",
    ariaLive: "polite",
    ariaAtomic: true,
    message
  };
}

export function buildDashboardEmptyState(kind: DashboardEmptyStateKind): DashboardEmptyState {
  switch (kind) {
    case "no_projects":
      return {
        title: "Create first Project",
        description: "Projects group Database Sources before first manual Backup can run.",
        actions: [{ kind: "create_project", enabled: true }]
      };
    case "no_sources":
      return {
        title: "Add first Database Source",
        description: "Add one MySQL or PostgreSQL database, test connection, then enable manual Backups.",
        actions: [{ kind: "add_source", enabled: true }]
      };
    case "ready_for_first_backup":
      return {
        title: "Run first manual Backup",
        description: "Storage and source are ready. Start first Backup when you want protected restore docs and download flow.",
        actions: [{ kind: "run_backup", enabled: true }]
      };
    case "team_invite":
      return {
        title: "Invite team when first Backup succeeds",
        description: "Owners and Admins can invite teammates after first successful Backup. No notification or webhook setup required in v1.",
        actions: [{ kind: "invite_team", enabled: true }]
      };
  }
}

export function buildResponsivePanelLayout(viewportWidth: number): ResponsivePanelLayout {
  if (viewportWidth < 960) {
    return {
      variant: "stack",
      columns: 1,
      stickySummary: false
    };
  }

  return {
    variant: "split",
    columns: 2,
    stickySummary: true
  };
}

export function getBackupJobKeyboardOrder(state: BackupJobDetailState): BackupJobAction["kind"][] {
  return state.actions.filter((action) => action.enabled).map((action) => action.kind);
}

export function buildRestoreInstructionsModel(input: {
  engine: "mysql" | "postgresql";
  filename?: string | null;
}): RestoreInstructionsModel {
  const filename = input.filename ?? (input.engine === "mysql" ? "backup.sql.gz" : "backup.dump");

  if (input.engine === "mysql") {
    return {
      title: `Restore ${filename} manually`,
      formatLabel: ".sql.gz",
      warningTitle: "Production overwrite warning",
      warnings: [
        "Restoring can overwrite live production data.",
        "Confirm target hostname, database name, and credentials before running import commands.",
        "Restore into non-production first whenever possible."
      ],
      steps: [
        "Download backup file locally.",
        "Confirm target MySQL database exists and is safe to overwrite.",
        "Decompress or stream-decompress the SQL dump before import.",
        "Run import from trusted shell with production credentials kept outside command history."
      ],
      commands: [
        `gunzip -c ${filename} > restore.sql`,
        "mysql --host <HOST> --port <PORT> --user <USER> --password <DATABASE_NAME> < restore.sql",
        `gunzip -c ${filename} | mysql --host <HOST> --port <PORT> --user <USER> --password <DATABASE_NAME>`
      ],
      hasExecutionAction: false
    };
  }

  return {
    title: `Restore ${filename} manually`,
    formatLabel: ".dump",
    warningTitle: "Production overwrite warning",
    warnings: [
      "Restoring can overwrite live production data.",
      "Double-check target database, role permissions, and extension compatibility before pg_restore.",
      "Restore into staging first whenever possible."
    ],
    steps: [
      "Download backup file locally.",
      "Create empty target database or prepare clean restore target.",
      "Use pg_restore against the downloaded custom-format dump.",
      "Review object ownership and post-restore privileges after import completes."
    ],
    commands: [
      "createdb --host <HOST> --port <PORT> --username <USER> <DATABASE_NAME>",
      `pg_restore --host <HOST> --port <PORT> --username <USER> --dbname <DATABASE_NAME> --clean --if-exists ${filename}`
    ],
    hasExecutionAction: false
  };
}

export function getAdminDashboardActionState(role: SystemRole, action: AdminDashboardAction): AdminDashboardActionState {
  if (action === "manage_system_admins" && role !== "system_owner") {
    return { visible: false, enabled: false, reason: "owner_required" };
  }

  return { visible: true, enabled: true, reason: "allowed" };
}

function createEmptyTimeline(currentStage: BackupJobSafeStage, status: BackupJobDetailState["status"]): BackupJobStageTimelineItem[] {
  const currentIndex = backupJobSafeStages.indexOf(currentStage);
  const failed = status === "failed" || status === "cancelled";

  return backupJobSafeStages.map((stage, index) => {
    if (failed && stage === "failed") {
      return { stage, status: "failed" };
    }

    if (index < currentIndex) {
      return { stage, status: "done" };
    }

    if (index === currentIndex) {
      return { stage, status: failed ? "failed" : "current" };
    }

    return { stage, status: "pending" };
  });
}

function buildBackupJobActions(status: BackupJobDetailState["status"]): BackupJobAction[] {
  if (status === "queued" || status === "running") {
    return [{ kind: "cancel", enabled: true }];
  }

  if (status === "failed" || status === "cancelled") {
    return [
      { kind: "retry", enabled: true },
      { kind: "edit", enabled: true }
    ];
  }

  return [{ kind: "download", enabled: true }];
}

function buildFailureMessage(snapshot: BackupJobEventSnapshot | null): string | null {
  if (!snapshot) {
    return null;
  }

  if (snapshot.status === "cancelled") {
    return "Backup cancelled before completion.";
  }

  if (snapshot.status === "failed") {
    return snapshot.userErrorMessage ?? "Backup failed before verification completed.";
  }

  return null;
}

export function createBackupJobDetailState(jobId: string, snapshot: BackupJobEventSnapshot | null = null): BackupJobDetailState {
  const effectiveSnapshot = snapshot ?? {
    eventId: `${jobId}:queued`,
    jobId,
    status: "queued",
    stage: "queued",
    terminal: false,
    attemptCount: 0,
    maxAttempts: 3,
    userErrorMessage: null,
    internalErrorRef: null,
    cancelRequestedAt: null,
    startedAt: null,
    finishedAt: null,
    queuedAt: new Date(0).toISOString()
  };

  return {
    jobId,
    status: effectiveSnapshot.status,
    stage: effectiveSnapshot.stage,
    connectionState: snapshot ? (snapshot.terminal ? "closed" : "live") : "idle",
    latestEventId: snapshot?.eventId ?? null,
    latestKnownSnapshot: snapshot,
    failureMessage: buildFailureMessage(snapshot),
    internalErrorRef: snapshot?.internalErrorRef ?? null,
    canReconnect: !effectiveSnapshot.terminal,
    actions: buildBackupJobActions(effectiveSnapshot.status),
    timeline: createEmptyTimeline(effectiveSnapshot.stage, effectiveSnapshot.status)
  };
}

export function applyBackupJobConnectionState(
  state: BackupJobDetailState,
  connectionState: BackupJobDetailConnectionState
): BackupJobDetailState {
  return {
    ...state,
    connectionState,
    canReconnect: connectionState !== "closed" && state.status !== "succeeded" && state.status !== "failed" && state.status !== "cancelled"
  };
}

export function applyBackupJobEvent(
  state: BackupJobDetailState,
  snapshot: BackupJobEventSnapshot,
  options: { source: "live" | "reconnect" | "reload" } = { source: "live" }
): BackupJobDetailState {
  const current = state.latestKnownSnapshot;
  const keepCurrent = current?.terminal
    && !snapshot.terminal
    && (options.source === "reconnect" || options.source === "reload");

  const effectiveSnapshot = keepCurrent ? current : snapshot;

  return {
    jobId: state.jobId,
    status: effectiveSnapshot.status,
    stage: effectiveSnapshot.stage,
    connectionState: effectiveSnapshot.terminal ? "closed" : (options.source === "reconnect" ? "live" : state.connectionState),
    latestEventId: effectiveSnapshot.eventId,
    latestKnownSnapshot: effectiveSnapshot,
    failureMessage: buildFailureMessage(effectiveSnapshot),
    internalErrorRef: effectiveSnapshot.internalErrorRef,
    canReconnect: !effectiveSnapshot.terminal,
    actions: buildBackupJobActions(effectiveSnapshot.status),
    timeline: createEmptyTimeline(effectiveSnapshot.stage, effectiveSnapshot.status)
  };
}

export function decideAppLauncherRoute(workspaces: WorkspaceSummary[]): AppRouteDecision {
  const firstWorkspace = workspaces[0];
  if (!firstWorkspace) {
    return { kind: "render" };
  }

  return { kind: "redirect", location: `/app/${firstWorkspace.slug}` };
}

export function decideNewWorkspaceRoute(workspaces: WorkspaceSummary[]): AppRouteDecision {
  const firstWorkspace = workspaces[0];
  if (!firstWorkspace) {
    return { kind: "render" };
  }

  return { kind: "redirect", location: "/app" };
}

export function buildAuthenticatedRouteModel(input: {
  impersonation: {
    active: boolean;
    adminUserId: string;
    targetUserId: string;
    reason: string;
    startedAt: string;
  } | null;
}): AuthenticatedRouteModel {
  if (!input.impersonation?.active) {
    return {
      impersonationBanner: {
        visible: false,
        adminUserId: null,
        targetUserId: null,
        reason: null,
        startedAt: null
      }
    };
  }

  return {
    impersonationBanner: {
      visible: true,
      adminUserId: input.impersonation.adminUserId,
      targetUserId: input.impersonation.targetUserId,
      reason: input.impersonation.reason,
      startedAt: input.impersonation.startedAt
    }
  };
}

export function getDatabaseSourceWizardSteps(): readonly DatabaseSourceWizardStep[] {
  return databaseSourceWizardSteps;
}

export function createDatabaseSourceWizardDraft(engine: DatabaseEngine): DatabaseSourceWizardDraft {
  return {
    engine,
    displayName: "",
    technicalDatabaseName: "",
    host: "",
    port: engine === "postgresql" ? 5432 : 3306,
    username: "",
    password: "",
    sslMode: engine === "postgresql" ? "require" : "required",
    retentionDays: 7,
    connectionTestStatus: "idle"
  };
}

export function buildDatabaseSourceWizardSaveIntent(
  draft: DatabaseSourceWizardDraft,
  mode: "create" | "update" = "create"
): DatabaseSourceWizardSaveIntent {
  const hasSuccessfulTest = draft.connectionTestStatus === "succeeded";

  return {
    mode,
    allowSaveWithoutSuccessfulTest: !hasSuccessfulTest,
    canEnableAfterSave: hasSuccessfulTest,
    payload: {
      engine: draft.engine,
      displayName: draft.displayName,
      technicalDatabaseName: draft.technicalDatabaseName,
      host: draft.host,
      port: draft.port,
      username: draft.username,
      password: draft.password,
      sslMode: draft.sslMode,
      retentionDays: draft.retentionDays
    },
    state: hasSuccessfulTest ? "enabled" : "disabled"
  };
}

export function getDatabaseSourceEnableIntent(testStatus: ConnectionTestStatus): DatabaseSourceEnableIntent {
  if (testStatus !== "succeeded") {
    return { allowed: false, reason: "test_required" };
  }

  return { allowed: true, reason: "ready" };
}
