# Web onboarding screens

## Route structure

- `/` — marketing landing
- `/login` — OAuth sign-in
- `/app` — authenticated global Workspace launcher
- `/app/new-workspace` — create Workspace flow
- `/workspace/:workspaceSlug` — Workspace dashboard
- `/workspace/:workspaceSlug/onboarding` — onboarding checklist and guided setup
- `/workspace/:workspaceSlug/projects/:projectId` — Project detail
- `/workspace/:workspaceSlug/sources/:sourceId` — Database Source detail
- `/workspace/:workspaceSlug/backup-jobs/:jobId` — Backup Job detail and live progress
- `/workspace/:workspaceSlug/settings/*` — Workspace settings
- `/invite/:token` — invite preview and acceptance

## Login redirect

After OAuth login:

1. Redirect to last active Workspace if available.
2. Otherwise, if user belongs to exactly one Workspace, redirect to that Workspace dashboard.
3. Otherwise, redirect to `/app`.

## Workspace launcher

`/app` shows:

- Workspaces the user belongs to.
- Create Workspace action.
- Account/profile access.

Rules:

- A signed-in user can create one Workspace by default.
- Creating a second Workspace requires System Admin approval.

## Create Workspace flow

Route: `/app/new-workspace`

Sections:

1. Workspace identity
   - name
   - slug preview
   - timezone
2. Plan selection
   - Basic self-serve
   - Pro request access
   - Agency request access
3. Review and create

Rules:

- Timezone defaults from browser-detected timezone and can be changed.
- Slug is auto-generated from name and editable before creation.
- Workspace Owner only can change Workspace slug after creation.
- If Pro/Agency is requested, Workspace is created on Basic and a pending plan request banner is shown.

## Storage provisioning state

After Workspace creation:

- Platform-managed Backup Storage provisioning starts asynchronously.
- Workspace shows `storage_status: provisioning` until complete.
- If provisioning fails, onboarding shows failed status and retry action.
- User can continue creating Project and Database Source while storage is provisioning.
- Backup Jobs are blocked until storage is ready.

Storage screen shows:

- status: provisioning, succeeded, or failed
- provider name
- retry button when failed
- support/admin contact link after repeated failure

## Onboarding behavior

Onboarding can be skipped to the dashboard. Dashboard then shows a setup checklist.

Checklist items:

- Workspace created
- Storage provisioned
- Project created
- Database Source added
- Connection tested
- First Backup succeeded
- Team invite optional

## Project creation

Project creation uses a dedicated onboarding form page.

Fields:

- name required
- website URL optional

No default Project is auto-created.

## Database Source wizard

Database Source creation uses a multi-step wizard.

Steps:

1. Engine
2. Source identity
3. Connection details
4. Test connection
5. Retention
6. Review and save

### Engine step

Engine cards:

- MySQL/MariaDB
- PostgreSQL

### Source identity step

Fields:

- display name required
- technical database name handled separately in connection details

### Connection details step

MySQL/MariaDB fields:

- host
- port, default 3306
- database name
- username
- password
- advanced SSL mode, default require TLS for hosted SaaS

PostgreSQL fields:

- host
- port, default 5432
- database name
- username
- password
- advanced SSL mode, default require TLS for hosted SaaS

PostgreSQL Database Source backs up the entire database. Schema selection is not supported in v1.

### Test connection step

Test checks:

- connection success/failure
- server version
- database exists
- dump tool compatibility warning if any
- permission check result
- TLS status
- sanitized error if failed

An optional **Estimate size** action can run a quick approximate database size estimate. If the estimate may exceed remaining storage, UI warns but does not block.

### Retention step

UI shows:

- retention select with values allowed by current Workspace Plan
- note that v1 uses manual Backups only; user starts each Backup explicitly

### Save behavior

After source is saved, app prompts:

- Primary: **Run first backup now**
- Secondary: **Skip for now**

The app does not auto-run the first Backup without explicit user action.

## Backup Job detail

When user starts the first Backup, app opens the Backup Job detail page.

Route:

- `/workspace/:workspaceSlug/backup-jobs/:jobId`

The page uses SSE for live progress.

Progress stages include high-level safe stages only, such as:

- queued
- connected
- dumping
- compressing when applicable
- encrypting
- uploading
- verifying
- succeeded or failed

Raw dump tool output is not shown.

## First Backup success screen

Shows:

- success status
- backup filename
- stored size
- duration
- Download Backup button
- dismissible invite team prompt

## First Backup failure screen

Shows:

- sanitized failure reason
- failed stage
- retry button
- edit connection/settings button
- link to high-level logs

Raw command output is not shown.

## Invite team prompt

After first Backup succeeds:

- show dismissible invite team prompt
- Workspace Owner can invite Workspace Admins and Workspace Members
- Workspace Admin can invite Workspace Members only
- invite creation only chooses role
- invite link is single-use, expires after 7 days, and embeds role

Invite acceptance:

1. Invitee opens `/invite/:token`.
2. Page shows public limited preview: Workspace name and role only.
3. Invitee signs in with Google or GitHub OAuth.
4. Page shows signed-in account, Workspace, and role.
5. Invitee explicitly accepts.
6. Membership is created and invite is marked used.
