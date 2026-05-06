import { createHash } from "node:crypto";
import { readObjectStreamForUpload, type BackupObjectUploadRequest, type BackupObjectStorage, type StoredBackupObject } from "../../packages/storage/src/index";

export type FakeStoredObject = {
  key: string;
  body: Uint8Array;
  checksum: string;
  metadata: Record<string, string>;
};

export class FakeS3Storage implements BackupObjectStorage {
  readonly provider = "fake-s3-compatible";
  readonly bucket = "mba-test-bucket";
  readonly endpoint = "http://127.0.0.1:9000/fake-s3";
  #objects = new Map<string, FakeStoredObject>();
  #deleteFailures = new Set<string>();

  putObject(key: string, body: Uint8Array | string, metadata: Record<string, string> = {}): FakeStoredObject {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const stored: FakeStoredObject = {
      key,
      body: bytes,
      checksum,
      metadata: { ...metadata }
    };

    this.#objects.set(key, stored);
    return stored;
  }

  async putObjectStream(request: BackupObjectUploadRequest): Promise<StoredBackupObject> {
    const { body, stored } = await readObjectStreamForUpload(request);
    this.#objects.set(request.key, {
      key: request.key,
      body,
      checksum: stored.checksum,
      metadata: { ...stored.metadata }
    });
    return stored;
  }

  getObject(key: string): FakeStoredObject | undefined {
    return this.#objects.get(key);
  }

  hasObject(key: string): boolean {
    return this.#objects.has(key);
  }

  assertObjectExists(key: string): FakeStoredObject {
    const object = this.#objects.get(key);

    if (!object) {
      throw new Error(`Expected fake object to exist: ${key}`);
    }

    return object;
  }

  assertObjectAbsent(key: string): void {
    if (this.#objects.has(key)) {
      throw new Error(`Expected fake object to be absent: ${key}`);
    }
  }

  assertChecksum(key: string, expectedChecksum: string): void {
    const object = this.assertObjectExists(key);

    if (object.checksum !== expectedChecksum) {
      throw new Error(`Checksum mismatch for ${key}: expected ${expectedChecksum}, got ${object.checksum}`);
    }
  }

  deleteObject(key: string): boolean {
    if (this.#deleteFailures.has(key)) {
      throw new Error(`fake_delete_failed:${key}`);
    }
    return this.#objects.delete(key);
  }

  failDeleteOnce(key: string): void {
    this.#deleteFailures.add(key);
  }

  clearDeleteFailure(key: string): void {
    this.#deleteFailures.delete(key);
  }

  listKeys(prefix = ""): string[] {
    return [...this.#objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  reset(): void {
    this.#objects.clear();
  }
}
