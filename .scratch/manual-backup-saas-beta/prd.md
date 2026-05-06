Status: needs-triage
Type: PRD
Title: First-release manual backup SaaS beta for agencies

## Problem Statement

Website agencies, DevOps teams, and website owners need reliable database Backups without building custom scripts for every client site. Agencies often manage many client websites and databases, but backup routines are scattered across hosting panels, shell scripts, cloud consoles, and manual exports. This makes it hard to prove that a database is protected, hard to retrieve the latest usable Backup during an incident, and risky to share operational access across a team.

For the first release, the product should let a new User Account sign in with Google or GitHub, create a Workspace, add a Project, configure a Database Source, run a manual Backup, store it securely in platform-managed Backup Storage, download it when needed, and invite team members with clear Workspace Roles.

The system must protect sensitive Database Credentials and Backup files from accidental exposure. It must enforce Workspace isolation, support exactly one Workspace Owner per Workspace, provide auditability for sensitive actions, and keep the first beta release focused by excluding scheduled backups, webhooks, BYOS storage, billing provider integration, app-managed restore execution, and public customer APIs.

## Solution

Build the first-release manual backup SaaS beta for agencies.

From the user's perspective:

- A user signs in with Google or GitHub OAuth.
- A user creates a Workspace, chooses a Workspace Plan, and becomes the sole Workspace Owner.
- Platform-managed Backup Storage is provisioned automatically.
- The Workspace Owner creates a Project for a website, app, or client asset.
- The Workspace Owner adds a Database Source for MySQL/MariaDB or PostgreSQL.
- The app validates connectivity and minimal dump capability before enabling the Database Source.
- The user runs a manual Backup from the Database Source.
- The app streams the database dump through compression when applicable, encrypts it with chunked AES-256-GCM, uploads it to Backup Storage, records integrity metadata, and displays live Backup Job progress.
- Authorized Workspace users can download decrypted Backup files in engine-appropriate formats.
- Workspace Owner and Workspace Admin can delete Backups manually; retention deletion also removes expired Backups automatically.
- The Workspace audit log records sensitive actions.
- The Workspace Owner can invite Workspace Admins and Workspace Members through single-use invite links.
- System Admins can manage plan requests, Workspace limits, and support operations without gaining access to customer Backup downloads or full saved secrets.

The first release is manual-backup only. Scheduled backups, email notifications, webhooks, BYOS Backup Storage, Connectivity Agent, billing integration, and app-managed restore execution are later phases.

## User Stories

