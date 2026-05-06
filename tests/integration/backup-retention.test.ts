import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { createApi } from "../../apps/api/src/index";
import { runRetentionWorker } from "../../apps/worker/src/index";
import { createSqlClient } from "../../packages/db/src/testing";
import { seedHarnessFixtures } from "../harness/fixtures";

setDefaultTimeout(30_000);

describe("backup retention and delete lifecycle", () => {
  test("retention dry-run lists exact candidates and does not mutate", async () => {
    const seeded = await seedHarnessFixtures();
    const client = createSqlClient(seeded.databaseUrl);

    try {
      await client`
        update backups
        set retention_expires_at = now() - interval '1 day'
        where id = ${seeded.backups.agencyA.id}
          and workspace_id = ${seeded.workspaces.agencyA.id}
      `;

      const report = await runRetentionWorker({ client, storage: seeded.storage, now: new Date(), dryRun: true });
      expect(report.dryRun).toBeTrue();
      expect(report.actions).toEqual([
        expect.objectContaining({ backupId: seeded.backups.agencyA.id, workspaceId: seeded.workspaces.agencyA.id, action: "delete" })
      ]);

      seeded.storage.assertObjectExists("opaque/o1/objects/fixture01.enc");
      const [backup] = await client<{ status: string }[]>`
        select status::text as status
        from backups
        where id = ${seeded.backups.agencyA.id}
          and workspace_id = ${seeded.workspaces.agencyA.id}
      `;
      expect(backup.status).toBe("succeeded");
    } finally {
      await client.end();
    }
  });

  test("retention skips active lock, isolates workspace, and expires eligible backup", async () => {
    const seeded = await seedHarnessFixtures();
    const client = createSqlClient(seeded.databaseUrl);

    try {
      await client`
        update backups
        set retention_expires_at = now() - interval '1 day'
        where id in (${seeded.backups.agencyA.id}, ${seeded.backups.agencyB.id})
      `;
      await client`
        insert into backup_download_locks (backup_id, workspace_id, download_request_id, session_id_hash, expires_at)
        select ${seeded.backups.agencyB.id}, ${seeded.workspaces.agencyB.id}, download_requests.id, 'lock-b', now() + interval '5 minutes'
        from download_requests
        where backup_id = ${seeded.backups.agencyA.id}
        limit 1
      `;

      const report = await runRetentionWorker({ client, storage: seeded.storage, now: new Date(), dryRun: false });
      expect(report.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ backupId: seeded.backups.agencyA.id, workspaceId: seeded.workspaces.agencyA.id, action: "delete" }),
        expect.objectContaining({ backupId: seeded.backups.agencyB.id, workspaceId: seeded.workspaces.agencyB.id, action: "skip_locked" })
      ]));

      seeded.storage.assertObjectAbsent("opaque/o1/objects/fixture01.enc");
      seeded.storage.assertObjectExists("opaque/o2/objects/fixture02.enc");

      const rows = await client<{ id: string; workspace_id: string; status: string }[]>`
        select id, workspace_id, status::text as status
        from backups
        where id in (${seeded.backups.agencyA.id}, ${seeded.backups.agencyB.id})
      `;
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: seeded.backups.agencyA.id, workspace_id: seeded.workspaces.agencyA.id, status: "expired" }),
        expect.objectContaining({ id: seeded.backups.agencyB.id, workspace_id: seeded.workspaces.agencyB.id, status: "succeeded" })
      ]));
    } finally {
      await client.end();
    }
  });

  test("retention delete failure records retry metadata and keeps backup active", async () => {
    const seeded = await seedHarnessFixtures();
    const client = createSqlClient(seeded.databaseUrl);

    try {
      await client`
        update backups
        set retention_expires_at = now() - interval '1 day'
        where id = ${seeded.backups.agencyA.id}
          and workspace_id = ${seeded.workspaces.agencyA.id}
      `;
      seeded.storage.failDeleteOnce("opaque/o1/objects/fixture01.enc");

      await runRetentionWorker({ client, storage: seeded.storage, now: new Date(), dryRun: false });

      seeded.storage.assertObjectExists("opaque/o1/objects/fixture01.enc");
      const [backup] = await client<{ status: string; deleted_at: Date | null; expired_at: Date | null }[]>`
        select status::text as status, deleted_at, expired_at
        from backups
        where id = ${seeded.backups.agencyA.id}
          and workspace_id = ${seeded.workspaces.agencyA.id}
      `;
      expect(backup.status).toBe("succeeded");
      expect(backup.deleted_at).toBeNull();
      expect(backup.expired_at).toBeNull();

      const [cleanup] = await client<{ delete_retry_after: Date | null; last_error: string | null }[]>`
        select delete_retry_after, last_error
        from cleanup_records
        where backup_id = ${seeded.backups.agencyA.id}
          and workspace_id = ${seeded.workspaces.agencyA.id}
        order by created_at desc
        limit 1
      `;
      expect(cleanup.delete_retry_after).toBeInstanceOf(Date);
      expect(cleanup.last_error).toContain("fake_delete_failed");
    } finally {
      await client.end();
    }
  });

  test("retention missing object stays idempotent and writes audit warning", async () => {
    const seeded = await seedHarnessFixtures();
    const client = createSqlClient(seeded.databaseUrl);

    try {
      await client`
        update backups
        set retention_expires_at = now() - interval '1 day'
        where id = ${seeded.backups.agencyA.id}
          and workspace_id = ${seeded.workspaces.agencyA.id}
      `;
      seeded.storage.deleteObject("opaque/o1/objects/fixture01.enc");

      const report = await runRetentionWorker({ client, storage: seeded.storage, now: new Date("2026-05-06T12:00:00.000Z"), dryRun: false });
      expect(report.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ backupId: seeded.backups.agencyA.id, workspaceId: seeded.workspaces.agencyA.id, action: "delete" })
      ]));

      seeded.storage.assertObjectAbsent("opaque/o1/objects/fixture01.enc");

      const [backup] = await client<{ status: string; expired_at: Date | null }[]>`
        select status::text as status, expired_at
        from backups
        where id = ${seeded.backups.agencyA.id}
          and workspace_id = ${seeded.workspaces.agencyA.id}
      `;
      expect(backup.status).toBe("expired");
      expect(backup.expired_at).toBeInstanceOf(Date);

      const audits = await client<{ metadata: Record<string, unknown> }[]>`
        select metadata
        from audit_logs
        where workspace_id = ${seeded.workspaces.agencyA.id}
          and event_type = 'backup.delete'
          and target_id = ${seeded.backups.agencyA.id}
          and result = 'succeeded'
        order by created_at desc, id desc
      `;
      const parsedMetadata = audits.map((row) => typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata);
      expect(parsedMetadata).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: "retention",
          objectMissing: true,
          warning: "object_missing_already_deleted"
        })
      ]));
    } finally {
      await client.end();
    }
  });

  test("manual delete denies member, allows owner and admin, and updates retained bytes", async () => {
    const seeded = await seedHarnessFixtures();
    const app = createApi({
      auth: { databaseUrl: seeded.databaseUrl },
      workspaces: { databaseUrl: seeded.databaseUrl },
      audit: { databaseUrl: seeded.databaseUrl },
      backups: { databaseUrl: seeded.databaseUrl, storage: seeded.storage, resolveWorkspaceKey: async () => seeded.workspaceKeys.agencyA, now: () => new Date() }
    });
    const client = createSqlClient(seeded.databaseUrl);

    try {
      const denied = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/backups/${seeded.backups.agencyA.id}`, {
        method: "DELETE",
        headers: { cookie: `mba_session=${seeded.sessions.agencyAMember.token}; mba_csrf=${seeded.sessions.agencyAMember.csrf}`, "x-csrf-token": seeded.sessions.agencyAMember.csrf, "x-request-id": "member-delete" }
      }));
      expect(denied.status).toBe(403);

      const ownerDelete = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/backups/${seeded.backups.agencyA.id}`, {
        method: "DELETE",
        headers: { cookie: `mba_session=${seeded.sessions.agencyAOwner.token}; mba_csrf=${seeded.sessions.agencyAOwner.csrf}`, "x-csrf-token": seeded.sessions.agencyAOwner.csrf, "x-request-id": "owner-delete" }
      }));
      expect(ownerDelete.status).toBe(200);
      const ownerBody = await ownerDelete.json() as { status: string; retainedStorageBytes: string };
      expect(ownerBody.status).toBe("deleted");
      expect(ownerBody.retainedStorageBytes).toBe("0");
      seeded.storage.assertObjectAbsent("opaque/o1/objects/fixture01.enc");

      const replacement = seeded.storage.putObject("opaque/o1/objects/fixture03.enc", "replacement-admin-backup");
      const [replacementJob] = await client<{ id: string }[]>`
        insert into backup_jobs (workspace_id, project_id, database_source_id, trigger, requested_by_user_id, status, stage, attempt_count, started_at, finished_at)
        values (${seeded.workspaces.agencyA.id}, ${seeded.projects.agencyA.id}, ${seeded.sources.postgres.id}, 'manual', ${seeded.users.agencyA.id}, 'succeeded', 'succeeded', 1, now(), now())
        returning id
      `;
      const [replacementBackup] = await client<{ id: string }[]>`
        insert into backups (
          workspace_id, project_id, database_source_id, backup_job_id, storage_config_id, status, engine, format, object_key, download_filename,
          original_dump_size_bytes, stored_size_bytes, encrypted_checksum, retention_expires_at
        )
        select ${seeded.workspaces.agencyA.id}, ${seeded.projects.agencyA.id}, ${seeded.sources.postgres.id}, ${replacementJob.id}, backup_storage_configs.id, 'succeeded', 'postgresql', 'postgres_custom', ${replacement.key}, 'replacement.dump',
          ${BigInt(replacement.body.byteLength)}, ${BigInt(replacement.body.byteLength)}, ${replacement.checksum}, now() + interval '14 days'
        from backup_storage_configs
        where backup_storage_configs.workspace_id = ${seeded.workspaces.agencyA.id}
          and backup_storage_configs.is_current = true
        limit 1
        returning id
      `;

      const adminDelete = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/backups/${replacementBackup.id}`, {
        method: "DELETE",
        headers: { cookie: `mba_session=${seeded.sessions.agencyAAdmin.token}; mba_csrf=${seeded.sessions.agencyAAdmin.csrf}`, "x-csrf-token": seeded.sessions.agencyAAdmin.csrf, "x-request-id": "admin-delete" }
      }));
      expect(adminDelete.status).toBe(200);
      seeded.storage.assertObjectAbsent("opaque/o1/objects/fixture03.enc");
    } finally {
      await client.end();
    }
  });

  test("manual delete skips locked backup and failed delete records retry metadata", async () => {
    const seeded = await seedHarnessFixtures();
    const app = createApi({
      auth: { databaseUrl: seeded.databaseUrl },
      workspaces: { databaseUrl: seeded.databaseUrl },
      audit: { databaseUrl: seeded.databaseUrl },
      backups: { databaseUrl: seeded.databaseUrl, storage: seeded.storage, resolveWorkspaceKey: async () => seeded.workspaceKeys.agencyA, now: () => new Date("2026-05-06T12:00:00.000Z") }
    });
    const client = createSqlClient(seeded.databaseUrl);

    try {
      await client`
        insert into backup_download_locks (backup_id, workspace_id, download_request_id, session_id_hash, expires_at)
        select ${seeded.backups.agencyA.id}, ${seeded.workspaces.agencyA.id}, download_requests.id, 'owner-lock', now() + interval '5 minutes'
        from download_requests
        where backup_id = ${seeded.backups.agencyA.id}
        limit 1
      `;
      const locked = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/backups/${seeded.backups.agencyA.id}`, {
        method: "DELETE",
        headers: { cookie: `mba_session=${seeded.sessions.agencyAOwner.token}; mba_csrf=${seeded.sessions.agencyAOwner.csrf}`, "x-csrf-token": seeded.sessions.agencyAOwner.csrf }
      }));
      expect(locked.status).toBe(409);

      await client`delete from backup_download_locks where backup_id = ${seeded.backups.agencyA.id} and workspace_id = ${seeded.workspaces.agencyA.id}`;
      seeded.storage.failDeleteOnce("opaque/o1/objects/fixture01.enc");

      const failed = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/backups/${seeded.backups.agencyA.id}`, {
        method: "DELETE",
        headers: { cookie: `mba_session=${seeded.sessions.agencyAOwner.token}; mba_csrf=${seeded.sessions.agencyAOwner.csrf}`, "x-csrf-token": seeded.sessions.agencyAOwner.csrf, "x-request-id": "owner-delete-failed" }
      }));
      expect(failed.status).toBe(500);

      const [backup] = await client<{ status: string }[]>`
        select status::text as status
        from backups
        where id = ${seeded.backups.agencyA.id}
          and workspace_id = ${seeded.workspaces.agencyA.id}
      `;
      expect(backup.status).toBe("succeeded");

      const [cleanup] = await client<{ delete_retry_after: Date | null }[]>`
        select delete_retry_after
        from cleanup_records
        where backup_id = ${seeded.backups.agencyA.id}
          and workspace_id = ${seeded.workspaces.agencyA.id}
        order by created_at desc
        limit 1
      `;
      expect(cleanup.delete_retry_after).toBeInstanceOf(Date);
    } finally {
      await client.end();
    }
  });
});
