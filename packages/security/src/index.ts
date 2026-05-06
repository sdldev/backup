import {
  OAUTH_STATE_EXEMPT_ROUTE_NAMES,
  PROTECTED_IMPERSONATION_ACTIONS,
  csrfUnsafeMethods,
  type RouteName,
  type SystemRole,
  type WorkspaceRole
} from "@mba/shared";

const ENCRYPTED_BACKUP_MAGIC = "MBAENC";
const ENCRYPTED_BACKUP_VERSION = 1;
const AES_GCM_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const DEFAULT_CHUNK_SIZE = 64 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const workspaceRoleRank: Record<WorkspaceRole, number> = {
  member: 1,
  admin: 2,
  owner: 3
};

export type SessionMembership = {
  workspaceId: string;
  role: WorkspaceRole;
};

export type ImpersonationContext = {
  active: boolean;
  adminUserId: string;
  targetUserId: string;
  reason: string;
  startedAt: string;
};

export type AppSession = {
  sessionId: string;
  userId: string;
  systemRole: SystemRole | null;
  memberships: SessionMembership[];
  impersonation: ImpersonationContext | null;
};

export type TenantAccessRequest = {
  workspaceId: string;
  session: AppSession;
  minRole: WorkspaceRole;
};

export type TenantAccess = {
  workspaceId: string;
  session: AppSession;
  membership: SessionMembership;
  impersonation: ImpersonationContext | null;
};

export type SessionAction = "workspace.read" | "backup.download" | "secret.mutate" | "secret.reveal";

export type SessionActionRequest = {
  session: AppSession;
  action: SessionAction;
};

export type CsrfPolicyRequest = {
  method: string;
  routeName: RouteName;
  authKind: "cookie" | "bearer" | "public";
  hasCsrfToken: boolean;
  hasOAuthState: boolean;
};

export type SecretRecord = {
  encrypted: string;
  masked: string;
  fingerprint: string;
};

export type SanitizedError = {
  code: string;
  message: string;
  internalErrorRef: string;
};

const logRedactionToken = "[REDACTED]";

const sensitiveKeyPattern = /(password|passwd|pwd|secret|token|credential|authorization|oauth|access_token|refresh_token|downloadToken|stdout|stderr|dump|argv|raw)/i;

export type AppMasterKey = {
  version: 1;
  keyBytes: Uint8Array;
};

export type WrappedWorkspaceKey = {
  masterKeyVersion: 1;
  iv: string;
  wrappedKey: string;
};

export type WrappedBackupKey = {
  workspaceKeyVersion: 1;
  iv: string;
  wrappedKey: string;
};

export type EncryptedBackupHeader = {
  magic: "MBAENC";
  version: 1;
  algorithm: "AES-256-GCM";
  chunkSize: number;
  headerIv: string;
};

export type EncryptBackupStreamOptions = {
  dataKey: Uint8Array;
  chunkSize?: number;
  randomBytes?: (length: number) => Uint8Array;
};

export type DecryptBackupStreamOptions = {
  dataKey: Uint8Array;
};

type AppMasterKeyEnv = Record<string, string | undefined>;

type Bytes = Uint8Array<ArrayBufferLike>;
type ByteReader = ReadableStreamDefaultReader<Bytes>;

export function securitySmoke(): boolean {
  return true;
}

export function loadAppMasterKeyFromEnv(env: AppMasterKeyEnv = process.env as AppMasterKeyEnv): AppMasterKey {
  const value = env.APP_MASTER_KEY_V1;
  if (!value) {
    throw new Error("crypto.app_master_key_invalid: APP_MASTER_KEY_V1 is required");
  }

  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("crypto.app_master_key_invalid: APP_MASTER_KEY_V1 must be unpadded base64url");
  }

  const keyBytes = Buffer.from(value, "base64url");
  if (keyBytes.byteLength !== AES_GCM_KEY_BYTES) {
    throw new Error("crypto.app_master_key_invalid: APP_MASTER_KEY_V1 must decode to 32 bytes");
  }

  return { version: 1, keyBytes: copyBytes(keyBytes) };
}

export function generateWorkspaceKey(randomBytes = crypto.getRandomValues.bind(crypto)): Uint8Array {
  return randomBytes(new Uint8Array(AES_GCM_KEY_BYTES));
}

export function generateBackupDataKey(randomBytes = crypto.getRandomValues.bind(crypto)): Uint8Array {
  return randomBytes(new Uint8Array(AES_GCM_KEY_BYTES));
}