1. As a new user, I want to sign in with Google OAuth, so that I can access the SaaS without creating a password.
2. As a new user, I want to sign in with GitHub OAuth, so that I can use my developer identity.
3. As a new user, I want the app to reject OAuth accounts without a verified email, so that account identity is trustworthy.
4. As a returning user, I want the app to remember my session in a secure HTTP-only cookie, so that I do not need to sign in repeatedly.
5. As a user with one Workspace, I want to land directly in that Workspace after login, so that I can continue working quickly.
6. As a user with multiple Workspaces, I want to return to my last active Workspace, so that I can resume my previous task.
7. As a user without a Workspace, I want to see a Workspace launcher, so that I can create my first Workspace.
8. As a new user, I want to create one Workspace by default, so that I can start using the product without manual approval.
9. As a new user, I want to enter a Workspace name, slug, and timezone, so that the Workspace has clear identity and scheduling context.
10. As a Workspace Owner, I want the Workspace slug to be editable before creation, so that the Workspace URL is clean.
11. As a Workspace Owner, I want to change the Workspace slug later, so that I can fix naming mistakes.
12. As a Workspace Owner, I want the timezone to default from my browser, so that setup is faster.
13. As a Workspace Owner, I want Basic to be self-serve, so that I can start immediately.
14. As a Workspace Owner, I want to request Pro or Agency access, so that I can ask for higher limits when needed.
15. As a Workspace Owner, I want a Pro or Agency request to still create my Workspace on Basic, so that I can continue onboarding while waiting for approval.
16. As a Workspace Owner, I want to see a pending plan request banner, so that I know my request is being reviewed.
17. As a System Admin, I want to receive plan requests in an admin dashboard, so that I can review beta access.
18. As a System Admin, I want plan request email notifications, so that requests are not missed.
19. As a System Admin, I want to approve plan requests, so that qualified Workspaces can use larger limits.
20. As a System Admin, I want to reject plan requests with a note, so that the requester gets a clear outcome.
21. As a System Admin, I want to create Workspace-specific limit overrides with a reason and optional expiry, so that beta exceptions are controlled.
22. As a System Owner, I want to manage System Admin access, so that platform operations stay controlled.
23. As a Workspace Owner, I want Backup Storage to be provisioned automatically, so that I do not need to configure object storage before creating my first Backup.
24. As a Workspace Owner, I want provisioning status to be visible, so that I know whether backups can run.
25. As a Workspace Owner, I want to retry failed Backup Storage provisioning, so that transient platform failures can be recovered.
26. As a Workspace Owner, I want onboarding to continue while storage is provisioning, so that I can create Projects and Database Sources without waiting.
27. As a Workspace Owner, I want Backup Jobs blocked until Backup Storage is ready, so that no Backup starts without a destination.
28. As a Workspace Owner, I want to create a Project with a name and optional website URL, so that client assets are organized.
29. As a Workspace user, I want Projects to group Database Sources, so that related databases are easier to manage.
30. As a Workspace Owner, I want no default Project to be auto-created, so that Project names stay meaningful.
31. As a Workspace user, I want to add a Database Source through a step-by-step wizard, so that connection setup is not overwhelming.
32. As a Workspace user, I want to choose MySQL/MariaDB as a Supported Engine, so that I can back up common website databases.
33. As a Workspace user, I want to choose PostgreSQL as a Supported Engine, so that I can back up PostgreSQL applications.
34. As a Workspace user, I want to enter structured connection fields, so that credentials and SSL settings are clear and validated.
35. As a Workspace user, I want hosted SaaS connections to default to TLS, so that database connections are safer.
36. As a Workspace user, I want SSL settings in an advanced section, so that the default form remains simple.
37. As a Workspace user, I want the Database Source to have a display name separate from the technical database name, so that UI and notifications can avoid leaking internal names.
38. As a Workspace user, I want to test an unsaved Database Source using in-memory credentials, so that I can validate a connection before saving secrets.
39. As a Workspace user, I want the connection test to verify minimal dump capability, so that the first Backup is less likely to fail due to missing permissions.
40. As a Workspace user, I want the test result to show server version, database existence, TLS status, permission status, and sanitized errors, so that I can fix setup problems.
41. As a Workspace user, I want an optional database size estimate, so that I can understand whether a Backup may exceed storage limits.
42. As a Workspace user, I want size estimates to warn but not block, so that rough estimates do not prevent valid Backups.
43. As a Workspace user, I want to save a disabled draft when connection testing fails, so that I can finish configuration after firewall or DNS changes.
44. As a Workspace user, I want enabling a Database Source to require a successful test, so that active sources are known to be reachable.
45. As a Workspace user, I want saved Database Credentials to be masked and replace-only, so that no human can reveal the full saved secret.
46. As a Workspace user, I want replacing Database Credentials to pause readiness until a new test succeeds, so that typoed credentials do not cause repeated failed jobs.
47. As a Workspace Member, I want to create and update Database Sources, so that I can help operate backups for the agency.
48. As a Workspace Member, I want to test Database Sources, so that I can verify operational access.
49. As a Workspace Member, I want to run manual Backup Jobs, so that I can create a Backup before risky maintenance.
50. As a Workspace Member, I want to cancel a running Backup Job, so that I can stop accidental load during traffic spikes.
51. As a Workspace Member, I want to download Backups, so that I can help recover data during an incident.
52. As a Workspace Admin, I want to delete Projects and Database Sources, so that I can manage Workspace organization.
53. As a Workspace Admin, I want Project and Database Source deletion to be soft where applicable, so that recovery history is not unexpectedly destroyed.
54. As a Workspace Admin, I want to manually delete Backups, so that sensitive or unwanted Backups can be removed before retention expiry.
55. As a Workspace Member, I want to be prevented from deleting Backups, so that recovery points are protected from accidental deletion.
56. As a Workspace Owner, I want to transfer ownership to a Workspace Admin, so that responsibility can move without leaving the Workspace ownerless.
57. As a Workspace Owner, I want the previous Workspace Owner to become a Workspace Admin after transfer, so that they retain access but not ultimate control.
58. As a Workspace Owner, I want exactly one Workspace Owner at all times, so that authority is unambiguous.
59. As a Workspace Owner, I want to invite Workspace Admins and Workspace Members, so that I can build my team.
60. As a Workspace Admin, I want to invite Workspace Members only, so that I can add operators without expanding admin privileges.
61. As an invitee, I want an invite link to show a limited preview before login, so that I know which Workspace and role I am joining.
62. As an invitee, I want to sign in before accepting an invite, so that the Workspace joins the correct User Account.
63. As an invitee, I want to explicitly accept the invite after login, so that I do not join with the wrong account accidentally.
64. As a Workspace Owner, I want invite links to be single-use and expire after 7 days, so that leaked links have limited risk.
65. As a Workspace Owner, I want invite tokens stored only as hashes, so that database leaks do not expose usable invite links.
66. As a Workspace user, I want to run a manual Backup from a Database Source, so that I can create a recovery point on demand.
67. As a Workspace user, I want the first Backup to require an explicit click, so that the app does not unexpectedly load production databases.
68. As a Workspace user, I want a Backup Job detail page with live progress, so that I know what is happening during a long Backup.
69. As a Workspace user, I want progress updates over SSE, so that the UI updates without manual refresh.
70. As a Workspace user, I want high-level Backup Job stages only, so that useful progress is shown without exposing raw command output.
71. As a Workspace user, I want sanitized failure messages, so that I can act without exposing secrets in the UI.
72. As a Workspace user, I want internal error references, so that support can diagnose issues without raw errors being shown to every user.
73. As a Workspace user, I want only one active Backup Job per Database Source, so that concurrent dumps do not overload the source database.
74. As a Workspace user, I want Backup Jobs to retry transient failures three times with exponential backoff, so that temporary network problems can recover.
75. As a Workspace user, I want failed and cancelled Backup Jobs to clean partial files, so that unusable sensitive artifacts do not remain.
76. As a Workspace user, I want MySQL/MariaDB Backups to include routines, triggers, and events, so that logical behavior is preserved.
77. As a Workspace user, I want MySQL/MariaDB Backups to use transaction-consistent options where supported, so that production writes do not corrupt the dump.
78. As a Workspace user, I want PostgreSQL Backups to use custom `pg_dump` format, so that PostgreSQL restores can use `pg_restore` flexibility.
79. As a Workspace user, I want PostgreSQL Backups to cover the entire database in v1, so that scope is simple and predictable.
80. As a Workspace user, I want Backups streamed instead of written as full temp files, so that large databases do not require huge worker disks.
81. As a Workspace user, I want Backups encrypted before storage, so that leaked storage objects are not readable dumps.
82. As a Workspace user, I want each Backup to have its own Backup Encryption Key, so that key compromise blast radius is limited.
83. As a Workspace user, I want Backup Encryption Keys wrapped by a Workspace Encryption Key, so that Workspace isolation is preserved.
84. As a platform operator, I want Workspace Encryption Keys wrapped by an App Master Key, so that key management is centralized for v1.
85. As a platform operator, I want the App Master Key to support an environment-provided v1 source and future KMS support, so that deployment is simple now and can harden later.
86. As a Workspace user, I want chunked AES-256-GCM encryption, so that very large streamed Backups can be encrypted without buffering whole files.
87. As a Workspace user, I want the Backup object header authenticated, so that encryption metadata cannot be tampered with silently.
88. As a Workspace user, I want the Backup object format versioned, so that future formats can be supported safely.
89. As a Workspace user, I want encrypted object checksums recorded, so that storage integrity can be diagnosed.
90. As a Workspace user, I want AEAD verification during decrypt, so that corrupted or tampered Backups fail safely.
91. As a Workspace user, I want Backup Storage object keys to be opaque, so that bucket logs do not leak Project or Database Source names.
92. As a Workspace user, I want Backup download filenames to include Project, Source, and UTC timestamp, so that downloaded files are understandable.
93. As a Workspace user, I want MySQL/MariaDB Backups to download as `.sql.gz`, so that they are easy to restore manually.
94. As a Workspace user, I want PostgreSQL Backups to download as `.dump`, so that they work with `pg_restore`.
95. As a Workspace user, I want a 15-minute download request token, so that downloads are authorized without long-lived links.
96. As a Workspace user, I want download tokens bound to my current session, so that leaked tokens alone cannot retrieve data.
97. As a Workspace user, I want System Admins and System Owners blocked from downloading customer Backups, so that platform support cannot exfiltrate data.
98. As a Workspace user, I want impersonated sessions blocked from Backup downloads and secret changes, so that support tooling cannot bypass data boundaries.
99. As a Workspace user, I want retained storage calculated from active stored Backup files, so that limits reflect real storage use.
100. As a Workspace user, I want new Backup Jobs blocked when retained storage is at the plan limit, so that plan limits are predictable.
101. As a Workspace user, I want streaming upload to abort if the Backup exceeds remaining storage, so that hard storage limits are enforced.
102. As a Workspace user, I want partial objects deleted after storage-limit failure, so that failed Backups do not consume storage.
103. As a Workspace user, I want Retention Periods to be bounded by Workspace Plan, so that plan limits control cost and risk.
104. As a Workspace user, I want automatic retention deletion in the first release, so that Backups expire as promised.
105. As a Workspace user, I want Backup metadata retained for one year after deletion or expiry, so that history remains available for support and audit.
106. As a Workspace user, I want an Audit Log, so that I can see who changed credentials, storage, members, Database Sources, and Backups.
107. As a Workspace user, I want Backup downloads and deletions audited, so that sensitive data access is traceable.
108. As a Workspace user, I want login and member changes audited, so that access history is clear.
109. As a Workspace user, I want credential updates audited without revealing secrets, so that changes are traceable but safe.
110. As a Workspace Owner, I want to soft-delete a Workspace first, so that accidental Workspace deletion can be reversed.
111. As a Workspace Owner, I want a 7-day deletion grace period, so that I can restore a mistakenly deleted Workspace.
112. As a Workspace Owner, I want Backups purged after the Workspace deletion grace period, so that deleted Workspace data is eventually removed.
113. As a Workspace user, I want a dashboard health overview for manual backups, so that I can see last backup status, storage usage, and setup progress.
114. As a Workspace user, I want a setup checklist, so that I know what remains before the Workspace is useful.
115. As a Workspace user, I want onboarding to be skippable, so that I am not trapped in a wizard.
116. As a Workspace user, I want first Backup success to show filename, stored size, duration, next actions, and download, so that I can trust the Backup exists.
117. As a Workspace user, I want first Backup failure to show retry and edit actions, so that I can recover quickly.
118. As a Workspace user, I want restore documentation, so that I can use downloaded Backups manually.
119. As a Workspace user, I want per-Backup restore instructions, so that I know which command style applies to the Backup format.
120. As a Workspace user, I want strong production restore warnings, so that I avoid overwriting the wrong database.
121. As a System Admin, I want a minimal admin dashboard, so that I can operate the beta without direct database edits.
122. As a System Admin, I want impersonation with a reason, audit log, and visible banner, so that I can support users transparently.
123. As a System Admin, I want impersonation to block Backup download and secret changes, so that support does not become a data exfiltration path.
124. As a System Owner, I want to manage System Admins, so that platform privileges are controlled.
125. As a platform operator, I want rate limiting for auth, Backup actions, and download token creation, so that abuse is reduced.
126. As a platform operator, I want fixed outbound worker IPs for hosted SaaS, so that customers can allowlist database access safely.
127. As a platform operator, I want no SSH tunnel or Connectivity Agent in first release, so that private-network complexity is deferred.
128. As a platform operator, I want no billing provider in first release, so that beta access can be managed manually.
129. As a platform operator, I want no formal compliance claims in first release, so that legal/product commitments stay realistic.
130. As a platform operator, I want no public customer API or CLI in first release, so that security surface stays small.

