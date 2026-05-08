import { relations, sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const oauthProviderEnum = pgEnum('oauth_provider', ['google', 'github']);
export const workspaceRoleEnum = pgEnum('workspace_role', ['owner', 'admin', 'member']);
export const planSlugEnum = pgEnum('plan_slug', ['basic', 'pro', 'agency']);
export const planRequestStatusEnum = pgEnum('plan_request_status', ['pending', 'approved', 'rejected', 'cancelled']);
export const storageStatusEnum = pgEnum('workspace_storage_status', ['provisioning', 'ready', 'failed']);
export const backupStorageProviderEnum = pgEnum('backup_storage_provider', ['aws_s3', 'cloudflare_r2', 'minio', 'local_disk']);
export const backupStorageModeEnum = pgEnum('backup_storage_mode', ['platform_managed', 'byos']);
export const databaseEngineEnum = pgEnum('database_engine', ['mysql', 'postgresql']);
export const databaseSourceStateEnum = pgEnum('database_source_state', ['enabled', 'disabled', 'deleted']);
export const databaseSourceHealthEnum = pgEnum('database_source_health', ['healthy', 'warning', 'failing', 'unknown']);
export const connectionTestStatusEnum = pgEnum('connection_test_status', ['succeeded', 'failed']);
export const backupJobTriggerEnum = pgEnum('backup_job_trigger', ['manual', 'scheduled']);
export const backupJobStatusEnum = pgEnum('backup_job_status', ['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export const backupStatusEnum = pgEnum('backup_status', ['succeeded', 'deleted', 'expired']);
export const backupFormatEnum = pgEnum('backup_format', ['mysql_sql_gzip', 'postgres_custom']);
export const downloadRequestStatusEnum = pgEnum('download_request_status', ['created', 'used', 'expired']);
export const auditActorTypeEnum = pgEnum('audit_actor_type', ['user', 'system', 'platform_admin']);
export const inviteStatusEnum = pgEnum('invite_status', ['created', 'accepted', 'revoked', 'expired']);

export const backupJobStageEnum = pgEnum('backup_job_stage', [
  'queued',
  'connected',
  'dumping',
  'compressing',
  'encrypting',
  'uploading',
  'verifying',
  'succeeded',
  'failed',
  'cancelled',
]);
export const backupStorageConfigStatusEnum = pgEnum('backup_storage_config_status', ['pending_test', 'active', 'retired', 'failed']);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  phoneNumber: text('phone_number'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  ...timestamps,
});

export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: oauthProviderEnum('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    providerEmail: text('provider_email').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('oauth_accounts_provider_account_uidx').on(table.provider, table.providerAccountId),
    index('oauth_accounts_user_id_idx').on(table.userId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId), index('sessions_expires_at_idx').on(table.expiresAt)],
);

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: planSlugEnum('slug').notNull().unique(),
  name: text('name').notNull(),
  databaseSourceLimit: integer('database_source_limit').notNull(),
  retainedStorageBytes: bigint('retained_storage_bytes', { mode: 'number' }).notNull(),
  maxRetentionDays: integer('max_retention_days').notNull(),
  scheduledBackupsPerDay: integer('scheduled_backups_per_day').notNull(),
  memberLimit: integer('member_limit').notNull(),
  manualBackupsPerSourcePerHour: integer('manual_backups_per_source_per_hour').notNull(),
  selfServe: boolean('self_serve').notNull().default(false),
  ...timestamps,
});

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    timezone: text('timezone').notNull(),
    planId: uuid('plan_id').notNull().references(() => plans.id),
    storageStatus: storageStatusEnum('storage_status').notNull().default('provisioning'),
    onboardingStep: text('onboarding_step').notNull().default('workspace_created'),
    softDeletedAt: timestamp('soft_deleted_at', { withTimezone: true }),
    purgeScheduledAt: timestamp('purge_scheduled_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('workspaces_plan_id_idx').on(table.planId), index('workspaces_created_at_idx').on(table.createdAt)],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRoleEnum('role').notNull(),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('workspace_members_workspace_user_uidx').on(table.workspaceId, table.userId),
    index('workspace_members_workspace_id_idx').on(table.workspaceId),
    index('workspace_members_user_id_idx').on(table.userId),
  ],
);