export async function wrapWorkspaceKey(params: {
  workspaceId: string;
  workspaceKey: Uint8Array;
  appMasterKey: AppMasterKey;
  randomBytes?: (length: number) => Uint8Array;
}): Promise<WrappedWorkspaceKey> {
  assertAesKeyLength(params.workspaceKey, "workspace key");
  const iv = (params.randomBytes ?? secureRandomBytes)(AES_GCM_IV_BYTES);
  const aad = textEncoder.encode(`workspace-key:v1:${params.workspaceId}`);
  const wrapped = await encryptAesGcm(params.appMasterKey.keyBytes, iv, params.workspaceKey, aad);

  return {
    masterKeyVersion: params.appMasterKey.version,
    iv: encodeBase64Url(iv),
    wrappedKey: encodeBase64Url(wrapped)
  };
}

export async function unwrapWorkspaceKey(params: {
  workspaceId: string;
  wrappedWorkspaceKey: WrappedWorkspaceKey;
  appMasterKey: AppMasterKey;
}): Promise<Uint8Array> {
  const aad = textEncoder.encode(`workspace-key:v1:${params.workspaceId}`);
  const key = await decryptAesGcm(
    params.appMasterKey.keyBytes,
    decodeBase64Url(params.wrappedWorkspaceKey.iv),
    decodeBase64Url(params.wrappedWorkspaceKey.wrappedKey),
    aad
  );
  assertAesKeyLength(key, "workspace key");
  return key;
}

export async function wrapBackupDataKey(params: {
  workspaceId: string;
  backupId: string;
  backupDataKey: Uint8Array;
  workspaceKey: Uint8Array;
  randomBytes?: (length: number) => Uint8Array;
}): Promise<WrappedBackupKey> {
  assertAesKeyLength(params.backupDataKey, "backup data key");
  assertAesKeyLength(params.workspaceKey, "workspace key");
  const iv = (params.randomBytes ?? secureRandomBytes)(AES_GCM_IV_BYTES);
  const aad = textEncoder.encode(`backup-key:v1:${params.workspaceId}:${params.backupId}`);
  const wrapped = await encryptAesGcm(params.workspaceKey, iv, params.backupDataKey, aad);

  return {
    workspaceKeyVersion: 1,
    iv: encodeBase64Url(iv),
    wrappedKey: encodeBase64Url(wrapped)
  };
}

export async function unwrapBackupDataKey(params: {
  workspaceId: string;
  backupId: string;
  wrappedBackupKey: WrappedBackupKey;
  workspaceKey: Uint8Array;
}): Promise<Uint8Array> {
  assertAesKeyLength(params.workspaceKey, "workspace key");
  const aad = textEncoder.encode(`backup-key:v1:${params.workspaceId}:${params.backupId}`);
  const key = await decryptAesGcm(
    params.workspaceKey,
    decodeBase64Url(params.wrappedBackupKey.iv),
    decodeBase64Url(params.wrappedBackupKey.wrappedKey),
    aad
  );
  assertAesKeyLength(key, "backup data key");
  return key;
}

export function encryptBackupStream(
  input: ReadableStream<Uint8Array>,
  options: EncryptBackupStreamOptions
): ReadableStream<Uint8Array> {
  assertAesKeyLength(options.dataKey, "backup data key");
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new Error("crypto.invalid_chunk_size: chunk size must be a positive integer");
  }

  const randomBytes = options.randomBytes ?? secureRandomBytes;
  const headerIv = randomBytes(AES_GCM_IV_BYTES);
  const header: EncryptedBackupHeader = {
    magic: ENCRYPTED_BACKUP_MAGIC,
    version: ENCRYPTED_BACKUP_VERSION,
    algorithm: "AES-256-GCM",
    chunkSize,
    headerIv: encodeBase64Url(headerIv)
  };
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  const reader = input.getReader() as ByteReader;
  const dataKey = copyBytes(options.dataKey);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encodeLength(headerBytes.length));
        controller.enqueue(headerBytes);

        let pending: Bytes = new Uint8Array(0);
        let chunkIndex = 0;
        while (true) {
          const read = await reader.read();
          if (read.done) {
            break;
          }
          pending = concatBytes(pending, toBytes(read.value));
          while (pending.byteLength >= chunkSize) {
            const plainChunk = toBytes(pending.slice(0, chunkSize));
            pending = toBytes(pending.slice(chunkSize));
            await enqueueEncryptedChunk(controller, dataKey, headerBytes, chunkIndex, plainChunk, randomBytes);
            chunkIndex += 1;
          }
        }

        if (pending.byteLength > 0) {
          await enqueueEncryptedChunk(controller, dataKey, headerBytes, chunkIndex, pending, randomBytes);
        }

        controller.close();
      } catch (error) {
        controller.error(toCryptoError("crypto.encrypt_failed", error));
      }
    }
  });
}