## Implementation Decisions

- Build a monorepo with separate web, API, worker, and shared packages.
- Use Astro hybrid for the web app: static marketing pages and SSR protected dashboard pages.
- Use ElysiaJS on Bun for the API service.
- Use Bun for the worker process.
- Use Postgres as the application database for hosted and self-hosted v1 deployments.
- Use Drizzle with the Postgres dialect.
- Respect ADR 0001: Postgres is the hosted application database instead of SQLite.
- Respect ADR 0002: Backups use envelope encryption.
- Respect ADR 0003: Backups use a streamed pipeline.
- API owns OAuth callbacks, session creation, and session validation.
- Web SSR forwards cookies to the API session endpoint for auth checks.
- Use Google and GitHub OAuth only; email/password is out of scope.
- Require verified email from OAuth providers.
- Store sessions in Postgres and set HTTP-only secure session cookies.
- Use Workspace as the tenant boundary.
- Use System Owner/System Admin for platform roles and Workspace Owner/Workspace Admin/Workspace Member for Workspace roles.
- Enforce exactly one Workspace Owner per Workspace.
- Allow a signed-in user to create one Workspace by default; additional Workspaces require System Admin approval.
- Create Workspaces on Basic by default; Pro and Agency are request-access plans.
- Auto-provision platform-managed Backup Storage asynchronously after Workspace creation.
- Use platform-managed storage only in the first release; BYOS storage is later.
- Store platform-managed storage with provider/prefix metadata and no per-Workspace storage credentials.
- Build deep modules around stable interfaces:
  - Identity and session module for OAuth, verified email identity linking, and session lifecycle.
  - Workspace access module for membership lookup, role checks, exactly-one-owner enforcement, and API tenant authorization.
  - Plan limits module for plan lookup, limit override resolution, manual Backup rate limits, storage limit checks, and request-access state.
  - Storage provisioning module for platform-managed Backup Storage config creation, retry, status transitions, and opaque prefixes.
  - Secret vault module for Database Credentials and future BYOS credentials, with encrypt, replace, fingerprint, and no-reveal semantics.
  - Database Engine Adapter module for MySQL/MariaDB and PostgreSQL connection tests, dump capability checks, size estimates, and dump command construction.
  - Backup pipeline module for streaming dump, compression, chunked encryption, upload, byte counting, checksum, abort, cleanup, and artifact metadata.
  - Encryption envelope module for Backup data keys, Workspace keys, App Master Key wrapping, chunk headers, and AEAD verification.
  - Download authorization module for creating session-bound 15-minute download requests and streaming decrypted Backup files.
  - Audit module for recording security and data access events through a simple append-only interface.
  - Invite module for token creation, token hashing, preview, acceptance, role embedding, expiry, revocation, and single-use enforcement.
  - Impersonation guard module for reason/audit/banner requirements and blocking Backup downloads and secret changes.
  - Retention module for finding expired Backups, deleting stored objects, marking Backups expired, and preserving metadata.