export const planRequests = pgTable(
  'plan_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    requestedPlanId: uuid('requested_plan_id').notNull().references(() => plans.id),
    requestedByUserId: uuid('requested_by_user_id').notNull().references(() => users.id),
    status: planRequestStatusEnum('status').notNull().default('pending'),
    reviewedByPlatformAdminId: uuid('reviewed_by_platform_admin_id').references(() => users.id),
    reviewNote: text('review_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  },
  (table) => [
    index('plan_requests_workspace_id_idx').on(table.workspaceId),
    index('plan_requests_status_idx').on(table.status),
    uniqueIndex('plan_requests_one_pending_per_workspace_uidx').on(table.workspaceId).where(sql`${table.status} = 'pending'`),
  ],
);

export const workspaceLimitOverrides = pgTable(
  'workspace_limit_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    databaseSourceLimit: integer('database_source_limit'),
    retainedStorageBytes: bigint('retained_storage_bytes', { mode: 'number' }),
    maxRetentionDays: integer('max_retention_days'),
    scheduledBackupsPerDay: integer('scheduled_backups_per_day'),
    memberLimit: integer('member_limit'),
    manualBackupsPerSourcePerHour: integer('manual_backups_per_source_per_hour'),
    reason: text('reason').notNull(),
    createdByPlatformAdminId: uuid('created_by_platform_admin_id').notNull().references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('workspace_limit_overrides_workspace_id_idx').on(table.workspaceId)],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    websiteUrl: text('website_url'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    softDeletedAt: timestamp('soft_deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('projects_workspace_id_idx').on(table.workspaceId),
    uniqueIndex('projects_active_name_per_workspace_uidx')
      .on(table.workspaceId, table.name)
      .where(sql`${table.softDeletedAt} is null`),
  ],
);

export const databaseSources = pgTable(
  'database_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    engine: databaseEngineEnum('engine').notNull(),
    displayName: text('display_name').notNull(),
    technicalDatabaseName: text('technical_database_name').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    username: text('username').notNull(),
    encryptedPassword: text('encrypted_password'),
    credentialFingerprint: text('credential_fingerprint'),
    sslMode: text('ssl_mode').notNull().default('require'),
    state: databaseSourceStateEnum('state').notNull().default('disabled'),
    health: databaseSourceHealthEnum('health').notNull().default('unknown'),
    retentionDays: integer('retention_days').notNull().default(7),
    lastConnectionTestAt: timestamp('last_connection_test_at', { withTimezone: true }),
    lastConnectionTestStatus: connectionTestStatusEnum('last_connection_test_status'),
    lastSuccessfulBackupAt: timestamp('last_successful_backup_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    softDeletedAt: timestamp('soft_deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('database_sources_workspace_id_idx').on(table.workspaceId),
    index('database_sources_project_id_idx').on(table.projectId),
    uniqueIndex('database_sources_active_display_name_per_project_uidx')
      .on(table.projectId, table.displayName)
      .where(sql`${table.softDeletedAt} is null`),
  ],
);

export const backupJobs = pgTable(
  'backup_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    databaseSourceId: uuid('database_source_id')
      .notNull()
      .references(() => databaseSources.id),
    trigger: backupJobTriggerEnum('trigger').notNull(),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id),
    status: backupJobStatusEnum('status').notNull().default('queued'),
    stage: backupJobStageEnum('stage').notNull().default('queued'),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    errorCategory: text('error_category'),
    userErrorMessage: text('user_error_message'),
    internalErrorRef: text('internal_error_ref'),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    cancelRequestedByUserId: uuid('cancel_requested_by_user_id').references(() => users.id),
    ...timestamps,
  },
  (table) => [
    index('backup_jobs_workspace_id_idx').on(table.workspaceId),
    index('backup_jobs_database_source_id_idx').on(table.databaseSourceId),
    index('backup_jobs_created_at_idx').on(table.createdAt),
    uniqueIndex('backup_jobs_one_active_per_source_uidx')
      .on(table.databaseSourceId)
      .where(sql`${table.status} in ('queued', 'running')`),
  ],
);

