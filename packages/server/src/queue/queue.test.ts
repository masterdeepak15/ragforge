import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { createKb, buildMultipart } from '../test/multipart.js';
import { JobQueue, type Job } from './job-queue.js';
import { Worker, NonRetryableError } from './worker.js';
import type { AppEvent } from '../events/event-bus.js';

let t: TestApp;
let clock = 1_000_000;
const now = () => clock;
let queue: JobQueue;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await sleep(10);
  }
}
async function row(id: string): Promise<any> {
  const rs = await t.app.db.client.execute({ sql: 'SELECT * FROM ingestion_jobs WHERE id = ?', args: [id] });
  return rs.rows[0];
}
const newDoc = () => randomUUID();

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  clock = 1_000_000;
  await t.app.db.client.execute('DELETE FROM ingestion_jobs');
  queue = new JobQueue(t.app.db, { now, backoffBaseMs: 5000, maxAttempts: 3 });
});

describe('JobQueue', () => {
  it('never hands the same job to two claimers', async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, () => queue.enqueue(newDoc())));
    const claims = await Promise.all(Array.from({ length: 10 }, () => queue.claimNext()));
    const got = claims.filter((c): c is Job => c !== null);
    expect(got).toHaveLength(5);
    expect(new Set(got.map((j) => j.id)).size).toBe(5);
    expect(new Set(got.map((j) => j.id))).toEqual(new Set(ids));
    expect(got.every((j) => j.status === 'running' && j.attempts === 1)).toBe(true);
  });

  it('claims jobs oldest first', async () => {
    const first = await queue.enqueue(newDoc());
    clock += 10;
    const second = await queue.enqueue(newDoc());
    expect((await queue.claimNext())!.id).toBe(first);
    expect((await queue.claimNext())!.id).toBe(second);
  });

  it('re-queues a retryable failure with exponential backoff and fails after max attempts', async () => {
    const id = await queue.enqueue(newDoc());

    expect((await queue.claimNext())!.attempts).toBe(1);
    await queue.fail(id, 'rate limited', true);
    expect((await row(id)).status).toBe('queued');
    expect(await queue.claimNext()).toBeNull(); // still backing off
    clock += 5000;

    expect((await queue.claimNext())!.attempts).toBe(2);
    await queue.fail(id, 'rate limited', true);
    clock += 9999;
    expect(await queue.claimNext()).toBeNull(); // 10 s backoff not over
    clock += 1;

    expect((await queue.claimNext())!.attempts).toBe(3);
    await queue.fail(id, 'rate limited again', true);
    const final = await row(id);
    expect(final.status).toBe('failed');
    expect(final.error).toBe('rate limited again');
    clock += 1_000_000;
    expect(await queue.claimNext()).toBeNull();
  });

  it('fails immediately when the error is not retryable', async () => {
    const id = await queue.enqueue(newDoc());
    await queue.claimNext();
    await queue.fail(id, 'corrupt pdf', false);
    expect(await row(id)).toMatchObject({ status: 'failed', error: 'corrupt pdf' });
  });

  it('puts running jobs with a stale lock back in the queue', async () => {
    const stale = await queue.enqueue(newDoc());
    await queue.claimNext();
    clock += 60_000;
    const fresh = await queue.enqueue(newDoc());
    await queue.claimNext();

    expect(await queue.recoverStale(30_000)).toBe(1);
    expect((await row(stale)).status).toBe('queued');
    expect((await row(fresh)).status).toBe('running');
    expect(await queue.recoverStale(0)).toBe(1);
  });

  it('does not let complete or fail overwrite a cancelled job', async () => {
    const id = await queue.enqueue(newDoc());
    await queue.claimNext();
    await queue.cancel(id);
    await queue.complete(id);
    await queue.fail(id, 'late failure', true);
    expect((await row(id)).status).toBe('cancelled');
  });

  it('retry puts a failed job back with a fresh attempt budget', async () => {
    const id = await queue.enqueue(newDoc());
    await queue.claimNext();
    await queue.fail(id, 'boom', false);
    await queue.retry(id);
    expect(await row(id)).toMatchObject({ status: 'queued', attempts: 0, error: null });
    expect((await queue.claimNext())!.id).toBe(id);
  });

  it('stores progress for display', async () => {
    const id = await queue.enqueue(newDoc());
    await queue.updateProgress(id, { stage: 'embedding', chunksTotal: 10, chunksDone: 4 });
    expect(await row(id)).toMatchObject({ progress_stage: 'embedding', chunks_total: 10, chunks_done: 4 });
  });
});

