import { describe, expect, test } from "bun:test";

import {
  collectStreamBytes,
  decryptBackupStream,
  encryptBackupStream,
  generateBackupDataKey,
  generateWorkspaceKey,
  loadAppMasterKeyFromEnv,
  readEncryptedBackupHeader,
  unwrapBackupDataKey,
  unwrapWorkspaceKey,
  wrapBackupDataKey,
  wrapWorkspaceKey
} from "./index";

const masterKey = loadAppMasterKeyFromEnv({ APP_MASTER_KEY_V1: Buffer.alloc(32, 7).toString("base64url") });

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

async function expectDecryptRejects(bytes: Uint8Array, dataKey: Uint8Array): Promise<void> {
  await expect(collectStreamBytes(decryptBackupStream(streamFromBytes(bytes), { dataKey }))).rejects.toThrow(/crypto\./);
}

describe("envelope encryption", () => {
  test("encryption.roundtrip streams encrypted object with version 1 header", async () => {
    const dataKey = generateBackupDataKey();
    const plain = new TextEncoder().encode("logical dump bytes\n".repeat(10_000));

    const encrypted = await collectStreamBytes(encryptBackupStream(streamFromBytes(plain), { dataKey, chunkSize: 1024 }));
    const header = readEncryptedBackupHeader(encrypted);
    const decrypted = await collectStreamBytes(decryptBackupStream(streamFromBytes(encrypted), { dataKey }));

    expect(header.version).toBe(1);
    expect(header.magic).toBe("MBAENC");
    expect(header.algorithm).toBe("AES-256-GCM");
    expect(header.chunkSize).toBe(1024);
    expect(Buffer.from(decrypted).equals(Buffer.from(plain))).toBeTrue();
  });

  test("workspace and backup key wrapping is workspace authenticated", async () => {
    const workspaceKey = generateWorkspaceKey();
    const dataKey = generateBackupDataKey();
    const wrappedWorkspaceKey = await wrapWorkspaceKey({ workspaceId: "ws-a", workspaceKey, appMasterKey: masterKey });
    const unwrappedWorkspaceKey = await unwrapWorkspaceKey({ workspaceId: "ws-a", wrappedWorkspaceKey, appMasterKey: masterKey });
    const wrappedBackupKey = await wrapBackupDataKey({
      workspaceId: "ws-a",
      backupId: "backup-a",
      backupDataKey: dataKey,
      workspaceKey: unwrappedWorkspaceKey
    });
    const unwrappedBackupKey = await unwrapBackupDataKey({
      workspaceId: "ws-a",
      backupId: "backup-a",
      wrappedBackupKey,
      workspaceKey: unwrappedWorkspaceKey
    });

    expect(Buffer.from(unwrappedWorkspaceKey).equals(Buffer.from(workspaceKey))).toBeTrue();
    expect(Buffer.from(unwrappedBackupKey).equals(Buffer.from(dataKey))).toBeTrue();
    await expect(unwrapWorkspaceKey({ workspaceId: "ws-b", wrappedWorkspaceKey, appMasterKey: masterKey })).rejects.toThrow(/crypto\./);
    await expect(
      unwrapBackupDataKey({ workspaceId: "ws-b", backupId: "backup-a", wrappedBackupKey, workspaceKey: unwrappedWorkspaceKey })
    ).rejects.toThrow(/crypto\./);
  });

  test("app master key env validation rejects missing or malformed values", () => {
    expect(() => loadAppMasterKeyFromEnv({})).toThrow(/APP_MASTER_KEY_V1/);
    expect(() => loadAppMasterKeyFromEnv({ APP_MASTER_KEY_V1: "not+base64/standard==" })).toThrow(/base64url/);
    expect(() => loadAppMasterKeyFromEnv({ APP_MASTER_KEY_V1: Buffer.alloc(31).toString("base64url") })).toThrow(/32 bytes/);
    expect(loadAppMasterKeyFromEnv({ APP_MASTER_KEY_V1: Buffer.alloc(32).toString("base64url") }).keyBytes.byteLength).toBe(32);
  });

  test("tampered header, ciphertext, and chunk framing fail decrypt", async () => {
    const dataKey = generateBackupDataKey();
    const plain = new TextEncoder().encode("database dump with sensitive rows".repeat(300));
    const encrypted = await collectStreamBytes(encryptBackupStream(streamFromBytes(plain), { dataKey, chunkSize: 128 }));

    const headerTampered = new Uint8Array(encrypted);
    headerTampered[8] = (headerTampered[8] ?? 0) ^ 1;
    await expectDecryptRejects(headerTampered, dataKey);

    const ciphertextTampered = new Uint8Array(encrypted);
    const lastIndex = ciphertextTampered.byteLength - 1;
    ciphertextTampered[lastIndex] = (ciphertextTampered[lastIndex] ?? 0) ^ 1;
    await expectDecryptRejects(ciphertextTampered, dataKey);

    const chunkTampered = encrypted.slice(0, encrypted.byteLength - 3);
    await expectDecryptRejects(chunkTampered, dataKey);
  });
});
