/**
 * Legacy request helpers, kept so existing pages keep working. They delegate to the typed client in
 * `api-client.ts` (token header, ApiError, sign-out on expired session). Prefer `api` in new code.
 */
import { api, ApiError } from './api-client';

function getToken(): string | null {
  try {
    return localStorage.getItem('ragforge_token');
  } catch {
    return null;
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem('ragforge_token', token);
  } catch {
    /* storage unavailable */
  }
}

export function clearToken() {
  try {
    localStorage.removeItem('ragforge_token');
    localStorage.removeItem('ragforge_user');
  } catch {
    /* storage unavailable */
  }
}

interface FetchOptions extends RequestInit {
  json?: unknown;
}

export async function apiFetch<T = unknown>(path: string, options: FetchOptions = {}): Promise<T> {
  const { json, method, headers, body, signal } = options;
  return api.request<T>(method ?? (json !== undefined || body ? 'POST' : 'GET'), path, json !== undefined ? json : (body ?? undefined), {
    headers: headers as Record<string, string> | undefined,
    signal,
  });
}

export async function apiUpload<T = unknown>(path: string, formData: FormData): Promise<T> {
  return api.request<T>('POST', path, formData);
}

export async function* apiStream(path: string, body: unknown): AsyncGenerator<unknown, void, unknown> {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    throw new ApiError(res.status, `Could not start the response (HTTP ${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.replace(/^data: /, '').trim();
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* ignore a malformed event */
      }
    }
  }
}
