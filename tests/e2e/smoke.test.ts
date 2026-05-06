import { describe, expect, test } from "bun:test";
import {
  applyBackupJobConnectionState,
  applyBackupJobEvent,
  buildBackupProgressStatusRegion,
  buildDashboardEmptyState,
  buildFormErrorSummary,
  buildFormFieldAccessibilityState,
  buildManualBackupDashboardModel,
  buildResponsivePanelLayout,
  buildRestoreInstructionsModel,
  createBackupJobDetailState,
  createDatabaseSourceWizardDraft,
  getBackupJobKeyboardOrder,
  getWebAppName
} from "../../apps/web/src/app";
import { createE2EHarnessConfig } from "../harness/e2e-config";

describe("e2e harness baseline", () => {
  test("web module loads", () => {
    expect(getWebAppName()).toBe("web");
  });

  test("database source wizard defaults stay retention-only for v1", () => {
    const postgresDraft = createDatabaseSourceWizardDraft("postgresql");
    const mysqlDraft = createDatabaseSourceWizardDraft("mysql");

    expect(postgresDraft).toMatchObject({ engine: "postgresql", port: 5432, sslMode: "require", retentionDays: 7, connectionTestStatus: "idle" });
    expect(mysqlDraft).toMatchObject({ engine: "mysql", port: 3306, sslMode: "required", retentionDays: 7, connectionTestStatus: "idle" });
    expect(postgresDraft).not.toHaveProperty("scheduleEnabled");
    expect(mysqlDraft).not.toHaveProperty("scheduleFrequencyPerDay");
  });

  test("uses browser baseline with fake external dependencies only", () => {
    const config = createE2EHarnessConfig();

    expect(config.browserName).toBe("chromium");
    expect(config.useRealExternalServices).toBeFalse();
    expect(config.oauthIdentities.map((item) => item.email)).toContain("agency-a@example.com");
    expect(config.flow).toEqual(["oauth-mock", "workspace", "project", "source", "backup", "download", "invite"]);
  });

  test("backup job detail keeps latest terminal state across reconnect", () => {
    const initial = createBackupJobDetailState("job-1");
    const running = applyBackupJobEvent(initial, {
      eventId: "job-1:uploading",
      jobId: "job-1",
      status: "running",
      stage: "uploading",
      terminal: false,
      attemptCount: 1,
      maxAttempts: 3,
      userErrorMessage: null,
      internalErrorRef: null,
      cancelRequestedAt: null,
      startedAt: "2026-05-06T00:00:00.000Z",
      finishedAt: null,
      queuedAt: "2026-05-06T00:00:00.000Z"
    });
    const failed = applyBackupJobEvent(running, {
      eventId: "job-1:failed",
      jobId: "job-1",
      status: "failed",
      stage: "failed",
      terminal: true,
      attemptCount: 1,
      maxAttempts: 3,
      userErrorMessage: "Backup failed before verification completed.",
      internalErrorRef: "err_ref_1",
      cancelRequestedAt: null,
      startedAt: "2026-05-06T00:00:00.000Z",
      finishedAt: "2026-05-06T00:03:00.000Z",
      queuedAt: "2026-05-06T00:00:00.000Z"
    });
    const reconnecting = applyBackupJobConnectionState(failed, "reconnecting");
    const staleReconnect = applyBackupJobEvent(reconnecting, {
      eventId: "job-1:old-uploading",
      jobId: "job-1",
      status: "running",
      stage: "uploading",
      terminal: false,
      attemptCount: 1,
      maxAttempts: 3,
      userErrorMessage: null,
      internalErrorRef: null,
      cancelRequestedAt: null,
      startedAt: "2026-05-06T00:00:00.000Z",
      finishedAt: null,
      queuedAt: "2026-05-06T00:00:00.000Z"
    }, { source: "reconnect" });

    expect(staleReconnect.status).toBe("failed");
    expect(staleReconnect.stage).toBe("failed");
    expect(staleReconnect.failureMessage).toBe("Backup failed before verification completed.");
    expect(staleReconnect.internalErrorRef).toBe("err_ref_1");
    expect(staleReconnect.actions.map((item) => item.kind)).toEqual(["retry", "edit"]);
  });

  test("backup job detail exposes cancel while live and download on success", () => {
    const live = applyBackupJobEvent(createBackupJobDetailState("job-2"), {
      eventId: "job-2:dumping",
      jobId: "job-2",
      status: "running",
      stage: "dumping",
      terminal: false,
      attemptCount: 1,
      maxAttempts: 3,
      userErrorMessage: null,
      internalErrorRef: null,
      cancelRequestedAt: null,
      startedAt: "2026-05-06T00:00:00.000Z",
      finishedAt: null,
      queuedAt: "2026-05-06T00:00:00.000Z"
    });
    const succeeded = applyBackupJobEvent(live, {
      eventId: "job-2:succeeded",
      jobId: "job-2",
      status: "succeeded",
      stage: "succeeded",
      terminal: true,
      attemptCount: 1,
      maxAttempts: 3,
      userErrorMessage: null,
      internalErrorRef: null,
      cancelRequestedAt: null,
      startedAt: "2026-05-06T00:00:00.000Z",
      finishedAt: "2026-05-06T00:02:00.000Z",
      queuedAt: "2026-05-06T00:00:00.000Z"
    });

    expect(live.actions.map((item) => item.kind)).toEqual(["cancel"]);
    expect(succeeded.actions.map((item) => item.kind)).toEqual(["download"]);
    expect(succeeded.canReconnect).toBeFalse();
  });

  test("dashboard and restore docs helpers stay docs-only for first-backup UX", () => {
    const dashboard = buildManualBackupDashboardModel({
      storageStatus: "ready",
      storageUsedBytes: 512n,
      storageLimitBytes: 1024n,
      projectCount: 1,
      sourceCount: 1,
      testedSourceCount: 1,
      invitedMemberCount: 0,
      lastBackup: {
        id: "backup-1",
        status: "succeeded",
        filename: "agency-a-20260506.dump",
        createdAt: "2026-05-06T00:00:00.000Z",
        errorMessage: null
      }
    });
    const restore = buildRestoreInstructionsModel({ engine: "postgresql", filename: "agency-a-20260506.dump" });

    expect(dashboard.status).toBe("last_succeeded");
    expect(dashboard.storageUsagePercent).toBe(50);
    expect(restore.commands.join("\n")).toContain("pg_restore --host <HOST>");
    expect(restore.hasExecutionAction).toBeFalse();
  });

  test("accessibility-smoke keeps forms, errors, live status, keyboard order, and responsive states sane", () => {
    const field = buildFormFieldAccessibilityState({
      formId: "source-create",
      field: "display-name",
      required: true,
      description: "Shown to workspace members in backup history.",
      errorMessage: "Display name is required."
    });
    const summary = buildFormErrorSummary([
      { field: "displayName", message: "Display name is required." },
      { field: "host", message: "Host is required." }
    ]);
    const liveState = applyBackupJobEvent(createBackupJobDetailState("job-a11y"), {
      eventId: "job-a11y:uploading",
      jobId: "job-a11y",
      status: "running",
      stage: "uploading",
      terminal: false,
      attemptCount: 1,
      maxAttempts: 3,
      userErrorMessage: null,
      internalErrorRef: null,
      cancelRequestedAt: null,
      startedAt: "2026-05-06T00:00:00.000Z",
      finishedAt: null,
      queuedAt: "2026-05-06T00:00:00.000Z"
    });
    const statusRegion = buildBackupProgressStatusRegion(liveState.latestKnownSnapshot);
    const failedStatusRegion = buildBackupProgressStatusRegion({
      eventId: "job-a11y:failed",
      jobId: "job-a11y",
      status: "failed",
      stage: "failed",
      terminal: true,
      attemptCount: 1,
      maxAttempts: 3,
      userErrorMessage: "Backup failed before verification completed.",
      internalErrorRef: "err_ref_2",
      cancelRequestedAt: null,
      startedAt: "2026-05-06T00:00:00.000Z",
      finishedAt: "2026-05-06T00:03:00.000Z",
      queuedAt: "2026-05-06T00:00:00.000Z"
    });

    expect(field.labelId).toBe("source-create-display-name-label");
    expect(field.invalid).toBeTrue();
    expect(field.describedBy).toEqual([
      "source-create-display-name-description",
      "source-create-display-name-error"
    ]);
    expect(summary).toEqual({
      role: "alert",
      ariaLive: "assertive",
      title: "Fix highlighted fields before continuing.",
      items: [
        { field: "displayName", message: "Display name is required." },
        { field: "host", message: "Host is required." }
      ]
    });
    expect(statusRegion).toEqual({
      role: "status",
      ariaLive: "polite",
      ariaAtomic: true,
      message: "Backup uploading. Attempt 1 of 3."
    });
    expect(failedStatusRegion.message).toBe("Backup failed before verification completed.");
    expect(getBackupJobKeyboardOrder(liveState)).toEqual(["cancel"]);
    expect(buildDashboardEmptyState("no_projects")).toEqual({
      title: "Create first Project",
      description: "Projects group Database Sources before first manual Backup can run.",
      actions: [{ kind: "create_project", enabled: true }]
    });
    expect(buildDashboardEmptyState("ready_for_first_backup").actions.map((item) => item.kind)).toEqual(["run_backup"]);
    expect(buildResponsivePanelLayout(640)).toEqual({ variant: "stack", columns: 1, stickySummary: false });
    expect(buildResponsivePanelLayout(1280)).toEqual({ variant: "split", columns: 2, stickySummary: true });
  });
});
