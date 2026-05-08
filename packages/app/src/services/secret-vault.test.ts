import { describe, expect, test } from 'bun:test';
import { decryptSecret, encryptSecret, fingerprintSecret, maskSecret } from './secret-vault';

const masterKey = Buffer.from(new Uint8Array(32).fill(7)).toString('base64url');

describe('Secret Vault', () => {
  test('encrypts and decrypts secret', async () => {
    const encrypted = await encryptSecret('correct-horse-battery-staple', masterKey);

    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted).not.toContain('correct-horse');
    await expect(decryptSecret(encrypted, masterKey)).resolves.toBe('correct-horse-battery-staple');
  });

  test('uses random iv for same plaintext', async () => {
    const first = await encryptSecret('same-secret', masterKey);
    const second = await encryptSecret('same-secret', masterKey);

    expect(first).not.toBe(second);
    await expect(decryptSecret(first, masterKey)).resolves.toBe('same-secret');
    await expect(decryptSecret(second, masterKey)).resolves.toBe('same-secret');
  });

  test('fails decrypt when ciphertext is tampered', async () => {
    const encrypted = await encryptSecret('secret', masterKey);
    const [version, iv, ciphertext] = encrypted.split(':');
    const flipped = ciphertext!.startsWith('A') ? 'B' : 'A';
    const tampered = `${version}:${iv}:${flipped}${ciphertext!.slice(1)}` as typeof encrypted;

    await expect(decryptSecret(tampered, masterKey)).rejects.toThrow();
  });

  test('fingerprints without revealing secret', async () => {
    const first = await fingerprintSecret('secret');
    const second = await fingerprintSecret('secret');
    const other = await fingerprintSecret('other');

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).not.toContain('secret');
  });

  test('masks saved secrets', () => {
    expect(maskSecret(null)).toBeNull();
    expect(maskSecret('abc')).toBe('••••');
    expect(maskSecret('password1234')).toBe('••••1234');
  });
});
