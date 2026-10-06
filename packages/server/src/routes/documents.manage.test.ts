import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { createKb, buildMultipart } from '../test/multipart.js';

let t: TestApp;
const authz = () => ({ authorization: `Bearer ${t.token}` });

async function addDoc(kb: string, over: Partial<{ title: string; status: string; chunks: number; size: number; created: string }> = {}): Promise<string> {
  const id = randomUUID();
  await t.app.db.client.execute({
    sql: `INSERT INTO documents (id, knowledge_base_id, title, source_type, status, chunk_count, file_size, created_at)
          VALUES (?, ?, ?, 'txt', ?, ?, ?, ?)`,
    args: [id, kb, over.title ?? `doc-${id.slice(0, 6)}`, over.status ?? 'ready', over.chunks ?? 0, over.size ?? 0, over.created ?? '2026-01-01 00:00:00'],
  });
  return id;
}
async function addChunks(kb: string, docId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await t.app.db.client.execute({
      sql: `INSERT INTO document_chunks (id, document_id, knowledge_base_id, chunk_index, content, token_count) VALUES (?, ?, ?, ?, 'x', 1)`,
      args: [randomUUID(), docId, kb, i],
    });
  }
}
const list = (kb: string, qs = '') => t.app.inject({ method: 'GET', url: `/api/knowledge-bases/${kb}/documents${qs}`, headers: authz() });
async function rows(sql: string, args: any[] = []): Promise<any[]> {
  return (await t.app.db.client.execute({ sql, args })).rows as any[];
}

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('GET /api/knowledge-bases/:id/documents', () => {
  it('pages results newest first and reports the total', async () => {
    const kb = await createKb(t, 'paging');
    for (let i = 1; i <= 5; i++) await addDoc(kb, { title: `d${i}`, created: `2026-01-0${i} 00:00:00` });
    const first = (await list(kb, '?limit=2&offset=0')).json();
    expect(first.items.map((d: any) => d.title)).toEqual(['d5', 'd4']);
    expect(first.total).toBe(5);
    const second = (await list(kb, '?limit=2&offset=2')).json();
    expect(second.items.map((d: any) => d.title)).toEqual(['d3', 'd2']);
    const last = (await list(kb, '?limit=2&offset=4')).json();
    expect(last.items.map((d: any) => d.title)).toEqual(['d1']);
  });

  it('filters by one or several statuses', async () => {
    const kb = await createKb(t, 'status');
    await addDoc(kb, { status: 'ready' });
    await addDoc(kb, { status: 'failed' });
    await addDoc(kb, { status: 'pending' });
    expect((await list(kb, '?status=failed')).json().items).toHaveLength(1);
    const both = (await list(kb, '?status=failed,pending')).json();
    expect(both.items.map((d: any) => d.status).sort()).toEqual(['failed', 'pending']);
    expect(both.total).toBe(2);
  });

  it('searches titles case-insensitively and treats % and _ literally', async () => {
    const kb = await createKb(t, 'search');
    await addDoc(kb, { title: 'Payments Runbook.md' });
    await addDoc(kb, { title: 'discount-100%.txt' });
    await addDoc(kb, { title: 'other_file.txt' });
    await addDoc(kb, { title: 'otherXfile.txt' });
    expect((await list(kb, '?q=payments')).json().items.map((d: any) => d.title)).toEqual(['Payments Runbook.md']);
    expect((await list(kb, `?q=${encodeURIComponent('100%')}`)).json().items.map((d: any) => d.title)).toEqual(['discount-100%.txt']);
    expect((await list(kb, `?q=${encodeURIComponent('other_file')}`)).json().items.map((d: any) => d.title)).toEqual(['other_file.txt']);
  });

  it('reports per-status counts and totals for the whole knowledge base, ignoring filters', async () => {
    const kb = await createKb(t, 'stats');
    await addDoc(kb, { status: 'ready', chunks: 10, size: 1000 });
    await addDoc(kb, { status: 'ready', chunks: 5, size: 500 });
    await addDoc(kb, { status: 'failed', chunks: 0, size: 300 });
    await addDoc(kb, { status: 'processing', size: 200 });
    const body = (await list(kb, '?status=failed&limit=1')).json();
    expect(body.counts).toEqual({ ready: 2, failed: 1, processing: 1, pending: 0 });
    expect(body.stats).toEqual({ documents: 4, readyDocuments: 2, chunks: 15, bytes: 2000 });
  });

  it('clamps limit and falls back on invalid paging values', async () => {
    const kb = await createKb(t, 'clamp');
    for (let i = 0; i < 3; i++) await addDoc(kb);
    expect((await list(kb, '?limit=99999')).json().items).toHaveLength(3);
    expect((await list(kb, '?limit=abc&offset=-5')).json().items).toHaveLength(3);
    expect((await list(kb, '?limit=0')).json().items.length).toBeGreaterThanOrEqual(1);
  });

  it('is empty for a new knowledge base, 404 for an unknown one, and needs auth', async () => {
    const kb = await createKb(t, 'empty');
    expect((await list(kb)).json()).toMatchObject({ items: [], total: 0, counts: { ready: 0, failed: 0, processing: 0, pending: 0 } });
    expect((await list('nope')).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/api/knowledge-bases/${kb}/documents` })).statusCode).toBe(401);
  });
});

describe('knowledge base counts', () => {
  it('counts documents and chunks without multiplying them', async () => {
    const kb = await createKb(t, 'counts');
    const a = await addDoc(kb);
    const b = await addDoc(kb);
    await addDoc(kb);
    await addChunks(kb, a, 4);
    await addChunks(kb, b, 3);
    const listed = (await t.app.inject({ method: 'GET', url: '/api/knowledge-bases', headers: authz() })).json().find((k: any) => k.id === kb);
    expect(listed).toMatchObject({ documentCount: 3, chunkCount: 7 });
    const one = (await t.app.inject({ method: 'GET', url: `/api/knowledge-bases/${kb}`, headers: authz() })).json();
    expect(one).toMatchObject({ documentCount: 3, chunkCount: 7 });
  });
});

describe('deleting documents', () => {
  async function uploaded(kb: string, text: string): Promise<string> {
    const { payload, headers } = buildMultipart([
      { name: 'knowledgeBaseId', value: kb },
      { name: 'file', filename: `${text}.txt`, data: Buffer.from(text) },
    ]);
    const res = await t.app.inject({ method: 'POST', url: '/api/documents/upload', headers: { ...authz(), ...headers }, payload });
    return res.json().items[0].id;
  }

  it('removes the stored file, chunks and jobs along with the document', async () => {
    const kb = await createKb(t, 'delete-one');
    const id = await uploaded(kb, 'remove me please');
    await addChunks(kb, id, 2);
    expect(existsSync(join(t.dataDir, 'uploads', id))).toBe(true);

    const res = await t.app.inject({ method: 'DELETE', url: `/api/documents/${id}`, headers: authz() });
    expect(res.statusCode).toBe(204);
    expect(existsSync(join(t.dataDir, 'uploads', id))).toBe(false);
    expect(await rows('SELECT id FROM documents WHERE id = ?', [id])).toHaveLength(0);
    expect(await rows('SELECT id FROM document_chunks WHERE document_id = ?', [id])).toHaveLength(0);
    expect(await rows('SELECT id FROM ingestion_jobs WHERE document_id = ?', [id])).toHaveLength(0);
  });

  it('is idempotent for documents that are already gone', async () => {
    const res = await t.app.inject({ method: 'DELETE', url: `/api/documents/${randomUUID()}`, headers: authz() });
    expect(res.statusCode).toBe(204);
  });

  it('bulk-deletes many documents in one request', async () => {
    const kb = await createKb(t, 'delete-many');
    const ids = [await uploaded(kb, 'bulk one'), await uploaded(kb, 'bulk two'), await uploaded(kb, 'bulk three')];
    const keep = await addDoc(kb, { title: 'keep' });
    const res = await t.app.inject({ method: 'POST', url: '/api/documents/bulk-delete', headers: authz(), payload: { ids } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 3 });
    expect(await rows('SELECT id FROM documents WHERE knowledge_base_id = ?', [kb])).toEqual([expect.objectContaining({ id: keep })]);
    for (const id of ids) expect(existsSync(join(t.dataDir, 'uploads', id))).toBe(false);
  });

  it('rejects empty and oversized bulk requests', async () => {
    const post = (ids: unknown) => t.app.inject({ method: 'POST', url: '/api/documents/bulk-delete', headers: authz(), payload: { ids } });
    expect((await post([])).statusCode).toBe(400);
    expect((await post('nope')).statusCode).toBe(400);
    expect((await post(Array.from({ length: 1001 }, () => randomUUID()))).statusCode).toBe(400);
  });

  it('cancels queued ingestion for deleted documents so they are not processed afterwards', async () => {
    const kb = await createKb(t, 'delete-queued');
    const id = await uploaded(kb, 'queued then deleted');
    expect(await rows(`SELECT id FROM ingestion_jobs WHERE document_id = ? AND status = 'queued'`, [id])).toHaveLength(1);
    await t.app.inject({ method: 'DELETE', url: `/api/documents/${id}`, headers: authz() });
    expect(await rows(`SELECT id FROM ingestion_jobs WHERE document_id = ?`, [id])).toHaveLength(0);
    expect(await t.app.jobs.claimNext()).toBeNull();
  });
});
