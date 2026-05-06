# Context

## Glossary

### Workspace

A Workspace is an organization-level tenant in the SaaS. It groups users, projects, database connections, backups, access control, billing, and timezone for one team, company, agency, or owner.

### Project

A Project is a website, app, or client asset inside a Workspace. A Project groups related Database Sources for backup management.

### Backup

A Backup is an app-encrypted logical database dump created from a Database Source. The backup pipeline is dump, optionally compress, encrypt, then store. In v1, the product creates, stores, lists, and downloads Backups, but does not restore them into a database. MySQL Backups download as `.sql.gz`; PostgreSQL Backups download as custom-format `.dump` or `.dump.gz` files.

### Backup Encryption Key

A Backup Encryption Key is a unique key used to encrypt one Backup file. Each Backup Encryption Key is wrapped by its Workspace Encryption Key.

### Workspace Encryption Key

A Workspace Encryption Key protects Backup Encryption Keys for one Workspace. In v1, Workspace Encryption Keys are app-managed and wrapped by an App Master Key.

### App Master Key

An App Master Key protects Workspace Encryption Keys. v1 supports an environment-provided App Master Key while keeping the design open for KMS-backed keys later.

### Backup Storage

Backup Storage is the Workspace-level destination where Backup files are retained. v1 Backup Storage Providers are AWS S3, Cloudflare R2, MinIO, and Local Disk. Local Disk Backup Storage is available for self-hosted deployments only. All Backups in a Workspace use the Workspace's Backup Storage.

### Database Source

A Database Source is one specific database that a Project backs up. It includes enough connection information to create Backups for that database.

### Connectivity Agent

A Connectivity Agent is a future component installed near private Database Sources so Backups can be created without exposing those databases directly to the hosted SaaS worker.

### Database Engine Adapter

A Database Engine Adapter defines how Backups are created for one database engine family.

### Supported Engine

A Supported Engine is a database engine family that the product can back up. For v1, Supported Engines are MySQL-family databases and PostgreSQL-family databases.

### Backup Job

A Backup Job is a manual or scheduled request to create a Backup from a Database Source.

### Retention Period

A Retention Period is the amount of time Backup files for a Database Source are kept in Backup Storage before they are eligible for deletion. v1 Retention Periods are set per Database Source and range from 7 to 30 days, bounded by the Workspace Plan.

### Schedule

A Schedule defines how often a Database Source should be backed up automatically. In v1, a Schedule is set per Database Source, uses preset daily frequencies from 1 to 5 Backups per day, is bounded by the Workspace Plan, and follows the Workspace timezone.

### Workspace Role

A Workspace Role defines a user's permissions within a Workspace. v1 Workspace Roles are Workspace Owner, Workspace Admin, and Workspace Member. Each Workspace has exactly one Workspace Owner and can have multiple Workspace Admins and Workspace Members. Ownership can be transferred, but a Workspace must always have one Workspace Owner.

### Database Credential

A Database Credential is the secret connection information needed to create Backups from a Database Source. Database Credentials are stored encrypted at rest so scheduled Backup Jobs can run without a user present. Stored secrets are masked and can be replaced, but no human role, including System Admin, can fully reveal them after save.

### Workspace Plan

A Workspace Plan defines the usage limits for a Workspace. v1 limits include Database Source count, retained storage size, Retention Period, Schedule frequency, and Workspace member count.

### Backup Notification

A Backup Notification informs a Workspace about important backup-related events. In v1, Backup Notifications are sent by email and webhook for failed Backups, recovery after failure, and storage nearing the Workspace Plan limit.

### Audit Log

An Audit Log records security and data access events within a Workspace. v1 events include login, member invite/removal, role change, Database Credential create/update, Backup Storage change, Backup download/delete, and Database Source create/update/delete.

### User Account

A User Account represents a person who can sign in to the SaaS and belong to one or more Workspaces. v1 sign-in uses Google and GitHub OAuth only; email/password sign-in is not supported.

### New Tenant Onboarding

New Tenant Onboarding is the workflow where a signed-in User Account creates a Workspace, chooses a Workspace Plan, becomes the sole Workspace Owner, configures the first Project and Database Source, runs the first Backup, and then invites team members. The canonical workflow is documented in `docs/workflows/new-tenant-onboarding.md`.

### Backup Status

A Backup Status describes the lifecycle state of a Backup. v1 statuses are Queued, Running, Succeeded, Failed, Cancelled, Deleted, and Expired.

### Data Model

The product data model uses Postgres tables for User Accounts, OAuth accounts, Workspaces, Workspace members, plans, plan requests, Backup Storage configs, Projects, Database Sources, Backup Jobs, Backups, and Backup encryption keys. The canonical data model is documented in `docs/design/data-model.md`.

