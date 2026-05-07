import { describe, expect, test } from 'bun:test';
import { createOAuthState, safeReturnTo, verifyOAuthState } from './auth';

Bun.env.APP_MASTER_KEY_V1 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64url');

describe('OAuth auth helpers', () => {
  test('safeReturnTo accepts only relative paths', () => {
    expect(safeReturnTo('/app')).toBe('/app');
    expect(safeReturnTo('/workspace/demo')).toBe('/workspace/demo');
    expect(safeReturnTo('https://evil.test/app')).toBe('/app');
    expect(safeReturnTo('//evil.test/app')).toBe('/app');
    expect(safeReturnTo('/login?next=https://evil.test')).toBe('/app');
  });

  test('signed OAuth state verifies matching cookie and returns safe path', async () => {
    const state = await createOAuthState('/workspace/demo');
    await expect(verifyOAuthState(state.state, state.cookieValue)).resolves.toBe('/workspace/demo');
  });

  test('signed OAuth state rejects cookie mismatch', async () => {
    const state = await createOAuthState('/workspace/demo');
    await expect(verifyOAuthState(state.state, 'wrong-cookie')).resolves.toBeNull();
  });

  test('signed OAuth state rejects tampering', async () => {
    const state = await createOAuthState('/workspace/demo');
    const parts = state.state.split('.');
    parts[1] = Buffer.from('/workspace/other').toString('base64url');
    await expect(verifyOAuthState(parts.join('.'), state.cookieValue)).resolves.toBeNull();
  });
});
