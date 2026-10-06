/** An HTTP or network failure. `status` is 0 when the server could not be reached. */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  getToken: () => string | null;
  /** Called when a request that carried a token is rejected with 401 (session expired). */
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

type RawBody = FormData | Blob | ArrayBuffer | URLSearchParams | ReadableStream | string;
const isRawBody = (b: unknown): b is RawBody =>
  typeof b === 'string' || b instanceof FormData || b instanceof Blob || b instanceof ArrayBuffer || b instanceof URLSearchParams;

export interface RequestExtras {
  headers?: Record<string, string>;
  signal?: AbortSignal | null;
}

export function createApiClient(opts: ApiClientOptions) {
  const doFetch = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const base = opts.baseUrl ?? '';

  async function request<T>(method: string, path: string, body?: unknown, extras: RequestExtras = {}): Promise<T> {
    const token = opts.getToken();
    const headers: Record<string, string> = { ...(extras.headers ?? {}) };
    if (token) headers.Authorization = `Bearer ${token}`;

    const init: RequestInit = { method, headers, signal: extras.signal ?? undefined };
    if (body !== undefined) {
      if (isRawBody(body)) init.body = body as BodyInit;
      else {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }

    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, init);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
    }

    if (!res.ok) {
      let payload: unknown;
      let message = `Request failed (HTTP ${res.status})`;
      try {
        payload = await res.json();
        const text = (payload as { error?: string; message?: string })?.error ?? (payload as { message?: string })?.message;
        if (text) message = text;
      } catch {
        /* not JSON */
      }
      if (res.status === 401 && token) opts.onUnauthorized?.();
      throw new ApiError(res.status, message, payload);
    }

    if (res.status === 204) return undefined as T;
    const type = res.headers.get('content-type') ?? '';
    return (type.includes('application/json') ? res.json() : res.text()) as Promise<T>;
  }

  return {
    request,
    get: <T>(path: string, extras?: RequestExtras) => request<T>('GET', path, undefined, extras),
    post: <T>(path: string, body?: unknown, extras?: RequestExtras) => request<T>('POST', path, body ?? {}, extras),
    put: <T>(path: string, body?: unknown, extras?: RequestExtras) => request<T>('PUT', path, body ?? {}, extras),
    patch: <T>(path: string, body?: unknown, extras?: RequestExtras) => request<T>('PATCH', path, body ?? {}, extras),
    del: <T = void>(path: string, extras?: RequestExtras) => request<T>('DELETE', path, undefined, extras),
  };
}

export const UNAUTHORIZED_EVENT = 'ragforge:unauthorized';

function storedToken(): string | null {
  try {
    return localStorage.getItem('ragforge_token');
  } catch {
    return null;
  }
}

/** App-wide client: reads the stored session token and broadcasts when the session expires. */
export const api = createApiClient({
  getToken: storedToken,
  onUnauthorized: () => window.dispatchEvent(new Event(UNAUTHORIZED_EVENT)),
});
