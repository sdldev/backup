import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { LocalObjectStorageProvider } from './object-storage';

function streamFromChunks(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('Local object storage', () => {
  test('writes streamed object incrementally and returns stored byte count', async () => {
    const root = join('/tmp', `backup-saas-storage-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    try {
      const storage = new LocalObjectStorageProvider(root);
      const result = await storage.putObject({ key: 'workspace/one/object.txt', body: streamFromChunks(['alpha', '-', 'beta']) });

      expect(result.storedBytes).toBe(10);
      const stored = await storage.getObject('workspace/one/object.txt');
      expect(await new Response(stored).text()).toBe('alpha-beta');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
