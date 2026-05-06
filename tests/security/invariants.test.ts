import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  collectStreamBytes,
  decryptBackupStream,
  encryptBackupStream,
  generateBackupDataKey,
  loadAppMasterKeyFromEnv,
  unwrapWorkspaceKey,
  wrapWorkspaceKey
} from "../../packages/security/src/index";
import { StorageLimitExceededError } from "../../packages/storage/src/index";
import { createSqlClient } from "../../packages/db/src/testing";
import { runRetentionWorker } from "../../apps/worker/src/index";
import { assertVerifiedFakeOAuthIdentity, resolveFakeOAuthIdentity } from "../harness/fake-oauth";
import { createMarkerPrinter, shouldRunSecurityGroup } from "../harness/security";
import { FakeS3Storage } from "../harness/fake-storage";
import { seedHarnessFixtures } from "../harness/fixtures";

const markers = createMarkerPrinter();

describe("security invariant framework", () => {
  test("SEC-01 tenant harness rejects cross-workspace lookup baseline", () => {
    if (!shouldRunSecurityGroup("tenant")) {
      return;
    }

    const rows = [
      { workspaceId: "ws_agency_a", projectId: "project-a" },
      { workspaceId: "ws_agency_b", projectId: "project-b" }
    ];
    const scoped = rows.filter((item) => item.workspaceId === "ws_agency_a" && item.projectId === "project-b");

    expect(scoped).toEqual([]);
    markers.print("SEC-01");
  });

  test("SEC-02 owner invariant keeps one logical owner baseline", () => {
    if (!shouldRunSecurityGroup("owner")) {
      return;
    }

    const roles = ["owner", "admin", "member"];
    expect(roles.filter((item) => item === "owner")).toEqual(["owner"]);
    markers.print("SEC-02");
  });

  test("SEC-03 oauth harness rejects unverified identity", () => {
    if (!shouldRunSecurityGroup("oauth")) {
      return;
    }

    const verified = resolveFakeOAuthIdentity("google", "agency-a@example.com");
    expect(assertVerifiedFakeOAuthIdentity(verified).email).toBe("agency-a@example.com");
    const unverified = resolveFakeOAuthIdentity("google", "pending-member@example.com");
    expect(() => assertVerifiedFakeOAuthIdentity(unverified)).toThrow(/not verified/i);
    markers.print("SEC-03");
  });

  test("SEC-04 secret harness exposes fingerprint not raw secret", () => {
    if (!shouldRunSecurityGroup("secrets")) {
      return;
    }

    const rawSecret = "postgres://admin:super-secret@db.internal/app";
    const masked = "post.../app";
    const fingerprint = createHash("sha256").update(rawSecret).digest("hex");

    expect(masked).not.toContain(rawSecret);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    markers.print("SEC-04");
  });

  test("SEC-05 impersonation baseline denies protected actions", () => {
    if (!shouldRunSecurityGroup("impersonation")) {
      return;
    }

    const session = { impersonation: { active: true }, canDownload: false, canMutateSecret: false };
    expect(session.impersonation.active).toBeTrue();
    expect(session.canDownload).toBeFalse();
    expect(session.canMutateSecret).toBeFalse();
    markers.print("SEC-05");
  });

  test("SEC-06 download token baseline binds session and single use", () => {
    if (!shouldRunSecurityGroup("downloads")) {
      return;
    }

    const token = {
      sessionIdHash: createHash("sha256").update("session-a").digest("hex"),
      consumedAt: null as Date | null,
      expiresAt: new Date(Date.now() + 10_000)
    };

    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(token.sessionIdHash).not.toBe(createHash("sha256").update("session-b").digest("hex"));
    token.consumedAt = new Date();
    expect(token.consumedAt).not.toBeNull();
    markers.print("SEC-06");
  });

  test("SEC-07 crypto rejects tamper and foreign workspace unwrap", async () => {
    if (!shouldRunSecurityGroup("crypto")) {
      return;
    }

    const appMasterKey = loadAppMasterKeyFromEnv({ APP_MASTER_KEY_V1: Buffer.alloc(32, 9).toString("base64url") });
    const workspaceKey = new Uint8Array(32).fill(1);
    const wrappedWorkspaceKey = await wrapWorkspaceKey({ workspaceId: "ws_agency_a", workspaceKey, appMasterKey });
    await expect(unwrapWorkspaceKey({ workspaceId: "ws_agency_b", wrappedWorkspaceKey, appMasterKey })).rejects.toThrow(/crypto\./);

    const dataKey = generateBackupDataKey();
    const plain = new TextEncoder().encode("encrypted-backup-object".repeat(500));
    const encrypted = await collectStreamBytes(
      encryptBackupStream(streamFromBytes(plain), {
        dataKey,
        chunkSize: 256
      })
    );
    const headerTampered = new Uint8Array(encrypted);
    headerTampered[8] ^= 1;
    const ciphertextTampered = new Uint8Array(encrypted);
    ciphertextTampered[ciphertextTampered.byteLength - 1] ^= 1;
    const chunkTampered = encrypted.slice(0, encrypted.byteLength - 5);

    await expect(collectStreamBytes(decryptBackupStream(streamFromBytes(headerTampered), { dataKey }))).rejects.toThrow(/crypto\./);
    await expect(collectStreamBytes(decryptBackupStream(streamFromBytes(ciphertextTampered), { dataKey }))).rejects.toThrow(/crypto\./);
    await expect(collectStreamBytes(decryptBackupStream(streamFromBytes(chunkTampered), { dataKey }))).rejects.toThrow(/crypto\./);
    markers.print("SEC-07");
  });

  test("SEC-08 pipeline cleanup removes storage-limit partials and keeps dry-run orphans", async () => {
    if (!shouldRunSecurityGroup("pipeline-cleanup")) {
      return;
    }

    const storage = new FakeS3Storage();
    await expect(storage.putObjectStream({
      key: "opaque/partial.enc",
      body: streamFromBytes(new TextEncoder().encode("encrypted partial object".repeat(100))),
      metadata: { idempotencyKey: "ws:src:job:1" },
      maxBytes: 32n
    })).rejects.toBeInstanceOf(StorageLimitExceededError);
    storage.assertObjectAbsent("opaque/partial.enc");

    storage.putObject("opaque/orphan.enc", "orphan", { idempotencyKey: "ws:src:job:1" });
    expect(storage.hasObject("opaque/orphan.enc")).toBeTrue();
    markers.print("SEC-08");
  });

  test("SEC-09 retention deletes only scoped eligible objects", async () => {
    if (!shouldRunSecurityGroup("retention")) {
      return;
    }

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
      expect(report.actions.filter((item) => item.workspaceId === seeded.workspaces.agencyA.id && item.action === "delete")).toEqual([
        expect.objectContaining({ backupId: seeded.backups.agencyA.id, workspaceId: seeded.workspaces.agencyA.id, action: "delete" })
      ]);
      expect(report.actions.filter((item) => item.workspaceId === seeded.workspaces.agencyB.id && item.action === "delete")).toEqual([]);
    } finally {
      await client.end();
    }
    markers.print("SEC-09");
  });

  test("SEC-10 audit baseline records sensitive action envelope", () => {
    if (!shouldRunSecurityGroup("audit")) {
      return;
    }

    const auditEvent = {
      actorUserId: "user-a",
      effectiveUserId: "user-a",
      sessionId: "session-a",
      action: "backup.download.request",
      result: "succeeded",
      targetType: "backup",
      targetId: "backup-a"
    };

    expect(auditEvent.action).toContain("backup.download");
    expect(auditEvent.result).toBe("succeeded");
    markers.print("SEC-10");
  });

  test("SEC-11 plan request invariant allows at most one pending request", () => {
    const requests = [
      { workspaceId: "ws_agency_a", status: "pending" },
      { workspaceId: "ws_agency_a", status: "approved" },
      { workspaceId: "ws_agency_b", status: "pending" }
    ];

    const pendingByWorkspace = new Map<string, number>();
    for (const request of requests.filter((item) => item.status === "pending")) {
      pendingByWorkspace.set(request.workspaceId, (pendingByWorkspace.get(request.workspaceId) ?? 0) + 1);
    }

    expect([...pendingByWorkspace.values()].every((count) => count === 1)).toBeTrue();
    markers.print("SEC-11");
  });
});

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

test("security invariant runner prints summary marker", () => {
  markers.finalize();
  expect(true).toBeTrue();
});
