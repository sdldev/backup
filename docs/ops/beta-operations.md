# Beta operations runbook

This runbook covers operational controls for the manual-backup beta. It is not a compliance attestation.

Related docs:

- [OAuth App Setup](./oauth-app-setup.md)

## App Master Key handling

`APP_MASTER_KEY_V1` is the root application secret used to unwrap Workspace Encryption Keys. It must be stored in the production secret manager with restricted operator access, change history, and encrypted offline backup escrow.

Hard warning: if `APP_MASTER_KEY_V1` is lost and no verified backup copy exists, existing backup files are unrecoverable. The product cannot decrypt Workspace keys, Backup keys, or backup objects without this exact 32-byte base64url value.

Required storage practice:

1. Generate one unpadded base64url value that decodes to exactly 32 bytes.
2. Store it as `APP_MASTER_KEY_V1` in the app/worker secret manager.
3. Store an encrypted offline escrow copy with two-person access.
4. Record key version `1`, creation date, escrow location, and restore-test date in internal ops notes.
5. Never paste the raw value into tickets, logs, shell history, evidence files, or chat.

### Restore drill

Run this drill before beta launch and after any secret-manager migration:

1. In an isolated staging environment, create a Workspace, Database Source, and successful Backup.
2. Save only the encrypted backup object and database rows needed for Workspace/Backup key metadata.
3. Remove runtime access to `APP_MASTER_KEY_V1` and confirm decrypt/download fails safely.
4. Restore `APP_MASTER_KEY_V1` from the encrypted escrow copy into staging secret manager.
5. Restart the `app` process (unified API + Worker).
6. Download the staging Backup and verify checksum/content against the known fixture.
7. Record drill date, operator initials, backup id, and result. Do not record the key value.

## Fixed outbound IP deployment

For beta deployment on a single VPS, the `app` container (unified API + Worker) runs via Docker with the VPS's fixed outbound IP. Customers allowlist this IP for database access.

For post-beta scale-out with process split (`WORKER_ENABLED`/`API_ENABLED` flags):

- Split `app` service into `api` and `worker` services in `docker-compose.yml`.
- `worker` container: `API_ENABLED=false` + fixed outbound egress IP.
- `api` container: `WORKER_ENABLED=false` — no fixed IP needed.
- Scale workers: `docker compose up --scale worker=3`.

Only the container handling dump commands needs database egress. Document the egress IPs given to beta customers and rotate them only with customer notice.

## Local dev session smoke users

`db:seed:dev` creates two local sessions for manual browser/API smoke checks:

- Owner:
  - email: `dev@example.com`
  - cookie: `backup_saas_session=dev-session-token`
- Invitee:
  - email: `dev-invitee@example.com`
  - cookie: `backup_saas_session=dev-invitee-session-token`

Run seed inside Docker dev:

```sh
docker compose exec app sh -lc 'bun --filter @backup-saas/app db:seed:dev'
```

Owner opens:

```text
http://localhost:8080/workspace/dev-workspace
```

Invite smoke through nginx single origin:

```sh
curl -H 'Origin: http://localhost:8080' \
  -H 'Cookie: backup_saas_session=dev-session-token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'action=create-invite&email=dev-invitee@example.com&role=member' \
  http://localhost:8080/workspace/dev-workspace/settings/members
```

Copy the returned `/invite/:token` link, then accept as invitee:

```sh
curl -X POST \
  -H 'Cookie: backup_saas_session=dev-invitee-session-token' \
  http://localhost:8080/v1/invites/$TOKEN/accept
```

Expected accept response includes:

```json
{"data":{"workspace_slug":"dev-workspace","role":"member"}}
```

## Backup dump toolchain smoke checks

Production/runtime `app` image installs database client tools needed by process-mode Backups:

- `pg_dump`
- `psql`
- `mysqldump`
- `mysql`
- `gzip`
- `curl`

After rebuilding the runtime image, verify tool presence inside the container:

```sh
docker compose build app web
docker compose up -d --force-recreate app web nginx
docker compose exec app sh -lc 'CHECK_DUMP_TOOLS=true bun test packages/app/src/services/dump-tools.test.ts'
```

Expected result:

```text
1 pass
0 fail
```

For live local PostgreSQL pipeline verification, use the host-mapped dev database:

```sh
RUN_LIVE_POSTGRES_PIPELINE=true \
LIVE_POSTGRES_DATABASE_URL='postgres://backup_saas:backup_saas@localhost:5433/backup_saas' \
bun test packages/app/src/services/live-postgres-pipeline.test.ts
```

Expected result:

```text
1 pass
0 fail
```

This test creates a fixture table, uses real `psql` for `testConnection()`, runs real `pg_dump`, streams the dump through chunked AES-GCM NDJSON artifact encryption, stores it through streaming local object storage, decrypts it, and verifies fixture content appears in the dump.

For live MySQL pipeline verification, start the MySQL fixture and run the test inside the `app` container so the runtime MySQL client is available:

```sh
docker compose up -d mysql
docker compose exec app sh -lc \
'RUN_LIVE_MYSQL_PIPELINE=true \
 LIVE_POSTGRES_DATABASE_URL=postgres://backup_saas:backup_saas@postgres:5432/backup_saas \
 LIVE_MYSQL_HOST=mysql \
 LIVE_MYSQL_PORT=3306 \
 bun test packages/app/src/services/live-mysql-pipeline.test.ts'
```

Expected result:

```text
1 pass
0 fail
```

This test creates a fixture table in MySQL, uses real `mysql` for `testConnection()`, runs real `mysqldump`, streams gzip output as `.sql.gz`, streams it through chunked AES-GCM NDJSON artifact encryption, stores it through streaming local object storage, decrypts it, gunzips it, and verifies fixture content appears in the dump.

The dev MySQL fixture is host-mapped to `localhost:3317` because `3307` may already be used by other local services.

## Retention and reconciliation commands

Always dry-run before destructive work:

```sh
bun run worker:reconcile -- --dry-run
```

Expected dry-run output lists candidate backup ids/object keys and planned action only. Review workspace ids, object prefixes, and counts before running non-dry-run commands in a controlled maintenance window.

Retention deletion logic exists in worker code and test harness coverage, but this repo does not currently expose a root `worker:retention` CLI wrapper. Use `bun run worker:reconcile -- --dry-run` for shipped operator dry-run command, and add a dedicated retention wrapper before documenting live retention CLI usage.

If dry-run output includes unexpected workspace/object scope, stop and investigate before deletion. Do not run destructive retention/reconcile commands against production while scope is unclear.

## Incident kill switches

Use smallest switch that stops the incident:

1. Disable API ingress for affected routes at the edge if auth/download abuse is active.
2. Stop the `app` container if backup creation, retention, or reconciliation behavior is unsafe (`docker compose stop app`; restart with `WORKER_ENABLED=false` to keep API available while investigating).
3. Set affected `database_sources.state = 'disabled'` to block new manual backups for one source.
4. Invalidate affected sessions by setting `sessions.invalidated_at = now()` for suspected account/session compromise.
5. Revoke pending download tokens by setting `download_requests.revoked_at = now()` for affected workspace/backup/session scope.
6. Remove customer database allow-list entry for worker egress IP when database-side containment is needed.

After containment, preserve audit logs and object metadata for investigation. Do not delete evidence unless legal/ops policy requires it.
