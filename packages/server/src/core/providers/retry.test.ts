import { describe, it, expect } from 'vitest';
import { withRetry, isRetryableError } from './retry.js';

const httpError = (status: number, headers?: Record<string, string>) => Object.assign(new Error(`HTTP ${status}`), { status, headers });

describe('isRetryableError', () => {
  it.each([[429], [500], [502], [503], [504]])('retries HTTP %i', (status) => {
    expect(isRetryableError(httpError(status))).toBe(true);
  });
  it.each([[400], [401], [403], [404], [422]])('does not retry HTTP %i', (status) => {
    expect(isRetryableError(httpError(status))).toBe(false);
  });
  it('retries network-level failures', () => {
    expect(isRetryableError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
  });
  it('does not retry plain errors', () => {
    expect(isRetryableError(new Error('bad input'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the result after transient failures', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw httpError(429);
        return 'ok';
      },
      { baseMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the configured number of retries and throws the last error', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw httpError(503);
        },
        { retries: 2, baseMs: 1 },
      ),
    ).rejects.toThrow('HTTP 503');
    expect(calls).toBe(3);
  });

  it('does not retry client errors', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw httpError(401);
      }, { baseMs: 1 }),
    ).rejects.toThrow('HTTP 401');
    expect(calls).toBe(1);
  });

  it('honours Retry-After instead of the exponential delay', async () => {
    let calls = 0;
    const started = Date.now();
    await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw httpError(429, { 'retry-after': '0' });
        return 'ok';
      },
      { baseMs: 60_000 },
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stops waiting when the abort signal fires', async () => {
    const controller = new AbortController();
    const promise = withRetry(async () => {
      throw httpError(503);
    }, { baseMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toThrow();
  });
});
