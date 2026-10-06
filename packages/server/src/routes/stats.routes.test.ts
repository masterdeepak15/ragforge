import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { createKb } from '../test/multipart.js';

let t: TestApp;
const authz = () => ({ authorization: `Bearer ${t.token}` });
const stats = async () => (await t.app.inject({ method: 'GET', url: '/api/stats', headers: authz() })).json();

async function addDoc(kb: string, over: Partial<{ title: string; status: string; chunks: number; size: number; created: string }> = {}): Promise<string> {
  const id = randomUUID();
  await t.app.db.client.execute({
    sql: `INSERT INTO documents (id, knowledge_base_id, title, source_type, status, chunk_count, file_size, created_at) VALUES (?, ?, ?, 'txt', ?, ?, ?, ?)`,
    args: [id, kb, over.title ?? 'doc', over.status ?? 'ready', over.chunks ?? 0, over.size ?? 0, over.created ?? '2026-01-01 00:00:00'],
  });
  return id;
}

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('GET /api/stats', () => {
  it('is empty for a fresh install and describes the system', async () => {
    const s = await stats();
    expect(s).toMatchObject({
      knowledgeBases: 0,
      documents: { total: 0, ready: 0, processing: 0, failed: 0 },
      chunks: 0,
      storageBytes: 0,
      queue: { queued: 0, running: 0, failed: 0 },
      recent: [],
      system: { version: '1.0.0', storageMode: 'sqlite', workerRunning: false },
    });
    expect(typeof s.system.ingestConcurrency).toBe('number');
  });

  it('totals documents, chunks and bytes across knowledge bases', async () => {
    const a = await createKb(t, 'stats-a');
    const b = await createKb(t, 'stats-b');
    await addDoc(a, { status: 'ready', chunks: 10, size: 1000 });
    await addDoc(a, { status: 'failed', size: 200 });
    await addDoc(b, { status: 'pending', size: 300 });
    await addDoc(b, { status: 'processing', size: 400 });
    const s = await stats();
    expect(s.knowledgeBases).toBe(2);
    expect(s.documents).toEqual({ total: 4, ready: 1, processing: 2, failed: 1 }); // pending counts as processing
    expect(s.chunks).toBe(10);
    expect(s.storageBytes).toBe(1900);
  });

  it('counts the queue by job status', async () => {
    const kb = await createKb(t, 'queue');
    const d1 = await addDoc(kb);
    const d2 = await addDoc(kb);
    const d3 = await addDoc(kb);
    const d4 = await addDoc(kb);
    await t.app.jobs.enqueue(d1);
    await t.app.jobs.enqueue(d2);
    const running = await t.app.jobs.enqueue(d3);
    const failed = await t.app.jobs.enqueue(d4);
    await t.app.db.client.execute({ sql: `UPDATE ingestion_jobs SET status = 'running' WHERE id = ?`, args: [running] });
    await t.app.db.client.execute({ sql: `UPDATE ingestion_jobs SET status = 'failed' WHERE id = ?`, args: [failed] });
    expect((await stats()).queue).toEqual({ queued: 2, running: 1, failed: 1 });
  });

  it('lists the most recent documents newest first with their knowledge base name', async () => {
    const kb = await createKb(t, 'Recent KB');
    await addDoc(kb, { title: 'oldest', created: '2030-01-01 00:00:00' });
    for (let i = 1; i <= 9; i++) await addDoc(kb, { title: `d${i}`, created: `2030-01-${String(i + 1).padStart(2, "0")} 00:00:00` });
    const { recent } = await stats();
    expect(recent).toHaveLength(8);
    expect(recent[0]).toMatchObject({ title: 'd9', knowledgeBaseName: 'Recent KB', status: 'ready' });
    expect(recent.map((r: { title: string }) => r.title)).not.toContain('oldest');
  });

  it('does not expose server paths and needs authentication', async () => {
    expect(JSON.stringify(await stats())).not.toMatch(/ragforge-test|\\\\|\/tmp/);
    expect((await t.app.inject({ method: 'GET', url: '/api/stats' })).statusCode).toBe(401);
  });
});
