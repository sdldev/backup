# 0003. Use a streamed backup pipeline

## Status

Accepted

## Context

Backup Jobs can produce large database dumps. Writing full dumps to worker local disk before upload would require worker disks large enough for the biggest customer backup and would leave sensitive temporary files on disk. The product also has hard Workspace Plan storage limits and must clean up failed or cancelled backups.

The backup pipeline must support MySQL and PostgreSQL logical dumps, app-level encryption, storage uploads, cancellation, checksums, and retained-storage accounting.

## Decision

Use a streamed backup pipeline for v1:

1. Run the engine dump tool from the worker container.
2. Stream dump output through compression when needed.
3. Stream through AES-256-GCM encryption.
4. Stream upload to the configured Backup Storage.
5. Count encrypted bytes during upload and abort if the Workspace exceeds remaining plan storage.
6. Delete partial local temp data and partial storage objects on failure or cancellation.

MySQL Backups download as `.sql.gz`. PostgreSQL Backups use `pg_dump -Fc` built-in compression and download as `.dump`.

## Consequences

- Worker disk is not a bottleneck for large Backups.
- Sensitive full backup files are not written to local temp disk.
- Backup Jobs can fail fast when plan storage limits are exceeded.
- Cancellation and cleanup must be carefully implemented.
- Final stored size is known only while streaming, not before the Backup starts.
- The implementation is more complex than writing a temp file and uploading it after completion.
