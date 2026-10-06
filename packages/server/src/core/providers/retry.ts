export interface RetryOptions {
  /** Retries after the first attempt. Default 4. */
  retries?: number;
  /** First backoff delay; doubles each retry (+ up to 25% jitter). Default 1000 ms. */
  baseMs?: number;
  /** Aborting stops any wait and rethrows. */
  signal?: AbortSignal;
}

const NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
]);

/** True for rate limits (429), server errors (5xx) and network-level failures. */
export function isRetryableError(err: any): boolean {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  if (err?.code && NETWORK_CODES.has(err.code)) return true;
  return /fetch failed|socket hang up|network error|timed? ?out/i.test(String(err?.message ?? ''));
}

function headerValue(headers: any, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? String(headers[key]) : undefined;
}

/** Delay requested by the server via `Retry-After` (seconds or HTTP date), if any. */
function retryAfterMs(err: any): number | undefined {
  const raw = headerValue(err?.headers ?? err?.response?.headers, 'retry-after');
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Runs `fn`, retrying transient failures with exponential backoff; rethrows the last error. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  const baseMs = opts.baseMs ?? 1000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryableError(err) || opts.signal?.aborted) throw err;
      const delay = retryAfterMs(err) ?? baseMs * 2 ** attempt * (1 + Math.random() * 0.25);
      await sleep(delay, opts.signal);
    }
  }
}
