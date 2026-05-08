import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { ApiError } from '@backup-saas/shared';

export type ObjectStorageObject = {
  key: string;
  body: ReadableStream<Uint8Array>;
  contentLength?: number;
  contentType?: string;
};

export type ObjectStoragePutResult = {
  storedBytes: number;
};

export type ObjectStorageProvider = {
  putObject(object: ObjectStorageObject): Promise<ObjectStoragePutResult>;
  getObject(key: string): Promise<ReadableStream<Uint8Array>>;
  deleteObject(key: string): Promise<void>;
  healthCheck(): Promise<'ready'>;
};

function safeLocalPath(root: string, key: string) {
  const resolvedRoot = normalize(root);
  const resolvedPath = normalize(join(resolvedRoot, key));
  if (!resolvedPath.startsWith(resolvedRoot)) {
    throw new ApiError(400, 'INVALID_OBJECT_KEY', 'Object key is invalid');
  }
  return resolvedPath;
}

export class LocalObjectStorageProvider implements ObjectStorageProvider {
  constructor(private readonly rootDir: string) {}

  async putObject(object: ObjectStorageObject) {
    const path = safeLocalPath(this.rootDir, object.key);
    await mkdir(dirname(path), { recursive: true });
    let storedBytes = 0;
    await new Promise<void>((resolve, reject) => {
      const writer = createWriteStream(path);
      writer.on('error', reject);
      writer.on('finish', resolve);
      void (async () => {
        try {
          for await (const chunk of object.body) {
            storedBytes += chunk.byteLength;
            if (!writer.write(chunk)) await new Promise((drainResolve) => writer.once('drain', drainResolve));
          }
          writer.end();
        } catch (error) {
          writer.destroy(error instanceof Error ? error : new Error('Object stream write failed'));
          reject(error);
        }
      })();
    });
    return { storedBytes };
  }

  async getObject(key: string) {
    const path = safeLocalPath(this.rootDir, key);
    const file = Bun.file(path);
    if (!(await file.exists())) throw new ApiError(404, 'OBJECT_NOT_FOUND', 'Backup object not found');
    return file.stream();
  }

  async deleteObject(key: string) {
    const path = safeLocalPath(this.rootDir, key);
    const file = Bun.file(path);
    if (await file.exists()) await file.delete();
  }

  async healthCheck() {
    await mkdir(this.rootDir, { recursive: true });
    return 'ready' as const;
  }
}

export class StorageNotImplementedProvider implements ObjectStorageProvider {
  async putObject(): Promise<ObjectStoragePutResult> {
    throw new ApiError(501, 'OBJECT_STORAGE_NOT_IMPLEMENTED', 'Object Storage provider is not implemented yet');
  }

  async getObject(): Promise<ReadableStream<Uint8Array>> {
    throw new ApiError(501, 'OBJECT_STORAGE_NOT_IMPLEMENTED', 'Object Storage provider is not implemented yet');
  }

  async deleteObject() {
    throw new ApiError(501, 'OBJECT_STORAGE_NOT_IMPLEMENTED', 'Object Storage provider is not implemented yet');
  }

  async healthCheck() {
    return 'ready' as const;
  }
}

export function createObjectStorageProvider(): ObjectStorageProvider {
  if (Bun.env.OBJECT_STORAGE_PROVIDER === 'local') {
    return new LocalObjectStorageProvider(Bun.env.OBJECT_STORAGE_LOCAL_DIR ?? '.storage/backups');
  }
  return new StorageNotImplementedProvider();
}
