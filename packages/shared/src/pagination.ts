export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;

export type CursorPagination<T> = {
  data: T[];
  pagination: {
    next_cursor: string | null;
    has_more: boolean;
  };
};

export function normalizePageLimit(input: unknown): number {
  const parsed = typeof input === 'string' ? Number.parseInt(input, 10) : Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.trunc(parsed), MAX_PAGE_LIMIT);
}

export function encodeCursor(value: Record<string, unknown>): string {
  return btoa(JSON.stringify(value));
}

export function decodeCursor(cursor: string | null | undefined): Record<string, unknown> | null {
  if (!cursor) return null;

  try {
    const decoded = JSON.parse(atob(cursor));
    if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) return decoded;
  } catch {
    return null;
  }

  return null;
}
