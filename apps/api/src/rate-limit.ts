export type RateLimitBucket = "auth" | "backup_action" | "download_token";

export type RateLimitConfig = {
  windowMs: number;
  max: number;
};

type RateLimitState = {
  count: number;
  resetAt: number;
};

const defaults: Record<RateLimitBucket, RateLimitConfig> = {
  auth: { windowMs: 60_000, max: 20 },
  backup_action: { windowMs: 60_000, max: 10 },
  download_token: { windowMs: 60_000, max: 5 }
};

const buckets = new Map<string, RateLimitState>();

export function resetRateLimitsForTests(): void {
  buckets.clear();
}

export function rateLimitKey(parts: Array<string | null | undefined>): string {
  return parts.map((part) => part && part.length > 0 ? part : "anonymous").join(":");
}

export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export function checkRateLimit(bucket: RateLimitBucket, key: string, config: Partial<RateLimitConfig> = {}, now = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const resolved = { ...defaults[bucket], ...config };
  const mapKey = `${bucket}:${key}`;
  const current = buckets.get(mapKey);

  if (!current || current.resetAt <= now) {
    buckets.set(mapKey, { count: 1, resetAt: now + resolved.windowMs });
    return { ok: true };
  }

  if (current.count >= resolved.max) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }

  current.count += 1;
  return { ok: true };
}

export function rateLimitResponse(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: { code: "rate_limit.exceeded" } }), {
    status: 429,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(retryAfterSeconds)
    }
  });
}
