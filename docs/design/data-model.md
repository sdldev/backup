# Data model design

## Identity and access

### users

Stores SaaS user accounts.

Fields:

- `id`
- `email` — unique verified email across OAuth providers
- `name`
- `avatar_url`
- `phone_number` nullable; optional editable profile field, unverified in v1
- `created_at`
- `updated_at`
- `last_login_at`
- `disabled_at` nullable

Rules:

- v1 sign-in uses Google and GitHub OAuth only.
- OAuth login is rejected if the provider does not supply a verified email.
- Email/password sign-in is not supported.
- No app-level MFA in v1; account security relies on Google/GitHub.

### oauth_accounts

Links OAuth provider accounts to a User.

Rules:

- One User can have multiple OAuth accounts.
- Each provider account is unique.
- Google and GitHub accounts with the same verified email link to the same User.

### workspaces

Stores tenants.

Fields:

- `id`
- `name`
- `slug` — globally unique
- `timezone`
- `plan_id`
- `storage_status`
- `onboarding_step`
- `created_at`
- `updated_at`
- `soft_deleted_at` nullable
- `purge_scheduled_at` nullable

Rules:

- Workspace Owner is derived from `workspace_members`, not stored on `workspaces`.
- Web URLs use Workspace slug.
- API routes use Workspace ID.
- Workspace deletion is soft-delete first; Backups purge after 7 days.
- Workspace Owner can restore a deleted Workspace during the 7-day grace period.

### workspace_members

Stores Workspace membership and role.

Fields:

- `id`
- `workspace_id`
- `user_id`
- `role` — `owner`, `admin`, or `member`
- `invited_by_user_id` nullable
- `joined_at`
- `created_at`
- `updated_at`

Rules:

- Unique (`workspace_id`, `user_id`).
- Exactly one Workspace Owner per Workspace.
- A Workspace can have multiple Workspace Admins and Workspace Members.
- Ownership can be transferred to a Workspace Admin.
- After ownership transfer, the previous Workspace Owner becomes Workspace Admin.
- Workspace Owner can invite Workspace Admins and Workspace Members.
- Workspace Admin can invite Workspace Members only.
- Workspace Owner/Workspace Admin can remove Workspace Members.
- Workspace Owner can remove Workspace Admins.
- Sole Workspace Owner cannot be removed.

### invites

Stores single-use Workspace invite links.

Fields:

- `id`
- `workspace_id`
- `role`
- `token_hash`
- `created_by_user_id`
- `expires_at`
- `used_at` nullable
- `used_by_user_id` nullable
- `revoked_at` nullable
- `created_at`

Rules:

- Store only invite token hash.
- Invite links are single-use.
- Invite links expire after 7 days.
- Role is embedded in the invite.
- Invitee opens link, signs in with Google/GitHub OAuth, explicitly accepts, then joins.

## Plans

### plans

Seeded table for Basic, Pro, and Agency plans.

Accepted tier limits:

- Basic: 3 Database Sources, 10 GB retained storage, 7-day max retention, 1 scheduled Backup per day per source, 2 members, 1 manual Backup per source per hour.
- Pro: 20 Database Sources, 100 GB retained storage, 30-day max retention, 5 scheduled Backups per day per source, 5 members, 5 manual Backups per source per hour.
- Agency: 100 Database Sources, 1 TB retained storage, 30-day max retention, 5 scheduled Backups per day per source, 20 members, 10 manual Backups per source per hour.

Rules:

- Basic is self-serve.
- Pro and Agency are request-access plans in v1.

### plan_requests

Stores Pro/Agency access requests.

Fields:

- `id`
- `workspace_id`
- `requested_plan_id`
- `requested_by_user_id`
- `status` — `pending`, `approved`, `rejected`, or `cancelled`
- `reviewed_by_platform_admin_id` nullable
- `review_note` nullable
- `created_at`
- `reviewed_at` nullable

Rules:

- Only one pending plan request per Workspace.
- Plan requests notify System Admin by email and appear in the admin dashboard queue.

### workspace_limit_overrides

Stores Workspace-specific limit overrides.

Fields:

- `id`
- `workspace_id`
- nullable limit fields
- `reason`
- `created_by_platform_admin_id`
- `expires_at` nullable
- `created_at`
- `updated_at`

Rules:

- Overrides must be audited.
- Overrides may be temporary or permanent.

## Storage

### backup_storage_configs

Stores current and historical Backup Storage configuration for a Workspace.

Fields:

- `id`
- `workspace_id`
- `provider` — `aws_s3`, `cloudflare_r2`, `minio`, or `local_disk`
- `mode` — `platform_managed` or `byos`
- `display_name`
- `storage_prefix` — opaque prefix
- `encrypted_credentials` nullable
- `credential_fingerprint`
- `status` — `pending_test`, `active`, `retired`, or `failed`
- `is_current`
- `created_by_user_id` nullable
- `activated_at` nullable
- `retired_at` nullable
- `created_at`
- `updated_at`

Rules:

- Backups reference the storage config used to create them.
- Existing Backups remain in old storage after provider changes.
- Old encrypted storage credentials are retained until all Backups using them expire or are deleted.
- Platform-managed storage stores no per-Workspace credentials; it references provider and opaque prefix only.
- BYOS credentials are masked, replace-only, and cannot be fully revealed by any human role.
- New Backup Storage credentials must pass a test before activation; old storage remains active until then.