export function decryptBackupStream(input: ReadableStream<Uint8Array>, options: DecryptBackupStreamOptions): ReadableStream<Uint8Array> {
  assertAesKeyLength(options.dataKey, "backup data key");
  const reader = input.getReader() as ByteReader;
  const dataKey = copyBytes(options.dataKey);
  let pending: Bytes = new Uint8Array(0);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const headerLengthBytes = await readExactly(reader, pending, 4);
          pending = toBytes(headerLengthBytes.remaining);
        const headerLength = decodeLength(headerLengthBytes.bytes);
        const headerRead = await readExactly(reader, pending, headerLength);
        pending = toBytes(headerRead.remaining);
        const headerBytes = toBytes(headerRead.bytes);
        parseEncryptedBackupHeader(headerBytes);

        let chunkIndex = 0;
        while (true) {
          const lengthRead = await readAtLeastOrEnd(reader, pending, 4);
          pending = toBytes(lengthRead.remaining);
          if (!lengthRead.bytes) {
            break;
          }

          const chunkLength = decodeLength(lengthRead.bytes);
          const chunkRead = await readExactly(reader, pending, chunkLength);
          pending = toBytes(chunkRead.remaining);
          const encryptedChunk = toBytes(chunkRead.bytes);
          if (encryptedChunk.byteLength <= AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES) {
            throw new Error("crypto.invalid_chunk: encrypted chunk too short");
          }

          const iv = toBytes(encryptedChunk.slice(0, AES_GCM_IV_BYTES));
          const ciphertext = toBytes(encryptedChunk.slice(AES_GCM_IV_BYTES));
          const aad = buildChunkAad(headerBytes, chunkIndex);
          const plainChunk = await decryptAesGcm(dataKey, iv, ciphertext, aad);
          controller.enqueue(plainChunk);
          chunkIndex += 1;
        }

        controller.close();
      } catch (error) {
        controller.error(toCryptoError("crypto.decrypt_failed", error));
      }
    }
  });
}

