import { ApiError } from './errors';

export function validateAppMasterKey(value: string | undefined): Uint8Array {
  if (!value) {
    throw new ApiError(500, 'APP_MASTER_KEY_INVALID', 'APP_MASTER_KEY_V1 is required');
  }

  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApiError(500, 'APP_MASTER_KEY_INVALID', 'APP_MASTER_KEY_V1 must be base64url');
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== 32) {
    throw new ApiError(500, 'APP_MASTER_KEY_INVALID', 'APP_MASTER_KEY_V1 must decode to exactly 32 bytes');
  }

  return new Uint8Array(decoded);
}

export function readBooleanFlag(value: string | undefined, defaultValue = true): boolean {
  if (value === undefined || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