- Use workspace-scoped API routes with Workspace ID for tenant-owned resources.
- Use Workspace slug in web URLs.
- Enforce tenant isolation in app-layer checks for v1; no Postgres RLS in v1.
- Store `workspace_id` on tenant-owned rows even when derivable, and enforce consistency.
- Separate Backup Job execution records from Backup artifact records.
- Store Backup encryption key metadata in a separate table from Backup metadata.
- Use chunked AES-256-GCM encryption with authenticated object headers and object format versioning.
- Store chunk metadata in the encrypted Backup object header, not as database rows.
- Include `pg_dump` and `mysqldump` binaries in the worker container.
- Use `mysqldump --single-transaction --routines --triggers --events` style behavior for MySQL/MariaDB where supported.
- Use `pg_dump -Fc` built-in compression for PostgreSQL.
- Stream Backup output directly through the pipeline; do not write a full temporary Backup file to worker disk.
- Count encrypted bytes during upload and abort when remaining plan storage is exceeded.
- Store original dump size and encrypted stored size.
- Store encrypted object checksum for storage integrity diagnostics.
- Use AEAD verification for decrypt integrity.
- Generate opaque storage object keys.
- Generate user download filenames from Project, Source, UTC timestamp, and engine-specific extension.
- Use short-lived 15-minute download requests bound to the same authenticated session.
- Block System Admin and System Owner from customer Backup downloads and saved secret reveal.
- Include audit logging from first release.
- Include retention deletion from first release.
- Exclude Schedule UI from first release; manual Backup Jobs only.
- Exclude email notifications and webhooks from first release.
- Exclude app-managed restore execution; provide manual restore docs and per-Backup instructions.

