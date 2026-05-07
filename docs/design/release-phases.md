# Release phases

## First release

First release is a manual-backup SaaS beta for agencies.

Included:

- Google and GitHub OAuth sign-in only
- HTTP-only secure sessions stored in Postgres
- Astro web app with `output: 'server'` mode (per-page `prerender` for static pages)
- ElysiaJS API on Bun
- Bun worker process
- Postgres application database via Drizzle
- System Owner and System Admin roles
- Workspace Owner, Workspace Admin, and Workspace Member roles
- exactly one Workspace Owner per Workspace
- Workspace creation and onboarding
- Basic, Pro, and Agency plans
- Pro/Agency request access flow
- System Admin approval for plan requests
- Workspace-specific limit overrides
- minimal System Admin dashboard
- System Admin impersonation with reason, audit, visible banner, no Backup download, and no secret changes
- platform-managed Backup Storage only
- deployment-configured S3-compatible platform storage provider
- automatic Backup Storage provisioning after Workspace creation
- Project creation
- Database Source creation wizard
- MySQL/MariaDB Backup support
- PostgreSQL Backup support
- direct hosted SaaS worker connectivity with fixed outbound IPs
- connection test and minimal dump capability check
- optional database size estimate
- manual Backup Jobs
- one active Backup Job per Database Source
- retry policy for Backup Jobs
- best-effort cancellation
- streaming backup pipeline
- chunked AES-256-GCM app-level encryption
- Backup checksum/integrity diagnostics
- decrypted Backup downloads
- manual Backup deletion by Workspace Owner/Workspace Admin
- automatic retention deletion
- audit log
- invite links and team management
- manual backup health dashboard with last backup status, storage usage, and setup checklist
- basic restore documentation and per-Backup restore instructions

Excluded:

- scheduled backups
- Schedule UI
- email notifications
- webhooks
- BYOS Backup Storage
- SSH tunnels
- Connectivity Agent
- public customer API
- CLI
- app-level MFA/TOTP
- billing provider integration
- formal compliance claims
- restore execution inside the app

## Phase 2

Phase 2 adds scheduled backup protection.

Included:

- Schedule UI
- per-Database Source schedule settings
- preset daily frequency bounded by Workspace Plan
- preferred first run time, default `02:00` Workspace timezone
- evenly distributed additional daily runs
- scheduler worker
- scheduled Backup Jobs
- missed schedule detection
- scheduled backup health model
- email notifications for failed backups, recovered backups, and storage near limit
- configurable notification recipients per Workspace

Excluded:

- webhooks
- BYOS Backup Storage unless pulled forward
- Connectivity Agent

## Later phases

Potential later phases:

- webhook notifications with HMAC signing
- BYOS Backup Storage for AWS S3, Cloudflare R2, and MinIO
- Connectivity Agent for private Database Sources
- SSH tunnel alternative if still needed
- public customer API
- CLI
- app-managed restore execution
- KMS-backed App Master Key
- customer-facing key rotation
- billing provider integration
- Workspace region choice/data residency
- formal compliance program
