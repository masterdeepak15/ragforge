import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { createKb } from '../test/multipart.js';
import { ApiKeyService } from './api-keys.js';

let t: TestApp;
let svc: ApiKeyService;
let clock = 1_700_000_000_000;
const now = () => clock;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  clock = 1_700_000_000_000;
  await t.app.db.client.execute('DELETE FROM api_keys');
  svc = new ApiKeyService(t.app.db, { now });
});

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('ApiKeyService', () => {
  it('creates a key that verifies and carries its scope', async () => {
    const created = await svc.create({ name: 'laptop', scopeKbIds: ['kb-1', 'kb-2'], createdBy: 'u1' });
    expect(created.key).toMatch(/^rf_[A-Za-z0-9_-]{40,}$/);
    expect(created.prefix).toBe(created.key.slice(0, 8));
    expect(await svc.verify(created.key)).toEqual({ id: created.id, scopeKbIds: ['kb-1', 'kb-2'] });
  });

  it('treats a null scope as access to every knowledge base', async () => {
    const { key } = await svc.create({ name: 'all', scopeKbIds: null, createdBy: 'u1' });
    expect((await svc.verify(key))!.scopeKbIds).toBeNull();
  });

  it.each([[''], ['rf_'], ['not-a-key'], ['rf_' + 'x'.repeat(5000)], ['  ']])('rejects the garbage key %j', async (bad) => {
    await svc.create({ name: 'real', scopeKbIds: null, createdBy: 'u1' });
    expect(await svc.verify(bad)).toBeNull();
  });

  it('rejects a revoked key', async () => {
    const { id, key } = await svc.create({ name: 'temp', scopeKbIds: null, createdBy: 'u1' });
    expect(await svc.verify(key)).not.toBeNull();
    expect(await svc.revoke(id)).toBe(true);
    expect(await svc.verify(key)).toBeNull();
  });

  it('revoking an unknown key reports false', async () => {
    expect(await svc.revoke('does-not-exist')).toBe(false);
  });

  it('never stores the plaintext key, only its SHA-256', async () => {
    const { key } = await svc.create({ name: 'secret', scopeKbIds: null, createdBy: 'u1' });
    const rows = (await t.app.db.client.execute('SELECT * FROM api_keys')).rows as any[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(key);
    expect(rows[0].key_hash).toBe(sha256(key));
  });

  it('lists keys without any secret material', async () => {
    const { key } = await svc.create({ name: 'listed', scopeKbIds: ['kb-1'], createdBy: 'u1' });
    const list = await svc.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'listed', scopeKbIds: ['kb-1'], revokedAt: null, lastUsedAt: null });
    expect(JSON.stringify(list)).not.toContain(key);
    expect(Object.keys(list[0])).not.toContain('keyHash');
  });

  it('updates last-used at most once a minute', async () => {
    const { id, key } = await svc.create({ name: 'usage', scopeKbIds: null, createdBy: 'u1' });
    const lastUsed = async () => (await svc.list()).find((k) => k.id === id)!.lastUsedAt;

    await svc.verify(key);
    const first = await lastUsed();
    expect(first).toBe(new Date(clock).toISOString());

    clock += 30_000;
    await svc.verify(key);
    expect(await lastUsed()).toBe(first);

    clock += 31_000;
    await svc.verify(key);
    expect(await lastUsed()).toBe(new Date(clock).toISOString());
  });
});

describe('api key routes', () => {
  const authz = () => ({ authorization: `Bearer ${t.token}` });

  it('creates, lists and revokes a key; the secret appears only in the create response', async () => {
    const kb = await createKb(t, 'scoped');
    const created = await t.app.inject({ method: 'POST', url: '/api/api-keys', headers: authz(), payload: { name: 'cursor', knowledgeBaseIds: [kb] } });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({ name: 'cursor', scopeKbIds: [kb] });
    expect(body.key).toMatch(/^rf_/);

    const list = await t.app.inject({ method: 'GET', url: '/api/api-keys', headers: authz() });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(body.key);
    expect(list.json()).toEqual([expect.objectContaining({ id: body.id, name: 'cursor', scopeKbIds: [kb], prefix: body.prefix })]);

    const verifier = new ApiKeyService(t.app.db);
    expect(await verifier.verify(body.key)).not.toBeNull();
    const del = await t.app.inject({ method: 'DELETE', url: `/api/api-keys/${body.id}`, headers: authz() });
    expect(del.statusCode).toBe(204);
    expect(await verifier.verify(body.key)).toBeNull();
    expect((await t.app.inject({ method: 'GET', url: '/api/api-keys', headers: authz() })).json()[0].revokedAt).not.toBeNull();
  });

  it('creates an all-knowledge-bases key when no scope is given', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/api-keys', headers: authz(), payload: { name: 'everything' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().scopeKbIds).toBeNull();
  });

  it('validates input', async () => {
    const post = (payload: object) => t.app.inject({ method: 'POST', url: '/api/api-keys', headers: authz(), payload });
    expect((await post({ name: '   ' })).statusCode).toBe(400);
    expect((await post({ name: 'x'.repeat(101) })).statusCode).toBe(400);
    const unknown = await post({ name: 'bad scope', knowledgeBaseIds: ['no-such-kb'] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatch(/no-such-kb/);
  });

  it('requires authentication and refuses viewers', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/api-keys' })).statusCode).toBe(401);
    const viewer = t.app.jwt.sign({ sub: 'viewer-1', role: 'viewer' });
    const res = await t.app.inject({ method: 'POST', url: '/api/api-keys', headers: { authorization: `Bearer ${viewer}` }, payload: { name: 'nope' } });
    expect(res.statusCode).toBe(403);
  });

  it('answers 404 when revoking an unknown key', async () => {
    expect((await t.app.inject({ method: 'DELETE', url: '/api/api-keys/nope', headers: authz() })).statusCode).toBe(404);
  });
});
