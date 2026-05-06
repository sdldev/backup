# Beta operations runbook

This runbook covers operational controls for the manual-backup beta. It is not a compliance attestation.

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
5. Restart API and worker processes.
6. Download the staging Backup and verify checksum/content against the known fixture.
7. Record drill date, operator initials, backup id, and result. Do not record the key value.

## Fixed outbound worker IP deployment

Private database allow-listing should use a worker deployment with fixed outbound egress. Choose one of these per environment:

- Cloud NAT or static NAT gateway for worker subnet.
- Provider-managed static egress IP product for container/serverless workers.
- Self-hosted worker VM pool behind a static public IP.

Only worker processes that execute dump commands need database egress. API/web services should not be allow-listed to customer databases unless they run connection-test/dump work in that deployment. Document the egress IPs given to beta customers and rotate them only with customer notice.

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
2. Stop worker processes if backup creation, retention, or reconciliation behavior is unsafe.
3. Set affected `database_sources.state = 'disabled'` to block new manual backups for one source.
4. Invalidate affected sessions by setting `sessions.invalidated_at = now()` for suspected account/session compromise.
5. Revoke pending download tokens by setting `download_requests.revoked_at = now()` for affected workspace/backup/session scope.
6. Remove customer database allow-list entry for worker egress IP when database-side containment is needed.

After containment, preserve audit logs and object metadata for investigation. Do not delete evidence unless legal/ops policy requires it.
