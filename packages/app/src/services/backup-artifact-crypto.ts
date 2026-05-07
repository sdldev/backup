import { validateAppMasterKey } from '@backup-saas/shared';

const VERSION = 'backup-artifact-v1';
const STREAM_VERSION = 'backup-artifact-stream-v1';
const STREAM_NDJSON_VERSION = 'backup-artifact-stream-ndjson-v1';
const DEFAULT_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

type EncryptedArtifactEnvelope = {
  version: typeof VERSION;
  iv: string;
  ciphertext: string;
};

type StreamArtifactEnvelope = {
  version: typeof STREAM_VERSION;
  chunkSizeBytes: number;
  chunks: Array<{ index: number; iv: string; ciphertext: string }>;
};

type StreamNdjsonHeader = {
  version: typeof STREAM_NDJSON_VERSION;
  chunkSizeBytes: number;
};

type StreamNdjsonChunk = {
  index: number;
  iv: string;
  ciphertext: string;
};

async function importKey() {
  const rawKey = validateAppMasterKey(Bun.env.APP_MASTER_KEY_V1);
  const keyBytes = new Uint8Array(rawKey);
  return crypto.subtle.importKey('raw', keyBytes.buffer as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function chunkAad(version: string, index: number, chunkSizeBytes: number) {
  return ENCODER.encode(`${version}:${chunkSizeBytes}:${index}`);
}

export async function encryptBackupArtifact(plaintext: Uint8Array): Promise<Uint8Array> {
  const key = await importKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: ENCODER.encode(VERSION) },
    key,
    new Uint8Array(plaintext).buffer as ArrayBuffer,
  );
  const envelope: EncryptedArtifactEnvelope = {
    version: VERSION,
    iv: Buffer.from(iv).toString('base64url'),
    ciphertext: Buffer.from(ciphertext).toString('base64url'),
  };
  return ENCODER.encode(JSON.stringify(envelope));
}

export function encryptBackupArtifactStreamEnvelope(stream: ReadableStream<Uint8Array>, options: { chunkSizeBytes?: number; onPlaintextChunk?: (chunk: Uint8Array) => void } = {}): ReadableStream<Uint8Array> {
  return encryptBackupArtifactNdjsonStream(stream, options);
}

export function encryptBackupArtifactNdjsonStream(stream: ReadableStream<Uint8Array>, options: { chunkSizeBytes?: number; onPlaintextChunk?: (chunk: Uint8Array) => void } = {}): ReadableStream<Uint8Array> {
  const chunkSizeBytes = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) throw new Error('Invalid Backup artifact chunk size');

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const key = await importKey();
        let buffer = new Uint8Array(0);
        let index = 0;

        controller.enqueue(ENCODER.encode(`${JSON.stringify({ version: STREAM_NDJSON_VERSION, chunkSizeBytes } satisfies StreamNdjsonHeader)}\n`));

        async function flushChunk(plaintextChunk: Uint8Array) {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: chunkAad(STREAM_NDJSON_VERSION, index, chunkSizeBytes) },
            key,
            new Uint8Array(plaintextChunk).buffer as ArrayBuffer,
          );
          const record: StreamNdjsonChunk = { index, iv: Buffer.from(iv).toString('base64url'), ciphertext: Buffer.from(ciphertext).toString('base64url') };
          controller.enqueue(ENCODER.encode(`${JSON.stringify(record)}\n`));
          index += 1;
        }

        for await (const chunk of stream) {
          options.onPlaintextChunk?.(chunk);
          const combined = new Uint8Array(buffer.byteLength + chunk.byteLength);
          combined.set(buffer, 0);
          combined.set(chunk, buffer.byteLength);
          buffer = combined;

          while (buffer.byteLength >= chunkSizeBytes) {
            await flushChunk(buffer.slice(0, chunkSizeBytes));
            buffer = buffer.slice(chunkSizeBytes);
          }
        }

        await flushChunk(buffer);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

export async function encryptBackupArtifactStream(stream: ReadableStream<Uint8Array>, options: { chunkSizeBytes?: number; onPlaintextChunk?: (chunk: Uint8Array) => void } = {}): Promise<Uint8Array> {
  const chunkSizeBytes = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) throw new Error('Invalid Backup artifact chunk size');

  const key = await importKey();
  const chunks: StreamArtifactEnvelope['chunks'] = [];
  let buffer = new Uint8Array(0);
  let index = 0;

  async function flushChunk(plaintextChunk: Uint8Array) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: chunkAad(STREAM_VERSION, index, chunkSizeBytes) },
      key,
      new Uint8Array(plaintextChunk).buffer as ArrayBuffer,
    );
    chunks.push({ index, iv: Buffer.from(iv).toString('base64url'), ciphertext: Buffer.from(ciphertext).toString('base64url') });
    index += 1;
  }

  for await (const chunk of stream) {
    options.onPlaintextChunk?.(chunk);
    const combined = new Uint8Array(buffer.byteLength + chunk.byteLength);
    combined.set(buffer, 0);
    combined.set(chunk, buffer.byteLength);
    buffer = combined;

    while (buffer.byteLength >= chunkSizeBytes) {
      await flushChunk(buffer.slice(0, chunkSizeBytes));
      buffer = buffer.slice(chunkSizeBytes);
    }
  }

  await flushChunk(buffer);

  const envelope: StreamArtifactEnvelope = { version: STREAM_VERSION, chunkSizeBytes, chunks };
  return ENCODER.encode(JSON.stringify(envelope));
}

