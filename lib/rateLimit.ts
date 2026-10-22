/**
 * Minimal in-memory sliding-window rate limiter for the public chat endpoint.
 *
 * Limits are per server instance (serverless instances don't share memory), so this is a speed bump against
 * scripts hammering one instance and burning Claude credits — not a hard global cap. For a hard cap, back it
 * with a shared store (Upstash/Redis/Vercel KV) behind the same two functions.
 */
const hits = new Map<string, number[]>();
const MAX_TRACKED_KEYS = 5_000;

export function checkRateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000)) };
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > MAX_TRACKED_KEYS) {
    // Drop the oldest-inserted keys so memory can't grow without bound.
    Array.from(hits.keys())
      .slice(0, hits.size - MAX_TRACKED_KEYS)
      .forEach((k) => hits.delete(k));
  }
  return { ok: true, retryAfterSec: 0 };
}

/** Caller IP as set by the host's proxy (Vercel sets x-forwarded-for); "unknown" when there is none. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}
