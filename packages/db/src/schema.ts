import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const oauthProviderEnum = pgEnum("oauth_provider", ["google", "github"]);
export const workspaceMemberRoleEnum = pgEnum("workspace_member_role", ["owner", "admin", "member"]);
export const inviteRoleEnum = pgEnum("invite_role", ["admin", "member"]);
export const workspaceStorageStatusEnum = pgEnum("workspace_storage_status", ["pending", "ready", "failed"]);
export const workspaceOnboardingStepEnum = pgEnum("workspace_onboarding_step", [
  "workspace",
  "plan",
  "project",
  "database_source",
  "first_backup",
  "team",
  "complete"
]);
export const planSlugEnum = pgEnum("plan_slug", ["basic", "pro", "agency"]);
export const planRequestStatusEnum = pgEnum("plan_request_status", ["pending", "approved", "rejected", "cancelled"]);
export const backupStorageProviderEnum = pgEnum("backup_storage_provider", ["aws_s3", "cloudflare_r2", "minio", "local_disk"]);
export const backupStorageModeEnum = pgEnum("backup_storage_mode", ["platform_managed", "byos"]);
export const backupStorageStatusEnum = pgEnum("backup_storage_status", ["pending_test", "active", "retired", "failed"]);
export const databaseEngineEnum = pgEnum("database_engine", ["mysql", "postgresql"]);
export const sourceStateEnum = pgEnum("database_source_state", ["enabled", "disabled", "deleted"]);
export const sourceHealthEnum = pgEnum("database_source_health", ["healthy", "warning", "failing", "unknown"]);
export const connectionTestStatusEnum = pgEnum("connection_test_status", ["pending", "succeeded", "failed"]);
export const backupJobTriggerEnum = pgEnum("backup_job_trigger", ["manual", "scheduled"]);
export const backupJobStatusEnum = pgEnum("backup_job_status", ["queued", "running", "succeeded", "failed", "cancelled"]);
export const backupJobStageEnum = pgEnum("backup_job_stage", [
  "queued",
  "dumping",
  "compressing",
  "encrypting",
  "uploading",
  "verifying",
  "finalizing",
  "failed",
  "cancelled",
  "succeeded"
]);
export const backupStatusEnum = pgEnum("backup_status", ["succeeded", "deleted", "expired"]);
export const backupFormatEnum = pgEnum("backup_format", ["mysql_sql_gzip", "postgres_custom"]);
export const encryptionAlgorithmEnum = pgEnum("encryption_algorithm", ["aes_256_gcm_chunked"]);
export const auditActorTypeEnum = pgEnum("audit_actor_type", ["user", "system", "worker"]);
export const auditResultEnum = pgEnum("audit_result", ["succeeded", "failed", "denied"]);
export const systemAdminRoleEnum = pgEnum("system_admin_role", ["system_owner", "system_admin"]);
export const cleanupStatusEnum = pgEnum("cleanup_status", ["pending", "running", "succeeded", "failed", "cancelled"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
};

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  phoneNumber: varchar("phone_number", { length: 32 }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  ...timestamps
}, (table) => [uniqueIndex("users_email_unique_idx").on(table.email)]);

export const oauthAccounts = pgTable("oauth_accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: oauthProviderEnum("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  providerEmail: varchar("provider_email", { length: 320 }).notNull(),
  accessTokenEncrypted: text("access_token_encrypted"),
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  ...timestamps
}, (table) => [uniqueIndex("oauth_provider_account_unique_idx").on(table.provider, table.providerAccountId)]);

export const plans = pgTable("plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: planSlugEnum("slug").notNull(),
  displayName: text("display_name").notNull(),
  isRequestOnly: boolean("is_request_only").default(false).notNull(),
  databaseSourceLimit: integer("database_source_limit").notNull(),
  retainedStorageBytesLimit: bigint("retained_storage_bytes_limit", { mode: "bigint" }).notNull(),
  retentionDaysMax: integer("retention_days_max").notNull(),
  scheduleFrequencyPerDayMax: integer("schedule_frequency_per_day_max").notNull(),
  workspaceMemberLimit: integer("workspace_member_limit").notNull(),
  manualBackupPerHourLimit: integer("manual_backup_per_hour_limit").notNull(),
  ...timestamps
}, (table) => [uniqueIndex("plans_slug_unique_idx").on(table.slug)]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  timezone: text("timezone").notNull(),
  planId: uuid("plan_id").notNull().references(() => plans.id),
  storageStatus: workspaceStorageStatusEnum("storage_status").default("pending").notNull(),
  onboardingStep: workspaceOnboardingStepEnum("onboarding_step").default("workspace").notNull(),
  softDeletedAt: timestamp("soft_deleted_at", { withTimezone: true }),
  purgeScheduledAt: timestamp("purge_scheduled_at", { withTimezone: true }),
  ...timestamps
}, (table) => [uniqueIndex("workspaces_slug_unique_idx").on(table.slug)]);

