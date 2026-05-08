import { validateAppMasterKey } from '@backup-saas/shared';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const VAULT_VERSION = 'v1';

export type EncryptedSecret = `${typeof VAULT_VERSION}:${string}:${string}`;

export async function encryptSecret(plaintext: string, masterKey = Bun.env.APP_MASTER_KEY_V1): Promise<EncryptedSecret> {
  const key = await importAesKey(validateAppMasterKey(masterKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, TEXT_ENCODER.encode(plaintext));

  return `${VAULT_VERSION}:${Buffer.from(iv).toString('base64url')}:${Buffer.from(ciphertext).toString('base64url')}`;
}

export async function decryptSecret(encrypted: EncryptedSecret, masterKey = Bun.env.APP_MASTER_KEY_V1): Promise<string> {
  const [version, ivText, ciphertextText] = encrypted.split(':');
  if (version !== VAULT_VERSION || !ivText || !ciphertextText) {
    throw new Error('Invalid encrypted secret format');
  }

  const key = await importAesKey(validateAppMasterKey(masterKey));
  const iv = Buffer.from(ivText, 'base64url');
  const ciphertext = Buffer.from(ciphertextText, 'base64url');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

  return TEXT_DECODER.decode(plaintext);
}

export async function fingerprintSecret(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(plaintext));
  return `sha256:${Buffer.from(digest).toString('base64url')}`;
}

export function maskSecret(secret: string | null | undefined): string | null {
  if (!secret) return null;
  if (secret.length <= 4) return '••••';
  return `••••${secret.slice(-4)}`;
}

async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  const keyBytes = new Uint8Array(rawKey);
  return crypto.subtle.importKey('raw', keyBytes.buffer as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
