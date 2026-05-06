# Permission matrix

## Role names

System roles:

- System Owner
- System Admin

Workspace roles:

- Workspace Owner
- Workspace Admin
- Workspace Member

A Workspace has exactly one Workspace Owner and can have multiple Workspace Admins and Workspace Members.

## Workspace Member

Workspace Member can:

- view Workspace dashboard
- view Projects
- view Database Sources
- view Backups
- view Backup Jobs
- view high-level Backup Job logs
- create Database Sources
- update Database Sources
- move Database Sources between Projects
- replace Database Credentials
- test Database Source connections
- run manual Backup Jobs
- cancel Backup Jobs
- download Backups

Workspace Member cannot:

- delete Backups
- delete Projects
- delete Database Sources
- manage Backup Storage
- manage notification settings (out of scope in v1)
- create invite links
- remove Workspace members
- change Workspace member roles
- request or change Workspace Plan
- change Workspace name, slug, or timezone
- delete or restore Workspace

## Workspace Admin

Workspace Admin can do everything Workspace Member can, plus:

- create Projects
- update Projects
- delete Projects
- disable Database Sources
- delete Database Sources
- manually delete Backups
- manage Backup Storage configuration (platform-managed only in v1; no BYOS/customer-managed credentials)
- configure notification email recipients (out of scope in v1)
- configure webhook endpoint (out of scope in v1)
- rotate webhook secret (out of scope in v1)
- invite Workspace Members
- remove Workspace Members
- retry Backup Storage provisioning after onboarding

Workspace Admin cannot:

- invite Workspace Admins
- promote Workspace Members to Workspace Admin
- demote Workspace Admins
- remove Workspace Admins
- transfer Workspace ownership
- request or change Workspace Plan
- change Workspace slug
- delete or restore Workspace

## Workspace Owner

Workspace Owner can do everything Workspace Admin can, plus:

- request or change Workspace Plan
- change Workspace name, slug, and timezone
- invite Workspace Admins and Workspace Members
- promote Workspace Members to Workspace Admin
- demote Workspace Admins to Workspace Member
- remove Workspace Admins
- transfer ownership to a Workspace Admin
- delete Workspace
- restore Workspace during the 7-day deletion grace period

Rules:

- A Workspace has exactly one Workspace Owner.
- Ownership can be transferred only to a Workspace Admin.
- After ownership transfer, the previous Workspace Owner becomes a Workspace Admin.
- A Workspace must always have one Workspace Owner.

## System Admin

System Admin can:

- access internal admin dashboard
- review plan requests
- approve plan requests
- reject plan requests
- assign or change Workspace Plans
- create Workspace limit overrides with reason and optional expiry
- view Workspace metadata, status, and health
- view Workspace Audit Logs
- view System Admin Audit Logs
- trigger Backup Storage provisioning retry
- impersonate a Workspace user with reason, audit logging, and visible banner

System Admin cannot:

- fully reveal Database Credentials
- fully reveal BYOS Backup Storage credentials (out of scope in v1)
- download customer Backups outside impersonation
- download customer Backups during impersonation
- change secrets during impersonation

## System Owner

System Owner can:

- manage System Admin access
- manage platform-level settings
- perform System Admin actions

System Owner cannot:

- fully reveal Database Credentials
- fully reveal BYOS Backup Storage credentials (out of scope in v1)
- download customer Backups outside impersonation
- download customer Backups during impersonation
- bypass customer data-access restrictions

## Sensitive operations

### Backup download

Allowed:

- Workspace Owner
- Workspace Admin
- Workspace Member

Not allowed:

- System Admin
- System Owner
- impersonated sessions

### Backup deletion

Allowed:

- Workspace Owner
- Workspace Admin

Not allowed:

- Workspace Member
- System Admin directly
- System Owner directly

### Database Credential reveal

No human role can fully reveal saved Database Credentials after save.

Allowed operation:

- replace credential

Not allowed operation:

- reveal full saved secret

### BYOS credential reveal

BYOS / customer-managed Backup Storage credentials are out of scope in v1.
No human role can fully reveal saved BYOS Backup Storage credentials after save.

Allowed operation:

- replace credential

Not allowed operation:

- reveal full saved secret

### Impersonation

Allowed:

- System Admin
- System Owner

Requirements:

- reason required
- audit log required
- visible impersonation banner required

Blocked during impersonation:

- Backup download
- secret changes
- full secret reveal

## Invite rules

Workspace Owner can:

- invite Workspace Admins
- invite Workspace Members

Workspace Admin can:

- invite Workspace Members only

Workspace Member cannot:

- invite users

Invite links:

- single-use
- expire after 7 days
- embed invited role
- store only token hash
