import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { createSqlClient, getDatabaseUrl } from "@mba/db";

type SqlClient = ReturnType<typeof createSqlClient>;

export type ProvisionWorkspaceStorageResult = {
  workspaceId: string;
  status: "ready" | "failed";
  storageConfigId?: string;
  error?: string;
};

export type StoredBackupObject = {
  key: string;
  sizeBytes: bigint;
  checksum: string;
  metadata: Record<string, string>;
};

export type BackupObjectUploadRequest = {
  key: string;
  body: ReadableStream<Uint8Array>;
  metadata: Record<string, string>;
  maxBytes?: bigint;
};

export interface BackupObjectStorage {
  putObjectStream(request: BackupObjectUploadRequest): Promise<StoredBackupObject>;
  deleteObject(key: string): Promise<boolean> | boolean;
  hasObject?(key: string): Promise<boolean> | boolean;
  listKeys(prefix?: string): Promise<string[]> | string[];
}

export class StorageLimitExceededError extends Error {
  constructor(readonly limitBytes: bigint, readonly observedBytes: bigint) {
    super("storage_limit_exceeded");
    this.name = "StorageLimitExceededError";
  }
}

export const platformManagedStorageProvider = "minio";
export const platformManagedStorageDisplayName = "Platform Managed Storage";

export function createOpaqueStoragePrefix(): string {
  return `pm/${randomBytes(24).toString("base64url")}`;
}

export function createOpaqueBackupObjectKey(storagePrefix: string): string {
  return `${storagePrefix.replace(/\/+$/g, "")}/objects/${randomBytes(32).toString("base64url")}.enc`;
}

export async function readObjectStreamForUpload(request: BackupObjectUploadRequest): Promise<{ body: Uint8Array; stored: StoredBackupObject }> {
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  const hash = createHash("sha256");
  let total = 0n;

  while (true) {
    const read = await reader.read();
    if (read.done) {
      break;
    }

    const chunk = copyBytes(read.value);
    total += BigInt(chunk.byteLength);
    if (request.maxBytes !== undefined && total > request.maxBytes) {
      throw new StorageLimitExceededError(request.maxBytes, total);
    }

    hash.update(chunk);
    chunks.push(chunk);
  }

  const body = concatBytes(chunks);
  return {
    body,
    stored: {
      key: request.key,
      sizeBytes: total,
      checksum: hash.digest("hex"),
      metadata: { ...request.metadata }
    }
  };
}

export function createOpaqueCredentialFingerprint(prefix: string): string {
  return `platform-managed:${Buffer.from(prefix).toString("base64url")}`;
}

export async function provisionWorkspaceStorage(workspaceId: string, databaseUrl = getDatabaseUrl()): Promise<ProvisionWorkspaceStorageResult> {
  const client = createSqlClient(databaseUrl);
  try {
    return await provisionWorkspaceStorageWithClient(client, workspaceId);
  } finally {
    await client.end();
  }
}

export async function provisionWorkspaceStorageWithClient(client: SqlClient, workspaceId: string): Promise<ProvisionWorkspaceStorageResult> {
  try {
    const prefix = createOpaqueStoragePrefix();
    const [created] = await client.begin(async (transaction) => {
      await transaction`
        update backup_storage_configs
        set is_current = false, retired_at = coalesce(retired_at, now()), updated_at = now()
        where workspace_id = ${workspaceId}
          and is_current = true
      `;

      const rows = await transaction<{ id: string }[]>`
        insert into backup_storage_configs (workspace_id, provider, mode, display_name, storage_prefix, credential_fingerprint, status, is_current, activated_at)
        values (${workspaceId}, ${platformManagedStorageProvider}, 'platform_managed', ${platformManagedStorageDisplayName}, ${prefix}, ${createOpaqueCredentialFingerprint(prefix)}, 'active', true, now())
        returning id
      `;

      await transaction`
        update workspaces
        set storage_status = 'ready', updated_at = now()
        where id = ${workspaceId}
          and soft_deleted_at is null
      `;

      return rows;
    });

    if (!created) {
      throw new Error("storage.provisioning_config_failed");
    }

    return { workspaceId, status: "ready", storageConfigId: created.id };
  } catch (error) {
    await client`
      update workspaces
      set storage_status = 'failed', updated_at = now()
      where id = ${workspaceId}
        and soft_deleted_at is null
    `;
    return { workspaceId, status: "failed", error: error instanceof Error ? error.message : "storage.provisioning_failed" };
  }
}

export function storageSmoke(): string {
  return "storage";
}

function copyBytes(value: Uint8Array): Uint8Array {
  const output = new Uint8Array(value.byteLength);
  output.set(value);
  return output;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
