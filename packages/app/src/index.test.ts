import { describe, expect, test } from 'bun:test';
import { ApiError } from '@backup-saas/shared';

Bun.env.API_ENABLED = 'false';
Bun.env.WORKER_ENABLED = 'false';
Bun.env.APP_MASTER_KEY_V1 = Buffer.from(new Uint8Array(32).fill(19)).toString('base64url');

describe('app error responses', () => {
  test('ApiError with retryAfterSeconds includes Retry-After header', async () => {
    const { apiErrorToResponse } = await import('./index');

    const response = apiErrorToResponse(new ApiError(429, 'PLAN_MANUAL_BACKUP_RATE_LIMITED', 'Rate limited', undefined, 3600));
    const body = await response.json() as { error: { code: string; message: string } };

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3600');
    expect(body.error.code).toBe('PLAN_MANUAL_BACKUP_RATE_LIMITED');
    expect(body.error.message).toBe('Rate limited');
  });

  test('ApiError without retryAfterSeconds omits Retry-After header', async () => {
    const { apiErrorToResponse } = await import('./index');

    const response = apiErrorToResponse(new ApiError(403, 'FORBIDDEN', 'Denied'));

    expect(response.status).toBe(403);
    expect(response.headers.get('retry-after')).toBeNull();
  });
});
