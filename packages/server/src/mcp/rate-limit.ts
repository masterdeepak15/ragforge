export interface RateDecision {
  ok: boolean;
  /** Whole seconds until a request would be allowed (0 when ok). */
  retryAfterSec: number;
}

/**
 * Per-key token bucket: holds up to `perMinute` tokens and refills continuously, so a client can
 * burst up to the limit and then sustain `perMinute` requests per minute.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(private perMinute: number, private now: () => number = Date.now) {}

  take(key: string): RateDecision {
    const now = this.now();
    const ratePerMs = this.perMinute / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: this.perMinute, updatedAt: now };
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + (now - bucket.updatedAt) * ratePerMs);
    bucket.updatedAt = now;

    let decision: RateDecision;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      decision = { ok: true, retryAfterSec: 0 };
    } else {
      decision = { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / ratePerMs / 1000)) };
    }
    this.buckets.set(key, bucket);
    return decision;
  }
}
