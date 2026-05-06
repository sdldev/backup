# API routes design

All application API routes are versioned under `/v1`.

Workspace-scoped routes use Workspace ID, not slug. Web URLs may use Workspace slug.

## Auth and session

API owns auth, OAuth callbacks, and session cookies.

Routes:

- `GET /v1/auth/google/start`
- `GET /v1/auth/google/callback`
- `GET /v1/auth/github/start`
- `GET /v1/auth/github/callback`
- `POST /v1/auth/logout`
- `GET /v1/session`

Rules:

- OAuth start accepts a safe relative `return_to` parameter only.
- OAuth login requires verified email from provider.
- API sets HTTP-only secure session cookie.
- Sessions are stored in Postgres.
- Astro SSR checks auth by forwarding cookies to `GET /v1/session`.

## Workspaces

Routes:

- `GET /v1/workspaces` — list Workspaces for current User
- `POST /v1/workspaces` — create Workspace
- `GET /v1/workspaces/:workspaceId`
- `PATCH /v1/workspaces/:workspaceId`
- `DELETE /v1/workspaces/:workspaceId` — soft-delete Workspace
- `POST /v1/workspaces/:workspaceId/restore` — restore during deletion grace
- `POST /v1/workspaces/:workspaceId/storage/provision/retry`

Create request fields:

- `name`
- `slug` optional; generated from name if absent
- `timezone`
- `requested_plan` optional: `basic`, `pro`, or `agency`

Create behavior:

- Creates Workspace on Basic.
- If `requested_plan` is Pro or Agency, creates a pending plan request.
- Triggers async platform-managed Backup Storage provisioning.
- Returns Workspace with `storage_status: provisioning`.

Storage provisioning retry rules:

- Workspace Owner can retry during onboarding.
- Workspace Owner/Workspace Admin can retry after onboarding.

## Plans

Workspace routes:

- `GET /v1/workspaces/:workspaceId/plan`
- `POST /v1/workspaces/:workspaceId/plan-requests`
- `GET /v1/workspaces/:workspaceId/plan-requests`
- `POST /v1/workspaces/:workspaceId/plan-requests/:requestId/cancel`

System Admin routes:

- `GET /v1/admin/plan-requests`
- `POST /v1/admin/plan-requests/:requestId/approve`
- `POST /v1/admin/plan-requests/:requestId/reject`

Rules:

- Basic is self-serve.
- Pro and Agency are request-access plans.
- Only one pending plan request per Workspace.

## Projects

Routes:

- `GET /v1/workspaces/:workspaceId/projects`
- `POST /v1/workspaces/:workspaceId/projects`
- `GET /v1/workspaces/:workspaceId/projects/:projectId`
- `PATCH /v1/workspaces/:workspaceId/projects/:projectId`
- `DELETE /v1/workspaces/:workspaceId/projects/:projectId`

Rules:

- No Project restore route in v1.

## Database Sources

Routes:

- `GET /v1/workspaces/:workspaceId/database-sources`
- `POST /v1/workspaces/:workspaceId/projects/:projectId/database-sources`
- `GET /v1/workspaces/:workspaceId/database-sources/:sourceId`
- `PATCH /v1/workspaces/:workspaceId/database-sources/:sourceId`
- `DELETE /v1/workspaces/:workspaceId/database-sources/:sourceId`
- `POST /v1/workspaces/:workspaceId/database-sources/test-connection` — test unsaved wizard payload
- `POST /v1/workspaces/:workspaceId/database-sources/:sourceId/test-connection`
- `POST /v1/workspaces/:workspaceId/database-sources/:sourceId/enable`
- `POST /v1/workspaces/:workspaceId/database-sources/:sourceId/disable`
- `POST /v1/workspaces/:workspaceId/database-sources/:sourceId/move`

Rules:

- Unsaved wizard test uses in-memory credentials.
- Saved source test uses stored encrypted credentials.
- Test includes connectivity and minimal dump capability check.

## Backup Jobs

Routes:

- `GET /v1/workspaces/:workspaceId/backup-jobs`
- `POST /v1/workspaces/:workspaceId/database-sources/:sourceId/backup-jobs` — manual run
- `GET /v1/workspaces/:workspaceId/backup-jobs/:jobId`
- `POST /v1/workspaces/:workspaceId/backup-jobs/:jobId/cancel`
- `GET /v1/workspaces/:workspaceId/backup-jobs/:jobId/events` — SSE live progress

Rules:

- One active Backup Job per Database Source.
- Manual run only in v1; no scheduled Backup route or scheduler surface.

## Backups

Routes:

- `GET /v1/workspaces/:workspaceId/backups`
- `GET /v1/workspaces/:workspaceId/backups/:backupId`
- `POST /v1/workspaces/:workspaceId/backups/:backupId/download-requests`
- `GET /v1/downloads/:downloadToken` — stream decrypted file
- `DELETE /v1/workspaces/:workspaceId/backups/:backupId`

Rules:

- Download request performs permission check and audit logging.
- Download token expires after 15 minutes.
- Download token requires same authenticated user session.
- `GET /v1/downloads/:downloadToken` is not Workspace-scoped because token carries download authorization, but session is still required.

## Invites

Workspace routes:

- `GET /v1/workspaces/:workspaceId/invites`
- `POST /v1/workspaces/:workspaceId/invites`
- `POST /v1/workspaces/:workspaceId/invites/:inviteId/revoke`

Public/authenticated routes:

- `GET /v1/invites/:token` — public limited preview
- `POST /v1/invites/:token/accept`

Rules:

- Public invite preview returns Workspace name and role only.
- Accept requires OAuth-authenticated User.
- Accept requires explicit confirmation.

## Workspace Members and ownership

Routes:

- `GET /v1/workspaces/:workspaceId/members`
- `PATCH /v1/workspaces/:workspaceId/members/:memberId/role`
- `DELETE /v1/workspaces/:workspaceId/members/:memberId`
- `POST /v1/workspaces/:workspaceId/ownership-transfer`

Rules:

- Workspace Owner can invite Workspace Admins and Workspace Members.
- Workspace Admin can invite Workspace Members only.
- Only Workspace Owner can promote/demote Workspace Admins.
- Workspace Owner can transfer ownership to Workspace Admin only.
- Previous Workspace Owner becomes Workspace Admin after transfer.

## Backup Storage

Rules:

- Backup Storage is platform-managed in v1.
- No customer-facing BYOS create/test/activate/retire routes exist in v1.

## Notifications

Rules:

- No customer-facing notification or webhook routes exist in v1.

## Audit Logs

Routes:

- `GET /v1/workspaces/:workspaceId/audit-log`
- `GET /v1/admin/audit-log` — System Admin platform actions

Rules:

- Workspace Audit Log records security and data access events.
- System Admin Audit Log records platform-level admin actions.
