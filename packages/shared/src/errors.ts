export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'RESOURCE_NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE_ENTITY'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'APP_MASTER_KEY_INVALID';

export type ApiErrorResponse = {
  error: {
    code: ApiErrorCode | (string & {});
    message: string;
    reference?: string;
  };
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode | (string & {}),
    message: string,
    public readonly reference?: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function createErrorReference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `err_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function toApiErrorResponse(error: ApiError): ApiErrorResponse {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.reference ? { reference: error.reference } : {}),
    },
  };
}
