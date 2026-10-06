import { describe, it, expect, afterAll } from 'vitest';
import { Writable } from 'stream';
import { createTestApp, type TestApp } from './test/helpers.js';
import { redactUrl } from './index.js';

describe('redactUrl', () => {
  it('hides token query parameters', () => {
    expect(redactUrl('/api/ingestion/events?knowledgeBaseId=kb1&token=eyJhbGciOi.abc.def')).toBe('/api/ingestion/events?knowledgeBaseId=kb1&token=[redacted]');
    expect(redactUrl('/x?token=secret&a=1')).toBe('/x?token=[redacted]&a=1');
    expect(redactUrl('/x?TOKEN=secret')).toBe('/x?TOKEN=[redacted]');
  });
  it('leaves everything else untouched', () => {
    expect(redactUrl('/api/documents?limit=1&q=token')).toBe('/api/documents?limit=1&q=token');
    expect(redactUrl('/plain')).toBe('/plain');
  });
});

describe('request logging', () => {
  let t: TestApp | undefined;
  afterAll(async () => {
    await t?.close();
  });

  it('never writes a login token to the log', async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    t = await createTestApp({ logStream });
    await t.app.inject({ method: 'GET', url: `/api/ingestion/jobs?token=${t.token}`, headers: { authorization: `Bearer ${t.token}` } });
    const logged = lines.join('');
    expect(logged).toContain('/api/ingestion/jobs'); // requests are still logged...
    expect(logged).not.toContain(t.token); // ...but without the token
    expect(logged).toContain('token=[redacted]');
  });
});
