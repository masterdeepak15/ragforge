import { describe, it, expect, afterAll } from 'vitest';
import { createTestApp } from '../test/helpers.js';

describe('health endpoints', () => {
  const open: Array<{ close(): Promise<void> }> = [];
  afterAll(async () => {
    for (const t of open) await t.close().catch(() => {});
  });

  it('GET /api/health is public and reports the version', async () => {
    const t = await createTestApp();
    open.push(t);
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: '1.0.0' });
  });

  it('GET /api/ready is public and reports each check', async () => {
    const t = await createTestApp({ worker: true });
    open.push(t);
    const res = await t.app.inject({ method: 'GET', url: '/api/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok', worker: 'ok' } });
  });

  it('does not require a worker when none is configured', async () => {
    const t = await createTestApp();
    open.push(t);
    const res = await t.app.inject({ method: 'GET', url: '/api/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.worker).toBe('disabled');
  });

  it('answers 503 with the failing check when the database is unreachable', async () => {
    const t = await createTestApp();
    open.push(t);
    await t.app.db.close();
    const res = await t.app.inject({ method: 'GET', url: '/api/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('unavailable');
    expect(res.json().checks.database).toMatch(/^error/);
  });
});