## Projects and sources

### projects

Stores client/site/app groupings inside a Workspace.

Fields:

- `id`
- `workspace_id`
- `name`
- `website_url` nullable
- `created_by_user_id`
- `created_at`
- `updated_at`
- `soft_deleted_at` nullable

Rules:

- Active Project names are unique within a Workspace.
- Project deletion is soft-delete.
- Deleting a Project soft-deletes its Database Sources.
- Existing Backups follow their Database Source retention.

### database_sources

Stores one specific database that a Project backs up.

Fields:

- `id`
- `workspace_id`
- `project_id`
- `engine` — `mysql` or `postgresql`
- `display_name`
- `technical_database_name`
- `host`
- `port`
- `username`
- `encrypted_password`
- `credential_fingerprint`
- `ssl_mode`
- `state` — `enabled`, `disabled`, or `deleted`
- `health` — `healthy`, `warning`, `failing`, or `unknown`
- `retention_days`
- `schedule_frequency_per_day`
- `schedule_enabled`
- `last_connection_test_at`
- `last_connection_test_status`
- `last_successful_backup_at`
- `created_by_user_id`
- `created_at`
- `updated_at`
- `soft_deleted_at` nullable

Rules:

- Tenant-owned rows store `workspace_id` even when derivable, and consistency is enforced.
- Database Source uses structured connection fields, not only a URL.
- Hosted SaaS defaults to requiring TLS; SSL options are advanced UI.
- Connection test checks connectivity and minimal dump capability.
- Test uses in-memory credentials. Failed tests can still be saved as disabled drafts with encrypted credentials. Enabling requires a successful test.
- Replacing credentials pauses schedule until connection test succeeds.
- Stored secrets are masked and replace-only; no human role can reveal them after save.
- Source can be enabled, disabled, or deleted.
- Source enabled with schedule disabled means manual-only.
- Disabled Source cannot run manual or scheduled Backups.
- Database Source deletion is soft-delete; existing Backups remain until retention expires.
- Database Source can move between Projects. Backups remain attached to the Source and appear under the new Project.

## Backups

### backup_jobs

Stores Backup execution attempts.

Fields:

- `id`
- `workspace_id`
- `project_id`
- `database_source_id`
- `trigger` — `manual` or `scheduled`
- `requested_by_user_id` nullable
- `status` — `queued`, `running`, `succeeded`, `failed`, or `cancelled`
- `stage`
- `attempt_count`
- `max_attempts`
- `error_category` nullable
- `user_error_message` nullable
- `internal_error_ref` nullable
- `queued_at`
- `started_at` nullable
- `finished_at` nullable
- `cancel_requested_at` nullable
- `cancel_requested_by_user_id` nullable
- `created_at`
- `updated_at`

Rules:

- Backup Jobs retry 3 times with exponential backoff.
- One active Backup Job per Database Source.
- Manual backup rate limits are plan-based.
- Scheduled frequency and retention are bounded by Workspace Plan.
- Cancellation is best-effort and attempts to stop the dump process.
- Failed/cancelled Backups delete partial local temp data and partial storage objects.
- Backup Job detail page uses SSE for live progress.

### backups

Stores retained Backup artifacts.

Fields:

- `id`
- `workspace_id`
- `project_id`
- `database_source_id`
- `backup_job_id`
- `storage_config_id`
- `status` — `succeeded`, `deleted`, or `expired`
- `engine`
- `format` — `mysql_sql_gzip` or `postgres_custom`
- `object_key`
- `download_filename`
- `original_dump_size_bytes`
- `stored_size_bytes`
- `encrypted_checksum`
- `retention_expires_at`
- `created_at`
- `deleted_at` nullable
- `expired_at` nullable
- `deleted_by_user_id` nullable

Rules:

- Backup Job and Backup artifact are separate records.
- Failed and cancelled jobs may not create Backups.
- Object keys are opaque.
- Download filenames use `{project}-{source}-{timestamp}.{ext}` with UTC compact timestamp like `20250314T021530Z`.
- MySQL Backups download as `.sql.gz`.
- PostgreSQL Backups use `pg_dump -Fc` built-in compression and download as `.dump`.
- Backup metadata is retained for 1 year after file deletion or expiry.

### backup_encryption_keys

Stores wrapped data keys for Backup artifacts.

Fields:

- `id`
- `workspace_id`
- `backup_id`
- `wrapped_data_key`
- `workspace_key_version`
- `algorithm` — `aes_256_gcm_chunked`
- `chunk_size_bytes`
- `created_at`

Rules:

- Backup encryption uses chunked AES-256-GCM.
- Chunk encryption metadata is stored in the encrypted backup object header.
- Backup object header is authenticated.
- Backup object header includes object format version.

## Tenant isolation

Rules:

- Tenant isolation is enforced by app-layer checks in v1.
- Postgres Row Level Security is not used in v1.
- Workspace-scoped API routes use `/v1/workspaces/:workspaceId/...`.
- API uses Workspace ID; web URLs use Workspace slug.
