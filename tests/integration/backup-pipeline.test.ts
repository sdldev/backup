import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { createSqlClient } from "../../packages/db/src/index";
import { readEncryptedBackupHeader } from "../../packages/security/src/index";
import { StorageLimitExceededError } from "../../packages/storage/src/index";
import { claimNextBackupJob, processBackupPipeline, reconcileBackupObjectsDryRun, type BackupPipelineDumpRunner } from "../../apps/worker/src/index";
import { seedHarnessFixtures } from "../harness/fixtures";

setDefaultTimeout(30_000);

const workspaceKey = new Uint8Array(32).fill(4);

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

function dumpRunnerFor(bytes: Uint8Array): BackupPipelineDumpRunner {
  return async () => streamFromBytes(bytes);
}

describe("backup pipeline", () => {
  test("backup-pipeline.postgres stores encrypted object and records metadata", async () => {
    const fixture = await seedHarnessFixtures();
    const client = createSqlClient(fixture.databaseUrl);
    const plaintext = new TextEncoder().encode("pg fixture plaintext row: customer_secret=alpha\n".repeat(200));

    try {
      await client`update backup_storage_configs set storage_prefix = 'pm/pipelineopaque' where workspace_id = ${fixture.workspaces.agencyA.id}`;
      await client`
        insert into backup_jobs (workspace_id, project_id, database_source_id, trigger, requested_by_user_id, status, stage, queued_at)
        values (${fixture.workspaces.agencyA.id}, ${fixture.projects.agencyA.id}, ${fixture.sources.postgres.id}, 'manual', ${fixture.users.agencyA.id}, 'queued', 'queued', now() - interval '1 second')
      `;
      const job = await claimNextBackupJob(client);
      if (!job) {
        throw new Error("expected claimed backup job");
      }
      expect(job.databaseSourceId).toBe(fixture.sources.postgres.id);

      const result = await processBackupPipeline({
        client,
        storage: fixture.storage,
        job,
        workspaceKey,
        remainingStorageBytes: 10_000_000n,
        dumpRunner: dumpRunnerFor(plaintext),
        now: new Date("2026-05-06T00:00:00.000Z")
      });
      const object = fixture.storage.assertObjectExists(result.objectKey);

      expect(result.headerVersion).toBe(1);
      expect(readEncryptedBackupHeader(object.body).version).toBe(1);
      expect(object.metadata.idempotencyKey).toBe(`${fixture.workspaces.agencyA.id}:${fixture.sources.postgres.id}:${job.id}:1`);
      expect(Buffer.from(object.body).includes(Buffer.from("customer_secret=alpha"))).toBeFalse();
      expect(result.objectKey).toStartWith("pm/pipelineopaque/objects/");
      expect(result.objectKey).not.toContain(fixture.workspaces.agencyA.slug);
      expect(result.objectKey).not.toContain(fixture.sources.postgres.display_name);
      expect(result.originalDumpSizeBytes).toBe(BigInt(plaintext.byteLength));
      expect(result.storedSizeBytes).toBe(BigInt(object.body.byteLength));
      expect(result.encryptedChecksum).toBe(object.checksum);

      const [backup] = await client<{ object_key: string; encrypted_checksum: string; original_dump_size_bytes: string; stored_size_bytes: string }[]>`
        select object_key, encrypted_checksum, original_dump_size_bytes::text, stored_size_bytes::text
        from backups
        where id = ${result.backupId}
          and workspace_id = ${fixture.workspaces.agencyA.id}
      `;
      expect(backup?.object_key).toBe(result.objectKey);
      expect(backup?.encrypted_checksum).toBe(object.checksum);
      expect(backup?.original_dump_size_bytes).toBe(String(plaintext.byteLength));
      expect(backup?.stored_size_bytes).toBe(String(object.body.byteLength));
    } finally {
      await client.end();
    }
  });

  test("storage limit abort deletes partial object and marks job failed", async () => {
    const fixture = await seedHarnessFixtures();
    const client = createSqlClient(fixture.databaseUrl);
    const plaintext = new TextEncoder().encode("limit failure plaintext".repeat(2_000));

    try {
      await client`update backup_storage_configs set storage_prefix = 'pm/limitopaque' where workspace_id = ${fixture.workspaces.agencyA.id}`;
      await client`
        insert into backup_jobs (workspace_id, project_id, database_source_id, trigger, requested_by_user_id, status, stage, queued_at)
        values (${fixture.workspaces.agencyA.id}, ${fixture.projects.agencyA.id}, ${fixture.sources.postgres.id}, 'manual', ${fixture.users.agencyA.id}, 'queued', 'queued', now() - interval '1 second')
      `;
      const job = await claimNextBackupJob(client);
      if (!job) {
        throw new Error("expected claimed backup job");
      }

      await expect(processBackupPipeline({
        client,
        storage: fixture.storage,
        job,
        workspaceKey,
        remainingStorageBytes: 128n,
        dumpRunner: dumpRunnerFor(plaintext)
      })).rejects.toBeInstanceOf(StorageLimitExceededError);

      expect(fixture.storage.listKeys("pm/limitopaque")).toEqual([]);
      const [failed] = await client<{ status: string; stage: string; user_error_message: string | null }[]>`
        select status::text, stage::text, user_error_message
        from backup_jobs
        where id = ${job.id}
          and workspace_id = ${fixture.workspaces.agencyA.id}
      `;
      expect(failed).toEqual({ status: "failed", stage: "failed", user_error_message: "storage_limit_exceeded" });
    } finally {
      await client.end();
    }
  });

  test("reconciliation dry-run reports orphan only inside scanned workspace prefix", async () => {
    const fixture = await seedHarnessFixtures();
    const client = createSqlClient(fixture.databaseUrl);

    try {
      fixture.storage.putObject("pm/reconcile/objects/orphan.enc", "orphan", { idempotencyKey: "ws:src:job:1" });
      fixture.storage.putObject("opaque/o2/objects/other-workspace.enc", "keep-b", { idempotencyKey: "wsb:src:job:1" });
      const report = await reconcileBackupObjectsDryRun({ client, storage: fixture.storage, storagePrefix: "pm/reconcile" });

      expect(report.dryRun).toBeTrue();
      expect(report.actions).toEqual([{ objectKey: "pm/reconcile/objects/orphan.enc", action: "delete_orphan", reason: "no matching succeeded backup metadata" }]);
      fixture.storage.assertObjectExists("pm/reconcile/objects/orphan.enc");
      fixture.storage.assertObjectExists("opaque/o2/objects/other-workspace.enc");
    } finally {
      await client.end();
    }
  });
});
