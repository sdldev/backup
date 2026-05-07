# Implementation order

## Milestone 1: Auth, users, and Workspace creation

Goal: signed-in user can create first Workspace and become Workspace Owner.

Scope:

- monorepo scaffold
- Postgres and Drizzle setup
- base migrations
- `users`
- `oauth_accounts`
- `sessions`
- `workspaces`
- `workspace_members`
- seeded `plans`
- Google OAuth
- GitHub OAuth
- HTTP-only secure session cookie
- `/app` Workspace launcher
- `/app/new-workspace` create Workspace flow
- Basic self-serve Workspace creation
- exactly one Workspace Owner membership

Acceptance:

- User can sign in with Google or GitHub verified email.
- User without Workspace lands on `/app`.
- User can create one Workspace.
- Created Workspace has Basic plan and one Workspace Owner.

## Milestone 2: Storage provisioning and Project creation

Goal: new Workspace gets platform-managed Backup Storage and first Project.

Scope:

- platform-managed Backup Storage config model
- async storage provisioning job
- `storage_status`
- provisioning retry route
- storage provisioning UI state
- Project model
- Project create/list/detail UI
- onboarding checklist begins

Acceptance:

- Workspace creation triggers storage provisioning.
- Storage success/failure is visible.
- User can retry failed provisioning.
- User can create first Project with name and optional website URL.

## Milestone 3: Database Source wizard and connection test

Goal: user can add a Database Source and validate access.

Scope:

- `database_sources`
- encrypted Database Credential storage
- no human full reveal of saved credentials
- Source wizard steps
- MySQL/MariaDB connection fields
- PostgreSQL connection fields
- advanced SSL config with hosted default require TLS
- unsaved source connection test
- saved source connection test
- minimal dump capability check
- optional database size estimate
- source enable/disable/delete/move

Acceptance:

- User can create a Source after successful test.
- User can save disabled draft if test fails.
- Enabling Source requires successful test.
- Replacing credentials pauses Source schedule readiness until test succeeds.

## Milestone 4: Manual Backup worker pipeline

Goal: user can run a manual Backup that creates encrypted stored artifact.

Scope:

- `backup_jobs`
- `backups`
- `backup_encryption_keys`
- queue table
- Bun worker process
- worker includes `pg_dump` and `mysqldump`
- MySQL/MariaDB dump command
- PostgreSQL `pg_dump -Fc`
- streamed dump pipeline
- chunked AES-256-GCM encryption
- authenticated object header with format version
- platform-managed storage upload
- checksum/integrity diagnostic
- plan storage hard-limit enforcement while streaming
- retry 3 times with exponential backoff
- one active Backup Job per Database Source
- best-effort cancellation
- SSE Backup Job progress

Acceptance:

- User can click **Run first backup now**.
- Backup Job detail shows live high-level progress.
- Successful Backup creates encrypted object in storage.
- Failed/cancelled Backup cleans partial local temp data and partial storage object.

## Milestone 5: Decrypted downloads and Backup history

Goal: stored Backups are visible and retrievable.

Scope:

- Backup list/detail pages
- backup filename generation
- short-lived download requests
- 15-minute download token
- same-session download authorization
- decrypted streaming download
- MySQL `.sql.gz` downloads
- PostgreSQL `.dump` downloads
- stored/original size display
- high-level job logs display

Acceptance:

- Authorized Workspace users can download decrypted Backup files.
- System Admin/System Owner cannot download customer Backups.
- Download events are prepared for audit logging.

## Milestone 6: Retention, manual delete, and audit log

Goal: data lifecycle and sensitive actions are tracked.

Scope:

- retention deletion worker
- hard delete Backup files at retention expiry
- Backup metadata retention for 1 year
- manual Backup deletion by Workspace Owner/Workspace Admin
- Audit Log model
- audit log UI
- audit events for login, invite, member changes, credential changes, storage changes, backup download/delete, source changes
- sanitized user-facing errors with internal error refs

Acceptance:

- Expired Backups are deleted automatically.
- Workspace Owner/Admin can manually delete Backups.
- Sensitive actions appear in Audit Log.

## Milestone 7: Team invites and permission enforcement

Goal: agency teams can join and permissions are enforced.

Scope:

- invite model
- invite token hash only
- invite creation UI
- invite public preview
- OAuth login then explicit accept
- member list
- role changes
- member removal
- ownership transfer
- permission matrix enforcement across API routes

Acceptance:

- Workspace Owner can invite Workspace Admins and Workspace Members.
- Workspace Admin can invite Workspace Members only.
- Workspace Member cannot invite users.
- Ownership transfer works only from Workspace Owner to Workspace Admin.
- Permission matrix is enforced server-side.

## Milestone 8: Plans, System Admin dashboard, and impersonation

Goal: beta access and support operations work safely.

Scope:

- plan request flow
- System Admin dashboard
- plan request approval/rejection
- Workspace list/status/health for System Admin
- Workspace limit overrides with reason and optional expiry
- System Admin management by System Owner
- impersonation with reason, audit log, visible banner
- impersonation restrictions: no Backup download and no secret changes

Acceptance:

- Pro/Agency requests enter admin queue and notify System Admin.
- System Admin can approve/reject requests.
- System Admin can create limit overrides.
- Impersonation works with required safeguards and restrictions.

## Milestone 9: Health dashboard, restore docs, and beta polish

Goal: first release feels complete for beta agencies.

Scope:

- dashboard health overview for manual-backup release
- last backup status
- storage usage
- setup checklist
- first backup success/failure screens
- restore docs page
- per-Backup restore instructions
- production restore warnings
- responsive UI polish
- empty states
- error states
- rate limiting for auth, backup actions, and download token creation

Acceptance:

- Workspace dashboard shows current protection status honestly for manual-only release.
- Users can follow restore instructions outside the app.
- App is ready for first beta users.

## Phase 2 after first release

- Schedule UI
- scheduler worker
- scheduled Backup Jobs
- scheduled health model
- email notifications

## Later phases

- webhooks
- BYOS Backup Storage
- Connectivity Agent
- public API
- CLI
- app-managed restore
- billing provider integration