export const workspaceMembers = pgTable("workspace_members", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: workspaceMemberRoleEnum("role").notNull(),
  invitedByUserId: uuid("invited_by_user_id").references(() => users.id),
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  ...timestamps
}, (table) => [
  uniqueIndex("workspace_members_workspace_user_unique_idx").on(table.workspaceId, table.userId)
]);

export const invites = pgTable("invites", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  role: inviteRoleEnum("role").notNull(),
  tokenHash: text("token_hash").notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  usedByUserId: uuid("used_by_user_id").references(() => users.id),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [uniqueIndex("invites_token_hash_unique_idx").on(table.tokenHash)]);

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionTokenHash: text("session_token_hash").notNull(),
  csrfTokenHash: text("csrf_token_hash").notNull(),
  activeWorkspaceId: uuid("active_workspace_id").references(() => workspaces.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  createdIp: text("created_ip"),
  userAgent: text("user_agent"),
  ...timestamps
}, (table) => [uniqueIndex("sessions_token_hash_unique_idx").on(table.sessionTokenHash)]);

export const planRequests = pgTable("plan_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  requestedPlanId: uuid("requested_plan_id").notNull().references(() => plans.id),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id),
  status: planRequestStatusEnum("status").default("pending").notNull(),
  reviewedByPlatformAdminId: uuid("reviewed_by_platform_admin_id"),
  reviewNote: text("review_note"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [
  uniqueIndex("plan_requests_one_pending_per_workspace_idx")
    .on(table.workspaceId)
    .where(sql`${table.status} = 'pending'`)
]);

export const systemAdmins = pgTable("system_admins", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: systemAdminRoleEnum("role").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  ...timestamps
}, (table) => [uniqueIndex("system_admins_user_unique_idx").on(table.userId)]);

export const workspaceLimitOverrides = pgTable("workspace_limit_overrides", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  databaseSourceLimit: integer("database_source_limit"),
  retainedStorageBytesLimit: bigint("retained_storage_bytes_limit", { mode: "bigint" }),
  retentionDaysMax: integer("retention_days_max"),
  scheduleFrequencyPerDayMax: integer("schedule_frequency_per_day_max"),
  workspaceMemberLimit: integer("workspace_member_limit"),
  manualBackupPerHourLimit: integer("manual_backup_per_hour_limit"),
  reason: text("reason").notNull(),
  createdByPlatformAdminId: uuid("created_by_platform_admin_id").notNull().references(() => systemAdmins.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  ...timestamps
});

export const backupStorageConfigs = pgTable("backup_storage_configs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  provider: backupStorageProviderEnum("provider").notNull(),
  mode: backupStorageModeEnum("mode").notNull(),
  displayName: text("display_name").notNull(),
  storagePrefix: text("storage_prefix").notNull(),
  encryptedCredentials: text("encrypted_credentials"),
  credentialFingerprint: text("credential_fingerprint").notNull(),
  status: backupStorageStatusEnum("status").default("pending_test").notNull(),
  isCurrent: boolean("is_current").default(false).notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  ...timestamps
}, (table) => [
  uniqueIndex("backup_storage_configs_one_current_per_workspace_idx")
    .on(table.workspaceId)
    .where(sql`${table.isCurrent} = true`)
]);

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  websiteUrl: text("website_url"),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  softDeletedAt: timestamp("soft_deleted_at", { withTimezone: true }),
  ...timestamps
}, (table) => [
  uniqueIndex("projects_active_name_per_workspace_idx")
    .on(table.workspaceId, table.name)
    .where(sql`${table.softDeletedAt} is null`)
]);

export const databaseSources = pgTable("database_sources", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  engine: databaseEngineEnum("engine").notNull(),
  displayName: text("display_name").notNull(),
  technicalDatabaseName: text("technical_database_name").notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  username: text("username").notNull(),
  encryptedPassword: text("encrypted_password").notNull(),
  credentialFingerprint: text("credential_fingerprint").notNull(),
  sslMode: text("ssl_mode").notNull(),
  state: sourceStateEnum("state").default("disabled").notNull(),
  health: sourceHealthEnum("health").default("unknown").notNull(),
  retentionDays: integer("retention_days").notNull(),
  scheduleFrequencyPerDay: integer("schedule_frequency_per_day").default(1).notNull(),
  scheduleEnabled: boolean("schedule_enabled").default(false).notNull(),
  lastConnectionTestAt: timestamp("last_connection_test_at", { withTimezone: true }),
  lastConnectionTestStatus: connectionTestStatusEnum("last_connection_test_status"),
  lastSuccessfulBackupAt: timestamp("last_successful_backup_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  softDeletedAt: timestamp("soft_deleted_at", { withTimezone: true }),
  ...timestamps
}, (table) => [
  check("database_sources_retention_days_check", sql`${table.retentionDays} between 7 and 30`),
  check("database_sources_schedule_frequency_check", sql`${table.scheduleFrequencyPerDay} between 1 and 5`),
  check("database_sources_port_check", sql`${table.port} between 1 and 65535`)
]);

