import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestApp, type TestApp } from '../test/helpers.js';

let t: TestApp;
let webDir: string;

beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'ragforge-web-'));
  await mkdir(join(webDir, 'assets'));
  await writeFile(join(webDir, 'index.html'), '<!doctype html><html><body><div id="root">RAGFORGE-SPA</div></body></html>');
  await writeFile(join(webDir, 'assets', 'app.js'), 'console.log("asset")');
  t = await createTestApp({ webDir });
});
afterAll(async () => {
  await t.close();
  await rm(webDir, { recursive: true, force: true });
});

describe('serving the web app', () => {
  it('serves index.html at the root', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('RAGFORGE-SPA');
  });

  it.each(['/knowledge-bases', '/knowledge-bases/abc-123', '/settings', '/connect'])('serves the app for the client-side route %s (deep link / refresh)', async (url) => {
    const res = await t.app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('RAGFORGE-SPA');
  });

  it('serves static assets', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('asset');
  });

  it('keeps unknown API paths as JSON 404s instead of returning the app', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'API endpoint not found' });
  });

  it('does not swallow the MCP endpoint', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/mcp' });
    expect(res.statusCode).toBe(405);
  });
});
