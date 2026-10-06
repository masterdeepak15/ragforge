import { describe, it, expect } from 'vitest';
import { RateLimiter } from './rate-limit.js';

describe('RateLimiter', () => {
  it('allows a burst up to the per-minute limit and then refuses', () => {
    const rl = new RateLimiter(3, () => 0);
    expect([1, 2, 3].map(() => rl.take('k').ok)).toEqual([true, true, true]);
    const denied = rl.take('k');
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('refills continuously: one token per (60s / limit)', () => {
    let now = 0;
    const rl = new RateLimiter(6, () => now); // one token every 10 s
    for (let i = 0; i < 6; i++) rl.take('k');
    expect(rl.take('k').ok).toBe(false);
    now = 9_999;
    expect(rl.take('k').ok).toBe(false);
    now = 10_000;
    expect(rl.take('k').ok).toBe(true);
    expect(rl.take('k').ok).toBe(false);
  });

  it('never accumulates more than the limit while idle', () => {
    let now = 0;
    const rl = new RateLimiter(2, () => now);
    now = 10 * 60_000;
    expect([1, 2, 3].map(() => rl.take('k').ok)).toEqual([true, true, false]);
  });

  it('tracks keys independently', () => {
    const rl = new RateLimiter(1, () => 0);
    expect(rl.take('a').ok).toBe(true);
    expect(rl.take('a').ok).toBe(false);
    expect(rl.take('b').ok).toBe(true);
  });

  it('reports a retry delay that matches the refill rate', () => {
    const rl = new RateLimiter(1, () => 0); // one token per 60 s
    rl.take('k');
    expect(rl.take('k').retryAfterSec).toBe(60);
  });
});