export const backupJobs = pgTable("backup_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  databaseSourceId: uuid("database_source_id").notNull().references(() => databaseSources.id),
  trigger: backupJobTriggerEnum("trigger").notNull(),
  requestedByUserId: uuid("requested_by_user_id").references(() => users.id),
  status: backupJobStatusEnum("status").default("queued").notNull(),
  stage: backupJobStageEnum("stage").default("queued").notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(3).notNull(),
  errorCategory: text("error_category"),
  userErrorMessage: text("user_error_message"),
  internalErrorRef: text("internal_error_ref"),
  queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  cancelRequestedByUserId: uuid("cancel_requested_by_user_id").references(() => users.id),
  ...timestamps
}, (table) => [
  uniqueIndex("backup_jobs_one_active_per_source_idx")
    .on(table.databaseSourceId)
    .where(sql`${table.status} in ('queued', 'running')`),
  index("backup_jobs_workspace_idx").on(table.workspaceId)
]);

export const backups = pgTable("backups", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  databaseSourceId: uuid("database_source_id").notNull().references(() => databaseSources.id),
  backupJobId: uuid("backup_job_id").notNull().references(() => backupJobs.id),
  storageConfigId: uuid("storage_config_id").notNull().references(() => backupStorageConfigs.id),
  status: backupStatusEnum("status").default("succeeded").notNull(),
  engine: databaseEngineEnum("engine").notNull(),
  format: backupFormatEnum("format").notNull(),
  objectKey: text("object_key").notNull(),
  downloadFilename: text("download_filename").notNull(),
  originalDumpSizeBytes: bigint("original_dump_size_bytes", { mode: "bigint" }).notNull(),
  storedSizeBytes: bigint("stored_size_bytes", { mode: "bigint" }).notNull(),
  encryptedChecksum: text("encrypted_checksum").notNull(),
  retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  expiredAt: timestamp("expired_at", { withTimezone: true }),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id)
}, (table) => [uniqueIndex("backups_object_key_unique_idx").on(table.objectKey)]);

export const backupEncryptionKeys = pgTable("backup_encryption_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  backupId: uuid("backup_id").notNull().references(() => backups.id, { onDelete: "cascade" }),
  wrappedDataKey: text("wrapped_data_key").notNull(),
  workspaceKeyVersion: integer("workspace_key_version").notNull(),
  algorithm: encryptionAlgorithmEnum("algorithm").default("aes_256_gcm_chunked").notNull(),
  chunkSizeBytes: integer("chunk_size_bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [uniqueIndex("backup_encryption_keys_backup_unique_idx").on(table.backupId)]);

export const impersonationSessions = pgTable("impersonation_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  adminSessionId: uuid("admin_session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  adminUserId: uuid("admin_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  targetUserId: uuid("target_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  actorType: auditActorTypeEnum("actor_type").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  effectiveActorUserId: uuid("effective_actor_user_id").references(() => users.id),
  systemAdminId: uuid("system_admin_id").references(() => systemAdmins.id),
  impersonationSessionId: uuid("impersonation_session_id").references(() => impersonationSessions.id),
  sessionIdHash: text("session_id_hash"),
  requestId: text("request_id"),
  eventType: text("event_type").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  impersonationReason: text("impersonation_reason"),
  result: auditResultEnum("result").notNull(),
  internalErrorRef: text("internal_error_ref"),
  metadata: jsonb("metadata").default(sql`'{}'::jsonb`).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [index("audit_logs_workspace_created_idx").on(table.workspaceId, table.createdAt)]);

export const downloadRequests = pgTable("download_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  backupId: uuid("backup_id").notNull().references(() => backups.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionIdHash: text("session_id_hash").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdIp: text("created_ip"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [uniqueIndex("download_requests_token_hash_unique_idx").on(table.tokenHash)]);

export const backupDownloadLocks = pgTable("backup_download_locks", {
  id: uuid("id").defaultRandom().primaryKey(),
  backupId: uuid("backup_id").notNull().references(() => backups.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  downloadRequestId: uuid("download_request_id").notNull().references(() => downloadRequests.id, { onDelete: "cascade" }),
  sessionIdHash: text("session_id_hash").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
}, (table) => [
  uniqueIndex("backup_download_locks_one_active_per_request_idx").on(table.downloadRequestId),
  index("backup_download_locks_backup_idx").on(table.backupId)
]);

export const cleanupRecords = pgTable("cleanup_records", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  backupJobId: uuid("backup_job_id").references(() => backupJobs.id, { onDelete: "set null" }),
  backupId: uuid("backup_id").references(() => backups.id, { onDelete: "set null" }),
  objectKey: text("object_key"),
  reason: text("reason").notNull(),
  status: cleanupStatusEnum("status").default("pending").notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  deleteRetryAfter: timestamp("delete_retry_after", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const schema = {
  users,
  oauthAccounts,
  plans,
  workspaces,
  workspaceMembers,
  invites,
  sessions,
  planRequests,
  systemAdmins,
  workspaceLimitOverrides,
  backupStorageConfigs,
  projects,
  databaseSources,
  backupJobs,
  backups,
  backupEncryptionKeys,
  impersonationSessions,
  auditLogs,
  downloadRequests,
  backupDownloadLocks,
  cleanupRecords
};

export type Schema = typeof schema;