export async function collectStreamBytes(input: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = input.getReader() as ByteReader;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const read = await reader.read();
    if (read.done) {
      break;
    }
    const chunk = toBytes(read.value);
    chunks.push(chunk);
    total += chunk.byteLength;
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function readEncryptedBackupHeader(objectBytes: Uint8Array): EncryptedBackupHeader {
  if (objectBytes.byteLength < 4) {
    throw new Error("crypto.invalid_header: missing header length");
  }
  const headerLength = decodeLength(objectBytes.slice(0, 4));
  if (objectBytes.byteLength < 4 + headerLength) {
    throw new Error("crypto.invalid_header: incomplete header");
  }
  return parseEncryptedBackupHeader(objectBytes.slice(4, 4 + headerLength));
}

export function createTenantGuard() {
  return {
    requireAccess(request: TenantAccessRequest): TenantAccess {
      return assertTenantAccess(request);
    }
  };
}

export function assertTenantAccess(request: TenantAccessRequest): TenantAccess {
  const membership = request.session.memberships.find((entry) => entry.workspaceId === request.workspaceId);

  if (!membership) {
    throw new Error(`tenant.membership_required: session '${request.session.sessionId}' lacks membership for workspace '${request.workspaceId}'`);
  }

  if (workspaceRoleRank[membership.role] < workspaceRoleRank[request.minRole]) {
    throw new Error(
      `tenant.role_required: workspace '${request.workspaceId}' requires role '${request.minRole}', got '${membership.role}'`
    );
  }

  return {
    workspaceId: request.workspaceId,
    session: request.session,
    membership,
    impersonation: request.session.impersonation
  };
}

export function createSessionPolicy() {
  return {
    assertActionAllowed(request: SessionActionRequest): void {
      assertSessionActionAllowed(request);
    }
  };
}

export function assertSessionActionAllowed(request: SessionActionRequest): void {
  if (request.session.impersonation?.active && PROTECTED_IMPERSONATION_ACTIONS.includes(request.action as never)) {
    throw new Error(`session.impersonation_denied: action '${request.action}' blocked during impersonation`);
  }

  if (
    request.session.systemRole
    && (request.action === "backup.download" || request.action === "secret.mutate" || request.action === "secret.reveal")
  ) {
    throw new Error(`session.system_role_denied: action '${request.action}' blocked for system role '${request.session.systemRole}'`);
  }
}

export function assertCsrfPolicy(request: CsrfPolicyRequest): void {
  if (request.authKind !== "cookie") {
    return;
  }

  const isUnsafeMethod = csrfUnsafeMethods.includes(request.method.toUpperCase() as (typeof csrfUnsafeMethods)[number]);
  if (!isUnsafeMethod) {
    return;
  }

  const routeName = request.routeName as string;
  const oauthExempt = OAUTH_STATE_EXEMPT_ROUTE_NAMES.includes(routeName as (typeof OAUTH_STATE_EXEMPT_ROUTE_NAMES)[number]);

  if (oauthExempt) {
    if (!request.hasOAuthState) {
      throw new Error(`csrf.invalid: oauth callback '${routeName}' requires validated state`);
    }

    return;
  }

  if (!request.hasCsrfToken) {
    throw new Error(`csrf.required: unsafe cookie-auth route '${routeName}' requires csrf token`);
  }
}

export function maskSecret(value: string): string {
  if (value.length <= 4) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 2)}${"*".repeat(Math.max(4, value.length - 4))}${value.slice(-2)}`;
}

export async function fingerprintSecret(value: string): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(buffer).toString("hex");
}

export async function sealSecret(value: string): Promise<SecretRecord> {
  const encoded = new TextEncoder().encode(value);
  return {
    encrypted: Buffer.from(encoded).toString("base64url"),
    masked: maskSecret(value),
    fingerprint: await fingerprintSecret(value)
  };
}

export function createSanitizedError(code: string, fallbackMessage: string, cause?: unknown): SanitizedError {
  const internalErrorRef = crypto.randomUUID();
  redactForStructuredLog(cause);

  return {
    code,
    message: fallbackMessage,
    internalErrorRef
  };
}

export function redactForStructuredLog<T>(value: T): T | string {
  return redactValue(value, new WeakSet()) as T | string;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
    key,
    sensitiveKeyPattern.test(key) ? logRedactionToken : redactValue(nested, seen)
  ]));
}

function redactText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, `$1${logRedactionToken}`)
    .replace(/(access_token|refresh_token|downloadToken|token|password|passwd|pwd|secret|credential)(\s*[=:]\s*)([^\s,;&]+)/gi, `$1$2${logRedactionToken}`)
    .replace(/([A-Za-z]+:\/\/)([^\s:@]+):([^\s@]+)@/g, `$1${logRedactionToken}:${logRedactionToken}@`)
    .replace(/(--password=|--password\s+|PGPASSWORD=|MYSQL_PWD=)([^\s,;]+)/gi, `$1${logRedactionToken}`)
    .replace(/(stdout|stderr|raw dump output|dump output)(\s*[=:]\s*)([^\n]+)/gi, `$1$2${logRedactionToken}`);
}

async function enqueueEncryptedChunk(
  controller: ReadableStreamDefaultController<Uint8Array>,
  dataKey: Uint8Array,
  headerBytes: Uint8Array,
  chunkIndex: number,
  plainChunk: Uint8Array,
  randomBytes: (length: number) => Uint8Array
): Promise<void> {
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const aad = buildChunkAad(headerBytes, chunkIndex);
  const ciphertext = await encryptAesGcm(dataKey, iv, plainChunk, aad);
  const encryptedChunk = concatBytes(iv, ciphertext);
  controller.enqueue(encodeLength(encryptedChunk.byteLength));
  controller.enqueue(encryptedChunk);
}

function parseEncryptedBackupHeader(headerBytes: Uint8Array): EncryptedBackupHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(headerBytes));
  } catch (error) {
    throw toCryptoError("crypto.invalid_header", error);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("crypto.invalid_header: header must be object");
  }

  const header = parsed as Partial<EncryptedBackupHeader>;
  if (header.magic !== ENCRYPTED_BACKUP_MAGIC) {
    throw new Error("crypto.invalid_header: magic mismatch");
  }
  if (header.version !== ENCRYPTED_BACKUP_VERSION) {
    throw new Error("crypto.invalid_header: unsupported version");
  }
  if (header.algorithm !== "AES-256-GCM") {
    throw new Error("crypto.invalid_header: unsupported algorithm");
  }
  const chunkSize = header.chunkSize;
  if (typeof chunkSize !== "number" || !Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new Error("crypto.invalid_header: invalid chunk size");
  }
  if (typeof header.headerIv !== "string" || decodeBase64Url(header.headerIv).byteLength !== AES_GCM_IV_BYTES) {
    throw new Error("crypto.invalid_header: invalid header iv");
  }

  return {
    magic: ENCRYPTED_BACKUP_MAGIC,
    version: ENCRYPTED_BACKUP_VERSION,
    algorithm: "AES-256-GCM",
    chunkSize,
    headerIv: header.headerIv
  };
}

async function encryptAesGcm(keyBytes: Uint8Array, iv: Uint8Array, plain: Uint8Array, additionalData: Uint8Array): Promise<Uint8Array> {
  assertAesKeyLength(keyBytes, "AES-GCM key");
  if (iv.byteLength !== AES_GCM_IV_BYTES) {
    throw new Error("crypto.invalid_iv: AES-GCM iv must be 12 bytes");
  }
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), "AES-GCM", false, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(additionalData), tagLength: 128 },
    key,
    toArrayBuffer(plain)
  );
  return new Uint8Array(encrypted);
}

async function decryptAesGcm(keyBytes: Uint8Array, iv: Uint8Array, encrypted: Uint8Array, additionalData: Uint8Array): Promise<Uint8Array> {
  assertAesKeyLength(keyBytes, "AES-GCM key");
  if (iv.byteLength !== AES_GCM_IV_BYTES) {
    throw new Error("crypto.invalid_iv: AES-GCM iv must be 12 bytes");
  }
  try {
    const key = await crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(additionalData), tagLength: 128 },
      key,
      toArrayBuffer(encrypted)
    );
    return new Uint8Array(plain);
  } catch (error) {
    throw toCryptoError("crypto.aead_verify_failed", error);
  }
}

function buildChunkAad(headerBytes: Uint8Array, chunkIndex: number): Uint8Array {
  return concatBytes(textEncoder.encode("backup-object-chunk:v1:"), headerBytes, encodeBigUint64(chunkIndex));
}

function secureRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function assertAesKeyLength(value: Uint8Array, label: string): void {
  if (value.byteLength !== AES_GCM_KEY_BYTES) {
    throw new Error(`crypto.invalid_key: ${label} must be 32 bytes`);
  }
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("crypto.invalid_base64url: value must be unpadded base64url");
  }
  return copyBytes(Buffer.from(value, "base64url"));
}

function encodeLength(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error("crypto.invalid_length: length out of range");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function decodeLength(bytes: Uint8Array): number {
  if (bytes.byteLength !== 4) {
    throw new Error("crypto.invalid_length: length prefix must be 4 bytes");
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
}

function encodeBigUint64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output: Uint8Array = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function copyBytes(value: Bytes): Uint8Array {
  const output: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(value.byteLength));
  output.set(value);
  return output;
}

function toBytes(value: Bytes): Uint8Array {
  return copyBytes(value);
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = copyBytes(value);
  const buffer = new ArrayBuffer(copy.byteLength);
  new Uint8Array(buffer).set(copy);
  return buffer;
}

async function readAtLeastOrEnd(
  reader: ByteReader,
  initial: Bytes,
  length: number
): Promise<{ bytes: Uint8Array | null; remaining: Uint8Array }> {
  let pending = initial;
  while (pending.byteLength < length) {
    const read = await reader.read();
    if (read.done) {
      if (pending.byteLength === 0) {
        return { bytes: null, remaining: pending };
      }
      throw new Error("crypto.truncated_object: incomplete length prefix");
    }
    pending = concatBytes(pending, toBytes(read.value));
  }

  return { bytes: toBytes(pending.slice(0, length)), remaining: toBytes(pending.slice(length)) };
}

async function readExactly(
  reader: ByteReader,
  initial: Bytes,
  length: number
): Promise<{ bytes: Uint8Array; remaining: Uint8Array }> {
  let pending = initial;
  while (pending.byteLength < length) {
    const read = await reader.read();
    if (read.done) {
      throw new Error("crypto.truncated_object: encrypted object ended early");
    }
    pending = concatBytes(pending, toBytes(read.value));
  }

  return { bytes: toBytes(pending.slice(0, length)), remaining: toBytes(pending.slice(length)) };
}

function toCryptoError(code: string, cause: unknown): Error {
  if (cause instanceof Error && cause.message.startsWith("crypto.")) {
    return cause;
  }
  return new Error(`${code}: authenticated encrypted backup verification failed`);
}
