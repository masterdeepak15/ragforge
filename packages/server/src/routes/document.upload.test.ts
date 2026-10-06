import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { request } from 'http';
import { Readable } from 'stream';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { createKb, buildMultipart, multipartBoundary, multipartHead } from '../test/multipart.js';
import { UploadService } from '../uploads/upload.service.js';

let t: TestApp;
let kbId: string;
const auth = () => ({ authorization: `Bearer ${t.token}` });

async function upload(parts: Parameters<typeof buildMultipart>[0]) {
  const { payload, headers } = buildMultipart(parts);
  return t.app.inject({ method: 'POST', url: '/api/documents/upload', headers: { ...auth(), ...headers }, payload });
}
const file = (name: string, text: string | Buffer, filename = name) => ({
  name,
  filename,
  data: Buffer.isBuffer(text) ? text : Buffer.from(text),
});
async function docRows(): Promise<any[]> {
  const rs = await t.app.db.client.execute({ sql: 'SELECT * FROM documents WHERE knowledge_base_id = ?', args: [kbId] });
  return rs.rows as any[];
}
async function uploadsDirFiles(): Promise<string[]> {
  const dir = join(t.dataDir, 'uploads');
  return existsSync(dir) ? (await readdir(dir)).filter((f) => !f.startsWith('.')) : [];
}

beforeAll(async () => {
  t = await createTestApp();
  kbId = await createKb(t, 'uploads');
});
afterAll(async () => {
  await t.close();
});

describe('POST /api/documents/upload', () => {
  it('accepts several files in one request and stores them under UUID paths', async () => {
    const res = await upload([
      { name: 'knowledgeBaseId', value: kbId },
      file('file', 'alpha content', 'a.txt'),
      file('file', '# beta', 'b.md'),
    ]);
    expect(res.statusCode).toBe(202);
    const { items } = res.json();
    expect(items).toHaveLength(2);
    expect(items.map((i: any) => i.title).sort()).toEqual(['a.txt', 'b.md']);
    for (const item of items) {
      expect(item.status).toBe('pending');
      expect(item.deduplicated).toBe(false);
      expect(existsSync(join(t.dataDir, 'uploads', item.id))).toBe(true);
    }
    const rows = await docRows();
    expect(rows.map((r) => r.source_type).sort()).toEqual(['md', 'txt']);
  });

  it('returns the existing document when identical bytes are uploaded again', async () => {
    const first = (await upload([{ name: 'knowledgeBaseId', value: kbId }, file('file', 'dedupe me', 'd1.txt')])).json().items[0];
    const second = (await upload([{ name: 'knowledgeBaseId', value: kbId }, file('file', 'dedupe me', 'd2.txt')])).json().items[0];
    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe(first.id);
    expect((await docRows()).filter((r) => r.id === first.id)).toHaveLength(1);
  });

  it('never uses the client filename as a path', async () => {
    const res = await upload([{ name: 'knowledgeBaseId', value: kbId }, file('file', 'evil', '../../evil.txt')]);
    expect(res.statusCode).toBe(202);
    const item = res.json().items[0];
    expect(item.title).toBe('evil.txt');
    expect(existsSync(join(t.dataDir, 'uploads', item.id))).toBe(true);
    expect(existsSync(join(t.dataDir, '..', 'evil.txt'))).toBe(false);
    expect(existsSync(join(t.dataDir, 'evil.txt'))).toBe(false);
  });

  it('keeps unicode filenames intact', async () => {
    const res = await upload([{ name: 'knowledgeBaseId', value: kbId }, file('file', 'unicode', 'résumé 日本語.txt')]);
    expect(res.json().items[0].title).toBe('résumé 日本語.txt');
  });

  it('stores a 0-byte file as a pending document', async () => {
    const res = await upload([{ name: 'knowledgeBaseId', value: kbId }, file('file', Buffer.alloc(0), 'empty.txt')]);
    expect(res.statusCode).toBe(202);
    const row = (await docRows()).find((r) => r.id === res.json().items[0].id);
    expect(Number(row.file_size)).toBe(0);
    expect(row.status).toBe('pending');
  });

  it('creates exactly one document for concurrent identical uploads', async () => {
    const send = () => upload([{ name: 'knowledgeBaseId', value: kbId }, file('file', 'race condition bytes', 'race.txt')]);
    const [a, b] = await Promise.all([send(), send()]);
    const ids = [a.json().items[0].id, b.json().items[0].id];
    expect(ids[0]).toBe(ids[1]);
    expect((await docRows()).filter((r) => r.id === ids[0])).toHaveLength(1);
    const files = await uploadsDirFiles();
    expect(files.filter((f) => f === ids[0])).toHaveLength(1);
    expect(files.some((f) => f.endsWith('.part'))).toBe(false);
  });

  it('rejects an unknown knowledge base and unauthenticated requests', async () => {
    const res = await upload([{ name: 'knowledgeBaseId', value: 'nope' }, file('file', 'x', 'x.txt')]);
    expect(res.statusCode).toBe(404);
    const { payload, headers } = buildMultipart([{ name: 'knowledgeBaseId', value: kbId }, file('file', 'x', 'x.txt')]);
    const anon = await t.app.inject({ method: 'POST', url: '/api/documents/upload', headers, payload });
    expect(anon.statusCode).toBe(401);
  });

  it('records a URL source without a file', async () => {
    const res = await upload([
      { name: 'knowledgeBaseId', value: kbId },
      { name: 'url', value: 'https://example.com/page' },
    ]);
    expect(res.statusCode).toBe(202);
    const row = (await docRows()).find((r) => r.id === res.json().items[0].id);
    expect(row.source_type).toBe('url');
    expect(row.source_url).toBe('https://example.com/page');
  });

  it('streams a 120 MB file without buffering it in memory', async () => {
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as any).port;
    const boundary = multipartBoundary();
    const head = Buffer.concat([
      multipartHead(boundary, { name: 'knowledgeBaseId' }),
      Buffer.from(kbId),
      Buffer.from('\r\n'),
      multipartHead(boundary, { name: 'file', filename: 'big.bin' }),
    ]);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    async function* body() {
      yield head;
      for (let i = 0; i < 120; i++) yield Buffer.alloc(1024 * 1024, i);
      yield tail;
    }
    let peak = 0;
    const base = process.memoryUsage().rss;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss - base);
    }, 20);
    const result = await new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/documents/upload',
          method: 'POST',
          headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}`, 'transfer-encoding': 'chunked' },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(data) }));
        },
      );
      req.on('error', reject);
      Readable.from(body()).pipe(req);
    });
    clearInterval(timer);
    expect(result.status).toBe(202);
    const id = result.json.items[0].id;
    expect((await stat(join(t.dataDir, 'uploads', id))).size).toBe(120 * 1024 * 1024);
    expect(peak).toBeLessThan(100 * 1024 * 1024);
  }, 120_000);
});

describe('UploadService.saveStream', () => {
  it('removes the partial file when the stream aborts', async () => {
    const before = await uploadsDirFiles();
    const svc = new UploadService(t.app.db, t.dataDir);
    async function* failing() {
      yield Buffer.from('partial data');
      throw new Error('client disconnected');
    }
    await expect(
      svc.saveStream({ knowledgeBaseId: kbId, filename: 'abort.txt', mimeType: 'text/plain', stream: Readable.from(failing()) }),
    ).rejects.toThrow('client disconnected');
    expect(await uploadsDirFiles()).toEqual(before);
    expect((await docRows()).filter((r) => r.title === 'abort.txt')).toHaveLength(0);
  });
});
