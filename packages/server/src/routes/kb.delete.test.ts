import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { createKb, buildMultipart } from '../test/multipart.js';

let t: TestApp;
const authz = () => ({ authorization: `Bearer ${t.token}` });

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

async function upload(kb: string, name: string, text: string): Promise<string> {
  const { payload, headers } = buildMultipart([{ name: 'knowledgeBaseId', value: kb }, { name: 'file', filename: name, data: Buffer.from(text) }]);
  const res = await t.app.inject({ method: 'POST', url: '/api/documents/upload', headers: { ...authz(), ...headers }, payload });
  return res.json().items[0].id;
}
const rows = async (sql: string, args: any[] = []) => (await t.app.db.client.execute({ sql, args })).rows as any[];

describe('DELETE /api/knowledge-bases/:id', () => {
  it('removes uploaded files, queued jobs, upload sessions and vector data along with the knowledge base', async () => {
    const kb = await createKb(t, 'doomed');
    const keep = await createKb(t, 'survivor');
    const a = await upload(kb, 'a.txt', 'first document');
    const b = await upload(kb, 'b.txt', 'second document');
    const other = await upload(keep, 'keep.txt', 'must survive');

    // a half-finished resumable upload for the doomed KB
    const init = await t.app.inject({ method: 'POST', url: '/api/uploads', headers: authz(), payload: { knowledgeBaseId: kb, filename: 'big.bin', size: 100 } });
    const sessionId = init.json().id;
    expect(existsSync(join(t.dataDir, 'uploads', '.partial', sessionId))).toBe(true);

    // a failed job (it would otherwise haunt the dashboard's "needs attention" count forever)
    const failedJob = (await rows('SELECT id FROM ingestion_jobs WHERE document_id = ?', [a]))[0].id;
    await t.app.db.client.execute({ sql: `UPDATE ingestion_jobs SET status = 'failed' WHERE id = ?`, args: [failedJob] });

    const res = await t.app.inject({ method: 'DELETE', url: `/api/knowledge-bases/${kb}`, headers: authz() });
    expect(res.statusCode).toBe(204);

    for (const id of [a, b]) {
      expect(existsSync(join(t.dataDir, 'uploads', id))).toBe(false);
      expect(await rows('SELECT id FROM documents WHERE id = ?', [id])).toHaveLength(0);
      expect(await rows('SELECT id FROM ingestion_jobs WHERE document_id = ?', [id])).toHaveLength(0);
    }
    expect(await rows('SELECT id FROM upload_sessions WHERE knowledge_base_id = ?', [kb])).toHaveLength(0);
    expect(existsSync(join(t.dataDir, 'uploads', '.partial', sessionId))).toBe(false);
    expect(await rows('SELECT knowledge_base_id FROM kb_vector_tables WHERE knowledge_base_id = ?', [kb])).toHaveLength(0);
    expect((await t.app.inject({ method: 'GET', url: '/api/stats', headers: authz() })).json().queue.failed).toBe(0);

    // the other knowledge base is untouched
    expect(existsSync(join(t.dataDir, 'uploads', other))).toBe(true);
    expect(await rows('SELECT id FROM documents WHERE id = ?', [other])).toHaveLength(1);
  });

  it('is harmless for a knowledge base that is already gone', async () => {
    const res = await t.app.inject({ method: 'DELETE', url: '/api/knowledge-bases/not-there', headers: authz() });
    expect(res.statusCode).toBe(204);
  });
});