## Testing Decisions

- Good tests should verify external behavior and security invariants, not internal implementation details.
- Deep modules should be tested through stable public interfaces with realistic inputs and observable outputs.
- Identity/session tests should cover OAuth verified email linking, rejection of unverified/private emails, provider account uniqueness, session creation, logout, and session lookup.
- Workspace access tests should cover exactly-one-owner enforcement, role permissions, tenant isolation checks, ownership transfer, and prevention of sole-owner removal.
- Plan limits tests should cover Basic/Pro/Agency limits, limit override precedence, manual Backup rate limits, retained storage calculations, and hard block behavior when storage is full.
- Storage provisioning tests should cover async provisioning success, failure, retry, opaque prefix generation, and blocking Backup Jobs until storage is ready.
- Secret vault tests should cover encryption at rest, fingerprint generation, replacement, masking, and no full reveal through public interfaces.
- Database Engine Adapter tests should cover MySQL/MariaDB and PostgreSQL connection-test result mapping, sanitized errors, dump command construction, permission-check outcomes, and size-estimate warnings.
- Backup pipeline tests should cover successful streaming pipeline behavior, encrypted byte counting, storage limit abort, partial object cleanup, cancellation cleanup, retry classification, checksum recording, and artifact metadata creation.
- Encryption envelope tests should cover per-Backup key generation, Workspace key wrapping, chunked AES-GCM encrypt/decrypt, authenticated header tamper detection, object format version handling, and decrypt failure on corrupted chunks.
- Download authorization tests should cover token expiry, same-session requirement, role permissions, System Admin/System Owner denial, impersonation denial, and audit event creation.
- Invite tests should cover token hashing, public limited preview, expiry, revocation, single-use acceptance, role embedding, and permission restrictions for invite creation.
- Audit tests should cover append-only event recording for login, source changes, credential changes, storage changes, Backup downloads/deletes, member changes, and impersonation.
- Retention tests should cover hard deletion at retention expiry, object deletion, metadata retention, and safe handling of missing objects.
- API contract tests should cover workspace-scoped authorization and prevent cross-Workspace access by ID swapping.
- Web onboarding tests should cover major user-visible flows: OAuth login redirect, Workspace creation, storage provisioning states, Project creation, Database Source wizard, first Backup progress, Backup download, invite acceptance, and permission-based UI actions.
- Worker integration tests should use test doubles for storage and database dump processes where possible, reserving full end-to-end dump tests for controlled fixtures.
- No prior code tests exist in the current repo because the repo currently contains documentation only. Test structure should be introduced with the implementation.

