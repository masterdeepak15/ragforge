import { vi } from 'vitest';

type Handler = (url: URL, init: RequestInit) => unknown | Response | Promise<unknown | Response>;
export interface Route {
  method: string;
  path: string | RegExp;
  handler: Handler;
}

export interface RecordedCall {
  method: string;
  url: URL;
  body: any;
}

/**
 * Routes `fetch` calls by method and path. A handler returns a JSON-serialisable value (200),
 * a Response, or `undefined` for 204. Unmatched calls fail the test loudly.
 */
export function mockFetch(routes: Route[]) {
  const calls: RecordedCall[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init.method ?? 'GET').toUpperCase();
    let body: unknown = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* leave as string */
      }
    }
    calls.push({ method, url, body });
    const route = routes.find((r) => r.method === method && (typeof r.path === 'string' ? r.path === url.pathname : r.path.test(url.pathname)));
    if (!route) throw new Error(`Unmocked fetch: ${method} ${url.pathname}${url.search}`);
    const out = await route.handler(url, init);
    if (out instanceof Response) return out;
    if (out === undefined) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { calls, spy, find: (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.url.pathname)) };
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