describe('Worker', () => {
  it('never runs more handlers at once than its concurrency', async () => {
    const q = new JobQueue(t.app.db);
    for (let i = 0; i < 6; i++) await q.enqueue(newDoc());
    let active = 0;
    let peak = 0;
    let done = 0;
    const worker = new Worker(q, { pollMs: 10 });
    worker.start({
      concurrency: 2,
      handler: async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(40);
        active--;
        done++;
      },
    });
    await waitFor(() => done === 6);
    await worker.stop();
    expect(peak).toBe(2);
    const rs = await t.app.db.client.execute(`SELECT COUNT(*) AS n FROM ingestion_jobs WHERE status = 'done'`);
    expect(Number((rs.rows[0] as any).n)).toBe(6);
  });

  it('stop() waits for in-flight jobs to finish', async () => {
    const q = new JobQueue(t.app.db);
    const id = await q.enqueue(newDoc());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    const worker = new Worker(q, { pollMs: 10 });
    worker.start({ concurrency: 1, handler: async () => { started = true; await gate; } });
    await waitFor(() => started);

    let stopped = false;
    const stopping = worker.stop().then(() => (stopped = true));
    await sleep(60);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect((await row(id)).status).toBe('done');
  });

  it('marks retryable errors for retry and NonRetryableError as failed', async () => {
    const q = new JobQueue(t.app.db, { backoffBaseMs: 60_000, maxAttempts: 3 });
    const transient = await q.enqueue(newDoc());
    const fatal = await q.enqueue(newDoc());
    const handled = new Set<string>();
    const worker = new Worker(q, { pollMs: 10 });
    worker.start({
      concurrency: 2,
      handler: async (job) => {
        handled.add(job.id);
        if (job.id === fatal) throw new NonRetryableError('no text');
        throw new Error('timeout');
      },
    });
    await waitFor(() => handled.size === 2);
    await sleep(50);
    await worker.stop();
    expect(await row(fatal)).toMatchObject({ status: 'failed', error: 'no text' });
    expect(await row(transient)).toMatchObject({ status: 'queued', attempts: 1, error: 'timeout' });
  });

  it('cancel aborts the running handler through its AbortSignal', async () => {
    const q = new JobQueue(t.app.db);
    const id = await q.enqueue(newDoc());
    let sawAbort = false;
    let started = false;
    const worker = new Worker(q, { pollMs: 10 });
    worker.start({
      concurrency: 1,
      handler: (_job, signal) =>
        new Promise<void>((_resolve, reject) => {
          started = true;
          signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(new Error('aborted'));
          });
        }),
    });
    await waitFor(() => started);
    await worker.cancel(id);
    await waitFor(() => sawAbort);
    await worker.stop();
    expect((await row(id)).status).toBe('cancelled');
  });
});

describe('uploads enqueue work', () => {
  it('creates one queued job and publishes document.uploaded for a new document, none for a duplicate', async () => {
    const kb = await createKb(t, 'queue-kb');
    const events: AppEvent[] = [];
    const off = t.app.events.subscribe((e) => events.push(e));
    const send = () => {
      const { payload, headers } = buildMultipart([
        { name: 'knowledgeBaseId', value: kb },
        { name: 'file', filename: 'q.txt', data: Buffer.from('queue me') },
      ]);
      return t.app.inject({ method: 'POST', url: '/api/documents/upload', headers: { authorization: `Bearer ${t.token}`, ...headers }, payload });
    };
    const first = (await send()).json().items[0];
    const again = (await send()).json().items[0];
    off();

    expect(again.id).toBe(first.id);
    const jobs = await t.app.db.client.execute({ sql: 'SELECT * FROM ingestion_jobs WHERE document_id = ?', args: [first.id] });
    expect(jobs.rows).toHaveLength(1);
    expect((jobs.rows[0] as any).status).toBe('queued');
    expect(events.filter((e) => e.type === 'document.uploaded')).toEqual([
      { type: 'document.uploaded', documentId: first.id, knowledgeBaseId: kb },
    ]);
  });
});
