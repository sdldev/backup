import { describe, expect, test } from 'bun:test';
import { decryptBackupArtifact, decryptBackupArtifactObjectStream, decryptBackupArtifactToStream, encryptBackupArtifact, encryptBackupArtifactStream, encryptBackupArtifactStreamEnvelope } from './backup-artifact-crypto';

Bun.env.APP_MASTER_KEY_V1 = Buffer.from(new Uint8Array(32).fill(11)).toString('base64url');

describe('Backup artifact crypto', () => {
  test('decrypts encrypted Backup artifact', async () => {
    const plaintext = new TextEncoder().encode('manual backup artifact');
    const encrypted = await encryptBackupArtifact(plaintext);

    const decrypted = await decryptBackupArtifact(encrypted);

    expect(new TextDecoder().decode(decrypted)).toBe('manual backup artifact');
  });

  test('rejects tampered ciphertext', async () => {
    const plaintext = new TextEncoder().encode('manual backup artifact');
    const encrypted = await encryptBackupArtifact(plaintext);
    const envelope = JSON.parse(new TextDecoder().decode(encrypted)) as { version: string; iv: string; ciphertext: string };
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
    const lastIndex = ciphertext.length - 1;
    ciphertext[lastIndex] = (ciphertext[lastIndex] ?? 0) ^ 1;
    envelope.ciphertext = ciphertext.toString('base64url');

    await expect(decryptBackupArtifact(new TextEncoder().encode(JSON.stringify(envelope)))).rejects.toThrow();
  });

  test('encrypts and decrypts chunked stream artifacts', async () => {
    const plaintext = new TextEncoder().encode('chunk-one|chunk-two|chunk-three');
    const encrypted = await encryptBackupArtifactStream(new Response(plaintext).body!, { chunkSizeBytes: 10 });
    const envelope = JSON.parse(new TextDecoder().decode(encrypted)) as { version: string; chunkSizeBytes: number; chunks: unknown[] };

    expect(envelope.version).toBe('backup-artifact-stream-v1');
    expect(envelope.chunkSizeBytes).toBe(10);
    expect(envelope.chunks.length).toBe(4);

    const decrypted = await decryptBackupArtifact(encrypted);
    expect(new TextDecoder().decode(decrypted)).toBe('chunk-one|chunk-two|chunk-three');
  });

  test('emits encrypted stream envelope as a readable stream', async () => {
    const plaintext = new TextEncoder().encode('stream-envelope-output');
    const encryptedStream = encryptBackupArtifactStreamEnvelope(new Response(plaintext).body!, { chunkSizeBytes: 7 });
    const encrypted = new Uint8Array(await new Response(encryptedStream).arrayBuffer());

    const decrypted = await decryptBackupArtifact(encrypted);
    expect(new TextDecoder().decode(decrypted)).toBe('stream-envelope-output');
  });

  test('decrypts NDJSON object stream to plaintext stream', async () => {
    const encryptedStream = encryptBackupArtifactStreamEnvelope(new Response(new TextEncoder().encode('ndjson-stream-decrypt')).body!, { chunkSizeBytes: 6 });
    const plaintextStream = decryptBackupArtifactObjectStream(encryptedStream);

    expect(await new Response(plaintextStream).text()).toBe('ndjson-stream-decrypt');
  });

  test('decrypts NDJSON object stream split across transport chunks', async () => {
    const encryptedBytes = new Uint8Array(await new Response(encryptBackupArtifactStreamEnvelope(new Response(new TextEncoder().encode('split-transport-chunks')).body!, { chunkSizeBytes: 5 })).arrayBuffer());
    const encryptedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < encryptedBytes.byteLength; i += 3) controller.enqueue(encryptedBytes.slice(i, i + 3));
        controller.close();
      },
    });

    expect(await new Response(decryptBackupArtifactObjectStream(encryptedStream)).text()).toBe('split-transport-chunks');
  });

  test('decrypts legacy object stream to plaintext stream', async () => {
    const encrypted = await encryptBackupArtifact(new TextEncoder().encode('legacy-stream-decrypt'));
    const plaintextStream = decryptBackupArtifactObjectStream(new Response(encrypted).body!);

    expect(await new Response(plaintextStream).text()).toBe('legacy-stream-decrypt');
  });

  test('decrypts artifact to readable stream', async () => {
    const encrypted = await encryptBackupArtifactStream(new Response(new TextEncoder().encode('download-stream')).body!, { chunkSizeBytes: 5 });
    const plaintextStream = decryptBackupArtifactToStream(encrypted);

    expect(await new Response(plaintextStream).text()).toBe('download-stream');
  });

  test('reports plaintext bytes while encrypting stream', async () => {
    const plaintext = new TextEncoder().encode('count-me');
    let counted = 0;

    await encryptBackupArtifactStream(new Response(plaintext).body!, {
      chunkSizeBytes: 3,
      onPlaintextChunk: (chunk) => { counted += chunk.byteLength; },
    });

    expect(counted).toBe(8);
  });

  test('rejects tampered stream chunk ciphertext', async () => {
    const encrypted = await encryptBackupArtifactStream(new Response(new TextEncoder().encode('stream tamper')).body!, { chunkSizeBytes: 6 });
    const envelope = JSON.parse(new TextDecoder().decode(encrypted)) as { chunks: Array<{ ciphertext: string }> };
    const ciphertext = Buffer.from(envelope.chunks[0]!.ciphertext, 'base64url');
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    envelope.chunks[0]!.ciphertext = ciphertext.toString('base64url');

    await expect(decryptBackupArtifact(new TextEncoder().encode(JSON.stringify(envelope)))).rejects.toThrow();
  });

  test('rejects reordered stream chunks', async () => {
    const encrypted = await encryptBackupArtifactStream(new Response(new TextEncoder().encode('chunk-order-check')).body!, { chunkSizeBytes: 6 });
    const envelope = JSON.parse(new TextDecoder().decode(encrypted)) as { chunks: Array<{ index: number }> };
    [envelope.chunks[0], envelope.chunks[1]] = [envelope.chunks[1]!, envelope.chunks[0]!];

    await expect(decryptBackupArtifact(new TextEncoder().encode(JSON.stringify(envelope)))).rejects.toThrow('Invalid Backup artifact chunk order');
  });

  test('rejects tampered artifact version', async () => {
    const encrypted = await encryptBackupArtifact(new TextEncoder().encode('manual backup artifact'));
    const envelope = JSON.parse(new TextDecoder().decode(encrypted)) as { version: string; iv: string; ciphertext: string };
    envelope.version = 'backup-artifact-v0';

    await expect(decryptBackupArtifact(new TextEncoder().encode(JSON.stringify(envelope)))).rejects.toThrow('Invalid Backup artifact version');
  });
});