export const backups = pgTable(
  'backups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    databaseSourceId: uuid('database_source_id')
      .notNull()
      .references(() => databaseSources.id),
    backupJobId: uuid('backup_job_id')
      .notNull()
      .references(() => backupJobs.id),
    storageConfigId: uuid('storage_config_id')
      .notNull()
      .references(() => backupStorageConfigs.id),
    status: backupStatusEnum('status').notNull().default('succeeded'),
    format: backupFormatEnum('format').notNull(),
    objectKey: text('object_key').notNull(),
    downloadFilename: text('download_filename').notNull(),
    encryptedSizeBytes: bigint('encrypted_size_bytes', { mode: 'number' }).notNull(),
    originalSizeBytes: bigint('original_size_bytes', { mode: 'number' }),
    checksumSha256: text('checksum_sha256'),
    retentionExpiresAt: timestamp('retention_expires_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('backups_workspace_id_idx').on(table.workspaceId),
    index('backups_database_source_id_idx').on(table.databaseSourceId),
    index('backups_backup_job_id_idx').on(table.backupJobId),
    index('backups_created_at_idx').on(table.createdAt),
  ],
);

export const downloadRequests = pgTable(
  'download_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    backupId: uuid('backup_id')
      .notNull()
      .references(() => backups.id),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    tokenHash: text('token_hash').notNull().unique(),
    status: downloadRequestStatusEnum('status').notNull().default('created'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('download_requests_workspace_id_idx').on(table.workspaceId),
    index('download_requests_backup_id_idx').on(table.backupId),
    index('download_requests_expires_at_idx').on(table.expiresAt),
  ],
);

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: workspaceRoleEnum('role').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    status: inviteStatusEnum('status').notNull().default('created'),
    invitedByUserId: uuid('invited_by_user_id').notNull().references(() => users.id),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('invites_workspace_id_idx').on(table.workspaceId),
    index('invites_token_hash_idx').on(table.tokenHash),
    uniqueIndex('invites_one_active_email_per_workspace_uidx')
      .on(table.workspaceId, table.email)
      .where(sql`${table.status} = 'created'`),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    actorType: auditActorTypeEnum('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id'),
    metadata: text('metadata').notNull().default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_events_workspace_id_idx').on(table.workspaceId),
    index('audit_events_created_at_idx').on(table.createdAt),
    index('audit_events_event_type_idx').on(table.eventType),
  ],
);

export const backupStorageConfigs = pgTable(
  'backup_storage_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: backupStorageProviderEnum('provider').notNull(),
    mode: backupStorageModeEnum('mode').notNull(),
    displayName: text('display_name').notNull(),
    storagePrefix: text('storage_prefix').notNull(),
    encryptedCredentials: text('encrypted_credentials'),
    credentialFingerprint: text('credential_fingerprint'),
    status: backupStorageConfigStatusEnum('status').notNull().default('pending_test'),
    isCurrent: boolean('is_current').notNull().default(false),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('backup_storage_configs_workspace_id_idx').on(table.workspaceId)],
);

export const userRelations = relations(users, ({ many }) => ({
  oauthAccounts: many(oauthAccounts),
  sessions: many(sessions),
  memberships: many(workspaceMembers),
}));

export const workspaceRelations = relations(workspaces, ({ one, many }) => ({
  plan: one(plans, { fields: [workspaces.planId], references: [plans.id] }),
  members: many(workspaceMembers),
  planRequests: many(planRequests),
  storageConfigs: many(backupStorageConfigs),
  projects: many(projects),
  databaseSources: many(databaseSources),
  backupJobs: many(backupJobs),
  backups: many(backups),
  downloadRequests: many(downloadRequests),
  invites: many(invites),
  auditEvents: many(auditEvents),
}));

export const workspaceMemberRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, { fields: [workspaceMembers.workspaceId], references: [workspaces.id] }),
  user: one(users, { fields: [workspaceMembers.userId], references: [users.id] }),
}));
