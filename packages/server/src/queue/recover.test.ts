import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { createKb } from '../test/multipart.js';
import { JobQueue } from './job-queue.js';

let t: TestApp;
let clock = 1_000_000;
let queue: JobQueue;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  clock = 1_000_000;
  await t.app.db.client.execute('DELETE FROM ingestion_jobs');
  queue = new JobQueue(t.app.db, { now: () => clock, maxAttempts: 3 });
});

async function docFor(status = 'processing'): Promise<string> {
  const kb = await createKb(t, `kb-${randomUUID().slice(0, 6)}`);
  const id = randomUUID();
  await t.app.db.client.execute({
    sql: `INSERT INTO documents (id, knowledge_base_id, title, source_type, status) VALUES (?, ?, 'huge.pdf', 'pdf', ?)`,
    args: [id, kb, status],
  });
  return id;
}
const jobRow = async (id: string) => (await t.app.db.client.execute({ sql: 'SELECT * FROM ingestion_jobs WHERE id = ?', args: [id] })).rows[0] as any;
const docRow = async (id: string) => (await t.app.db.client.execute({ sql: 'SELECT * FROM documents WHERE id = ?', args: [id] })).rows[0] as any;

describe('recovering interrupted jobs at startup', () => {
  it('re-queues a job that has attempts left', async () => {
    const jobId = await queue.enqueue(await docFor());
    await queue.claimNext(); // attempt 1 of 3, then the process "dies"
    expect(await queue.recoverStale(0)).toBe(1);
    expect((await jobRow(jobId)).status).toBe('queued');
  });

  it('stops retrying a job that has already used every attempt, instead of crashing forever', async () => {
    const documentId = await docFor();
    const jobId = await queue.enqueue(documentId);
    for (let i = 0; i < 3; i++) {
      await queue.claimNext(); // each attempt "crashes the process" (job left running)
      if (i < 2) {
        expect(await queue.recoverStale(0)).toBe(1);
      }
    }
    expect(await queue.recoverStale(0)).toBe(0); // nothing is re-queued this time
    expect(await jobRow(jobId)).toMatchObject({ status: 'failed' });
    expect((await jobRow(jobId)).error).toMatch(/interrupted/i);
    expect(await queue.claimNext()).toBeNull();

    const d = await docRow(documentId);
    expect(d.status).toBe('failed');
    expect(d.error_message).toMatch(/interrupted|restart|too large|crash/i);
  });

  it('leaves documents of re-queued jobs alone', async () => {
    const documentId = await docFor('processing');
    await queue.enqueue(documentId);
    await queue.claimNext();
    await queue.recoverStale(0);
    expect((await docRow(documentId)).status).toBe('processing');
  });
});
