import { describe, expect, test } from 'bun:test';
import { clearSessionCookie, makeSessionCookie } from './sessions';

describe('session cookies', () => {
  test('session cookie is httpOnly SameSite Lax path scoped', () => {
    Bun.env.SESSION_COOKIE_SECURE = 'false';
    const cookie = makeSessionCookie('token-value', 60);
    expect(cookie).toContain('backup_saas_session=token-value');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=60');
    expect(cookie).not.toContain('Secure');
  });

  test('secure cookie flag follows env', () => {
    Bun.env.SESSION_COOKIE_SECURE = 'true';
    expect(makeSessionCookie('token-value')).toContain('Secure');
    Bun.env.SESSION_COOKIE_SECURE = 'false';
  });

  test('clear session cookie expires session cookie', () => {
    Bun.env.SESSION_COOKIE_SECURE = 'false';
    expect(clearSessionCookie()).toContain('Max-Age=0');
  });
});
