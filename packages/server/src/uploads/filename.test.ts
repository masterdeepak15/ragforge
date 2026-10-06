import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { createKb } from '../test/multipart.js';
import { cleanFilename, repairMultipartFilename } from './upload.service.js';

describe('cleanFilename (names that are already correct UTF-8, e.g. from JSON)', () => {
  it.each([['😀 notes.txt'], ['résumé 日本語.txt'], ['plain.md'], ['Ünïcödé — dash.pdf']])('keeps %s intact', (name) => {
    expect(cleanFilename(name)).toBe(name);
  });
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\secret.txt', 'secret.txt'],
    ['dir/sub/file.pdf', 'file.pdf'],
    ['', 'upload'],
  ])('keeps only the last path segment of %j', (raw, out) => {
    expect(cleanFilename(raw)).toBe(out);
  });
});

describe('repairMultipartFilename (busboy hands UTF-8 names over as latin1)', () => {
  it('restores names that were decoded as latin1', () => {
    const asLatin1 = (s: string) => Buffer.from(s, 'utf8').toString('latin1');
    expect(repairMultipartFilename(asLatin1('résumé 日本語.txt'))).toBe('résumé 日本語.txt');
    expect(repairMultipartFilename(asLatin1('😀 notes.txt'))).toBe('😀 notes.txt');
  });
  it('leaves plain ASCII alone', () => {
    expect(repairMultipartFilename('plain.txt')).toBe('plain.txt');
  });
});

describe('resumable uploads keep unusual file names', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it.each(['😀 notes.txt', 'résumé 日本語.txt'])('stores %s with the name the user chose', async (filename) => {
    const kb = await createKb(t, 'names');
    const headers = { authorization: `Bearer ${t.token}` };
    const { id } = (await t.app.inject({ method: 'POST', url: '/api/uploads', headers, payload: { knowledgeBaseId: kb, filename, size: 4 } })).json();
    await t.app.inject({ method: 'PATCH', url: `/api/uploads/${id}`, headers: { ...headers, 'content-type': 'application/offset+octet-stream', 'upload-offset': '0' }, payload: Buffer.from('data') });
    const done = await t.app.inject({ method: 'POST', url: `/api/uploads/${id}/complete`, headers });
    expect(done.json().items[0].title).toBe(filename);
  });
});
