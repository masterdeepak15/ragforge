import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { createKb } from '../test/multipart.js';
import { purgeStaleUploads } from './resumable.routes.js';

let t: TestApp;
let kbId: string;
const MB = 1024 * 1024;
const auth = () => ({ authorization: `Bearer ${t.token}` });

async function init(size: number, filename = 'big.bin', knowledgeBaseId = kbId) {
  return t.app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: auth(),
    payload: { knowledgeBaseId, filename, size, mimeType: 'application/octet-stream' },
  });
}
function patch(id: string, offset: number, chunk: Buffer) {
  return t.app.inject({
    method: 'PATCH',
    url: `/api/uploads/${id}`,
    headers: { ...auth(), 'content-type': 'application/offset+octet-stream', 'upload-offset': String(offset) },
    payload: chunk,
  });
}
const status = (id: string) => t.app.inject({ method: 'GET', url: `/api/uploads/${id}`, headers: auth() });
const complete = (id: string) => t.app.inject({ method: 'POST', url: `/api/uploads/${id}/complete`, headers: auth() });

beforeAll(async () => {
  t = await createTestApp();
  kbId = await createKb(t, 'resumable');
});
afterAll(async () => {
  await t.close();
});

describe('resumable uploads', () => {
  it('uploads a 10 MB file in 1 MB chunks and creates a document with the right hash', async () => {
    const data = randomBytes(10 * MB);
    const { id } = (await init(data.length)).json();
    for (let off = 0; off < data.length; off += MB) {
      const res = await patch(id, off, data.subarray(off, off + MB));
      expect(res.statusCode).toBe(200);
      expect(res.json().offset).toBe(off + MB);
    }
    const done = await complete(id);
    expect(done.statusCode).toBe(202);
    const item = done.json().items[0];
    expect(item).toMatchObject({ title: 'big.bin', status: 'pending', deduplicated: false });

    const rs = await t.app.db.client.execute({ sql: 'SELECT * FROM documents WHERE id = ?', args: [item.id] });
    const row = rs.rows[0] as any;
    expect(Number(row.file_size)).toBe(data.length);
    expect(row.content_hash).toBe(createHash('sha256').update(data).digest('hex'));
    expect((await readFile(join(t.dataDir, 'uploads', item.id))).equals(data)).toBe(true);
    expect((await status(id)).statusCode).toBe(404);
  });

  it('answers 409 with the current offset when a chunk is resent', async () => {
    const data = randomBytes(3 * MB);
    const { id } = (await init(data.length, 'resend.bin')).json();
    expect((await patch(id, 0, data.subarray(0, MB))).statusCode).toBe(200);
    const stale = await patch(id, 0, data.subarray(0, MB));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().offset).toBe(MB);
  });

  it('reports the offset after an interruption and finishes the file on resume', async () => {
    const data = randomBytes(5 * MB);
    const { id } = (await init(data.length, 'resume.bin')).json();
    for (let off = 0; off < 3 * MB; off += MB) await patch(id, off, data.subarray(off, off + MB));

    const st = (await status(id)).json();
    expect(st).toEqual({ offset: 3 * MB, size: data.length });
    await patch(id, st.offset, data.subarray(st.offset));
    const done = await complete(id);
    expect(done.statusCode).toBe(202);
    const stored = await readFile(join(t.dataDir, 'uploads', done.json().items[0].id));
    expect(stored.equals(data)).toBe(true);
  });

  it('refuses to complete before every byte has arrived', async () => {
    const { id } = (await init(2 * MB, 'short.bin')).json();
    await patch(id, 0, randomBytes(MB));
    const res = await complete(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().offset).toBe(MB);
  });

  it('rejects chunks that exceed the declared size', async () => {
    const { id } = (await init(MB, 'over.bin')).json();
    const res = await patch(id, 0, randomBytes(2 * MB));
    expect(res.statusCode).toBe(400);
    expect((await status(id)).json().offset).toBe(0);
  });

  it('requires auth and a real knowledge base', async () => {
    expect((await init(10, 'x.bin', 'missing-kb')).statusCode).toBe(404);
    const anon = await t.app.inject({ method: 'POST', url: '/api/uploads', payload: { knowledgeBaseId: kbId, filename: 'x', size: 1 } });
    expect(anon.statusCode).toBe(401);
  });

  it('purges sessions and partial files older than the cutoff', async () => {
    const { id } = (await init(MB, 'stale.bin')).json();
    await patch(id, 0, randomBytes(1024));
    const partial = join(t.dataDir, 'uploads', '.partial', id);
    expect(existsSync(partial)).toBe(true);

    await t.app.db.client.execute({
      sql: `UPDATE upload_sessions SET updated_at = '2000-01-01 00:00:00' WHERE id = ?`,
      args: [id],
    });
    const purged = await purgeStaleUploads(t.app.db, t.dataDir, 24 * 3600 * 1000);
    expect(purged).toBe(1);
    expect(existsSync(partial)).toBe(false);
    expect((await status(id)).statusCode).toBe(404);
  });
});
