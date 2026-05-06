# Rollback notes

## Order

1. Stop API/worker writes.
2. Take fresh Postgres backup.
3. If `0001_initial.sql` already applied in shared environment, restore whole database from pre-migration backup instead of hand-dropping selective objects.
4. If migration only touched disposable test database, drop schema `public` and recreate it, then re-run known-good migrations.

## Migration `0001_initial.sql`

- Scope: creates enum types, core tenant tables, backup metadata tables, audit tables, download tables, cleanup tables, indexes, and deferred owner-invariant trigger.
- Destructive rollback status: **manual rollback is destructive**. Removing this migration means dropping tables with tenant, audit, backup metadata, and token state.
- Irreversible data warning: rows in `backups`, `backup_encryption_keys`, `audit_logs`, `download_requests`, and `cleanup_records` can represent operational history that cannot be reconstructed from app state alone.
- Safe restore expectation: restore full Postgres backup taken before migration or rebuild disposable database from scratch.
- Risk note near destructive follow-ups: any future migration that drops or renames columns/tables tied to encrypted objects, audit history, or owner-invariant trigger must add inline SQL comments explaining restore path before execution.

## Validation after rollback or restore

1. Confirm expected schema version present.
2. Run `bun run db:migrate:test`.
3. Run `bun run db:seed:test`.
4. Run `bun test tests/integration/db`.
5. Verify seeded plans are exactly Basic/Pro/Agency and workspace owner invariant still enforced.
