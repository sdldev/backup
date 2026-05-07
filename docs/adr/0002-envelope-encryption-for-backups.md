# 0002. Use envelope encryption for backup files

## Status

Accepted

## Context

Backup files contain logical dumps of customer databases. They may include personal data, password hashes, application secrets, session data, and other sensitive records. Backups may be stored in platform-managed storage or Workspace-owned storage such as AWS S3, Cloudflare R2, or MinIO.

Relying only on storage-provider encryption is not enough because buckets and credentials can be misconfigured or leaked. At the same time, scheduled Backup Jobs and user downloads must work without requiring a user to enter a passphrase each time.

## Decision

Encrypt every Backup file at the application layer using AES-256-GCM.

Use envelope encryption:

- Each Backup has a unique Backup Encryption Key.
- Each Backup Encryption Key is wrapped by the Workspace Encryption Key.
- Each Workspace Encryption Key is app-managed and wrapped by the App Master Key.
- v1 supports an environment-provided App Master Key while keeping the design open for KMS-backed keys later.
- No human role, including System Admin, can fully reveal stored Database Credentials or BYOS storage credentials after save.

## Consequences

- A leaked storage object is ciphertext rather than a readable database dump.
- Key compromise blast radius is smaller than with one app-wide backup encryption key.
- The design supports future key rotation and KMS integration.
- Download and backup pipelines are more complex because the app must encrypt, decrypt, and manage wrapped keys.
- Losing the App Master Key can make Workspace keys and Backups unrecoverable, so operational key backup is critical.