## Out of Scope

- Scheduled backups in the first release.
- Schedule UI in the first release.
- Email notifications in the first release.
- Webhook notifications in the first release.
- BYOS Backup Storage in the first release.
- SSH tunnels.
- Connectivity Agent.
- Public customer API.
- CLI.
- App-level MFA/TOTP.
- Billing provider integration.
- Formal compliance claims.
- App-managed restore execution.
- MongoDB, Redis, and other non-MySQL/PostgreSQL engines.
- PostgreSQL schema/table selection.
- Custom cron expressions.
- Multi-region data residency.
- Customer-facing key rotation.
- KMS-backed App Master Key.
- Workspace-specific local disk storage for hosted SaaS.
- Revealing saved Database Credentials or BYOS credentials to any human role.

## Further Notes

- The repo currently has documentation only and no implementation code.
- The product glossary is defined in `CONTEXT.md`.
- The canonical onboarding workflow is documented in the workflow documentation.
- The data model, API route design, web onboarding screens, permission matrix, release phases, and implementation order are documented in design documents.
- The first release is intentionally manual-backup only to reduce scope while proving the core backup, encryption, download, retention, audit, and team-management flows.
- Phase 2 should add Schedule UI, scheduler worker, scheduled Backup Jobs, scheduled health model, and email notifications.
- Later phases can add webhooks, BYOS storage, Connectivity Agent, public API, CLI, app-managed restore, billing provider integration, KMS-backed keys, customer-facing key rotation, and formal compliance work.
