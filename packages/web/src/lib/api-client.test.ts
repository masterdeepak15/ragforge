import { describe, it, expect, vi } from 'vitest';
import { ApiError, createApiClient } from './api-client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(fetchImpl: typeof fetch, token: string | null = 'tok') {
  const onUnauthorized = vi.fn();
  const api = createApiClient({ fetchImpl, getToken: () => token, onUnauthorized });
  return { api, onUnauthorized };
}

describe('createApiClient', () => {
  it('sends the bearer token and parses JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ id: 'kb1' }]));
    const { api } = setup(fetchImpl);
    const result = await api.get<Array<{ id: string }>>('/api/knowledge-bases');
    expect(result).toEqual([{ id: 'kb1' }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/knowledge-bases');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('omits the Authorization header when signed out', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const { api } = setup(fetchImpl, null);
    await api.get('/api/setup/status');
    expect((fetchImpl.mock.calls[0][1].headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('serialises JSON bodies with a content type', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 'k' }, 201));
    const { api } = setup(fetchImpl);
    await api.post('/api/api-keys', { name: 'cursor' });
    const init = fetchImpl.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'cursor' }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('turns an error response into an ApiError carrying status and the server message', async () => {
    const { api } = setup(vi.fn().mockResolvedValue(jsonResponse({ error: 'Unknown knowledge base: x' }, 400)));
    const err = await api.post('/api/api-keys', {}).catch((e: unknown) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, message: 'Unknown knowledge base: x' });
  });

  it('falls back to a readable message when the error body is not JSON', async () => {
    const { api } = setup(vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 })));
    const err = (await api.get('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ status: 502, message: 'Request failed (HTTP 502)' });
  });

  it('signals sign-out on 401', async () => {
    const { api, onUnauthorized } = setup(vi.fn().mockResolvedValue(jsonResponse({ error: 'Authentication required' }, 401)));
    await expect(api.get('/api/auth/me')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not treat a failed login as an expired session', async () => {
    const { api, onUnauthorized } = setup(vi.fn().mockResolvedValue(jsonResponse({ error: 'Invalid credentials' }, 401)), null);
    await expect(api.post('/api/auth/login', { email: 'a', password: 'b' })).rejects.toMatchObject({ message: 'Invalid credentials' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('returns undefined for 204 responses', async () => {
    const { api } = setup(vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api.del('/api/api-keys/1')).resolves.toBeUndefined();
  });

  it('reports network failures as ApiError with status 0', async () => {
    const { api } = setup(vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = (await api.get('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/could not reach the server/i);
  });
});