export function decryptBackupArtifactObjectStream(encryptedStream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const reader = encryptedStream.getReader();
        const first = await reader.read();
        if (first.done) throw new Error('Invalid Backup artifact version');
        const firstText = DECODER.decode(first.value, { stream: true });
        if (!firstText.startsWith('{"version":"backup-artifact-stream-ndjson-v1"')) {
          const chunks = [first.value];
          let total = first.value.byteLength;
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            chunks.push(next.value);
            total += next.value.byteLength;
          }
          controller.enqueue(await decryptBackupArtifact(concatChunks(chunks, total)));
          controller.close();
          return;
        }

        const key = await importKey();
        let pending = firstText;
        let header: StreamNdjsonHeader | null = null;
        let expectedIndex = 0;

        async function processLine(line: string) {
          if (!line) return;
          if (!header) {
            header = JSON.parse(line) as StreamNdjsonHeader;
            if (header.version !== STREAM_NDJSON_VERSION) throw new Error('Invalid Backup artifact version');
            if (!Number.isSafeInteger(header.chunkSizeBytes) || header.chunkSizeBytes <= 0) throw new Error('Invalid Backup artifact chunk size');
            return;
          }
          const chunk = JSON.parse(line) as StreamNdjsonChunk;
          if (chunk.index !== expectedIndex) throw new Error('Invalid Backup artifact chunk order');
          const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: Buffer.from(chunk.iv, 'base64url'), additionalData: chunkAad(STREAM_NDJSON_VERSION, chunk.index, header.chunkSizeBytes) },
            key,
            Buffer.from(chunk.ciphertext, 'base64url'),
          );
          controller.enqueue(new Uint8Array(plaintext));
          expectedIndex += 1;
        }

        while (true) {
          let newline = pending.indexOf('\n');
          while (newline >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            await processLine(line);
            newline = pending.indexOf('\n');
          }
          const next = await reader.read();
          if (next.done) break;
          pending += DECODER.decode(next.value, { stream: true });
        }
        pending += DECODER.decode();
        if (pending.length > 0) await processLine(pending);
        if (!header) throw new Error('Invalid Backup artifact version');
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

export function decryptBackupArtifactToStream(envelopeBytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const plaintext = await decryptBackupArtifact(envelopeBytes);
        controller.enqueue(plaintext);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

export async function decryptBackupArtifact(envelopeBytes: Uint8Array): Promise<Uint8Array> {
  const text = DECODER.decode(envelopeBytes);
  if (text.startsWith('{"version":"backup-artifact-stream-ndjson-v1"')) return decryptBackupArtifactNdjson(text);

  const envelope = JSON.parse(text) as EncryptedArtifactEnvelope | StreamArtifactEnvelope;
  if (envelope.version === STREAM_VERSION) return decryptBackupArtifactStreamEnvelope(envelope);
  if (envelope.version !== VERSION) throw new Error('Invalid Backup artifact version');

  const key = await importKey();
  const iv = Buffer.from(envelope.iv, 'base64url');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: ENCODER.encode(VERSION) },
    key,
    ciphertext,
  );
  return new Uint8Array(plaintext);
}

async function decryptBackupArtifactNdjson(text: string): Promise<Uint8Array> {
  const lines = text.split('\n').filter((line) => line.length > 0);
  const header = JSON.parse(lines[0] ?? '{}') as StreamNdjsonHeader;
  if (header.version !== STREAM_NDJSON_VERSION) throw new Error('Invalid Backup artifact version');
  if (!Number.isSafeInteger(header.chunkSizeBytes) || header.chunkSizeBytes <= 0) throw new Error('Invalid Backup artifact chunk size');

  const key = await importKey();
  const plaintextChunks: Uint8Array[] = [];
  let total = 0;
  for (const line of lines.slice(1)) {
    const chunk = JSON.parse(line) as StreamNdjsonChunk;
    if (chunk.index !== plaintextChunks.length) throw new Error('Invalid Backup artifact chunk order');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(chunk.iv, 'base64url'), additionalData: chunkAad(STREAM_NDJSON_VERSION, chunk.index, header.chunkSizeBytes) },
      key,
      Buffer.from(chunk.ciphertext, 'base64url'),
    );
    const bytes = new Uint8Array(plaintext);
    plaintextChunks.push(bytes);
    total += bytes.byteLength;
  }
  return concatChunks(plaintextChunks, total);
}

async function decryptBackupArtifactStreamEnvelope(envelope: StreamArtifactEnvelope): Promise<Uint8Array> {
  if (!Number.isSafeInteger(envelope.chunkSizeBytes) || envelope.chunkSizeBytes <= 0) throw new Error('Invalid Backup artifact chunk size');

  const key = await importKey();
  const plaintextChunks: Uint8Array[] = [];
  let total = 0;
  for (const chunk of envelope.chunks) {
    if (chunk.index !== plaintextChunks.length) throw new Error('Invalid Backup artifact chunk order');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(chunk.iv, 'base64url'), additionalData: chunkAad(STREAM_VERSION, chunk.index, envelope.chunkSizeBytes) },
      key,
      Buffer.from(chunk.ciphertext, 'base64url'),
    );
    const bytes = new Uint8Array(plaintext);
    plaintextChunks.push(bytes);
    total += bytes.byteLength;
  }
  return concatChunks(plaintextChunks, total);
}

function concatChunks(chunks: Uint8Array[], total: number) {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readStreamToUint8Array(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  return concatChunks(chunks, total);
}
