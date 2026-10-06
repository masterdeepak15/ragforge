import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request } from 'http';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { createKb, buildMultipart } from '../test/multipart.js';
import type { AppEvent } from '../events/event-bus.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SseClient {
  status: number;
  events: AppEvent[];
  raw: string;
  waitFor(pred: (e: AppEvent) => boolean, ms?: number): Promise<AppEvent>;
  close(): void;
}

function openSse(port: number, path: string, headers: Record<string, string> = {}): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { accept: 'text/event-stream', ...headers } }, (res) => {
      const client: SseClient = {
        status: res.statusCode ?? 0,
        events: [],
        raw: '',
        async waitFor(pred, ms = 10_000) {
          const start = Date.now();
          for (;;) {
            const hit = client.events.find(pred);
            if (hit) return hit;
            if (Date.now() - start > ms) throw new Error(`SSE event not seen; got ${JSON.stringify(client.events.map((e) => e.type))}`);
            await sleep(10);
          }
        },
        close: () => req.destroy(),
      };
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        client.raw += chunk;
        // Re-parse the whole buffer each time: simple and immune to chunks split mid-event.
        client.events = client.raw
          .split('\n\n')
          .slice(0, -1) // the last segment may be a half-received event
          .filter((b) => b.startsWith('data: '))
          .map((b) => JSON.parse(b.slice(6)));
      });
      // resolve once headers are in; the server sends an initial comment so the stream is live
      resolve(client);
    });
    req.on('error', (err) => {
      if ((err as any).code !== 'ECONNRESET') reject(err);
    });
    req.end();
  });
}

let w: TestApp; // with a running worker
let n: TestApp; // without a worker
let port: number;

const upload = (t: TestApp, kb: string, filename: string, data: string) => {
  const { payload, headers } = buildMultipart([
    { name: 'knowledgeBaseId', value: kb },
    { name: 'file', filename, data: Buffer.from(data) },
  ]);
  return t.app.inject({ method: 'POST', url: '/api/documents/upload', headers: { authorization: `Bearer ${t.token}`, ...headers }, payload });
};
const authz = (t: TestApp) => ({ authorization: `Bearer ${t.token}` });

beforeAll(async () => {
  w = await createTestApp({ worker: true });
  n = await createTestApp();
  await w.app.listen({ port: 0, host: '127.0.0.1' });
  port = (w.app.server.address() as any).port;
});
afterAll(async () => {
  await w.close();
  await n.close();
});

describe('GET /api/ingestion/events (SSE)', () => {
  it('streams upload, progress and ready events in order for the subscribed knowledge base', async () => {
    const kb = await createKb(w, 'sse-a');
    const sse = await openSse(port, `/api/ingestion/events?knowledgeBaseId=${kb}`, authz(w));
    expect(sse.status).toBe(200);

    const res = await upload(w, kb, 'stream.txt', 'The kestrel hovers above the meadow at dawn.');
    const id = res.json().items[0].id;
    await sse.waitFor((e) => e.type === 'document.ready' && e.documentId === id);
    sse.close();

    const types = sse.events.map((e) => e.type);
    expect(types[0]).toBe('document.uploaded');
    expect(types.indexOf('job.progress')).toBeGreaterThan(types.indexOf('document.uploaded'));
    expect(types.at(-1)).toBe('document.ready');
  });

  it('only delivers events for the requested knowledge base', async () => {
    const a = await createKb(w, 'filter-a');
    const b = await createKb(w, 'filter-b');
    const sse = await openSse(port, `/api/ingestion/events?knowledgeBaseId=${a}`, authz(w));

    await upload(w, b, 'other.txt', 'content that belongs to the other knowledge base');
    const mine = (await upload(w, a, 'mine.txt', 'content that belongs to the subscribed knowledge base')).json().items[0].id;
    await sse.waitFor((e) => e.type === 'document.ready' && e.documentId === mine);
    await sleep(100);
    sse.close();

    expect(sse.events.length).toBeGreaterThan(0);
    expect(sse.events.every((e) => (e as any).knowledgeBaseId === a)).toBe(true);
  });

  it('rejects unauthenticated clients and accepts a token in the query string', async () => {
    const anon = await openSse(port, '/api/ingestion/events');
    expect(anon.status).toBe(401);
    anon.close();

    const viaQuery = await openSse(port, `/api/ingestion/events?token=${w.token}`);
    expect(viaQuery.status).toBe(200);
    viaQuery.close();

    const badToken = await openSse(port, '/api/ingestion/events?token=not-a-jwt');
    expect(badToken.status).toBe(401);
    badToken.close();
  });

  it('sends a heartbeat comment so idle proxies keep the connection open', async () => {
    const sse = await openSse(port, '/api/ingestion/events', authz(w));
    await sleep(100);
    sse.close();
    expect(sse.raw).toMatch(/^: connected/m);
  });
});

describe('ingestion job API', () => {
  it('lists jobs with document titles, progress and status filtering', async () => {
    const kb = await createKb(w, 'list');
    const id = (await upload(w, kb, 'listed.txt', 'a document that will finish processing')).json().items[0].id;
    for (let i = 0; i < 200; i++) {
      const rs = await w.app.db.client.execute({ sql: 'SELECT status FROM ingestion_jobs WHERE document_id = ?', args: [id] });
      if ((rs.rows[0] as any)?.status === 'done') break;
      await sleep(25);
    }

    const all = await w.app.inject({ method: 'GET', url: `/api/ingestion/jobs?knowledgeBaseId=${kb}`, headers: authz(w) });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual([
      expect.objectContaining({ documentId: id, title: 'listed.txt', knowledgeBaseId: kb, status: 'done', attempts: 1 }),
    ]);
    expect(all.json()[0].chunksDone).toBeGreaterThan(0);

    const none = await w.app.inject({ method: 'GET', url: `/api/ingestion/jobs?knowledgeBaseId=${kb}&status=failed`, headers: authz(w) });
    expect(none.json()).toEqual([]);
    const anon = await w.app.inject({ method: 'GET', url: '/api/ingestion/jobs' });
    expect(anon.statusCode).toBe(401);
  });

  it('retries a failed job: it is queued again and its document goes back to pending', async () => {
    const kb = await createKb(n, 'retry');
    const docId = (await upload(n, kb, 'retry.txt', 'will fail once')).json().items[0].id;
    const job = await n.app.jobs.claimNext();
    await n.app.jobs.fail(job!.id, 'boom', false);
    await n.app.db.client.execute({ sql: `UPDATE documents SET status = 'failed', error_message = 'boom' WHERE id = ?`, args: [docId] });

    const res = await n.app.inject({ method: 'POST', url: `/api/ingestion/jobs/${job!.id}/retry`, headers: authz(n) });
    expect(res.statusCode).toBe(200);
    const row = (await n.app.db.client.execute({ sql: 'SELECT * FROM ingestion_jobs WHERE id = ?', args: [job!.id] })).rows[0] as any;
    expect(row).toMatchObject({ status: 'queued', attempts: 0 });
    const doc = (await n.app.db.client.execute({ sql: 'SELECT status, error_message FROM documents WHERE id = ?', args: [docId] })).rows[0] as any;
    expect(doc).toMatchObject({ status: 'pending', error_message: null });
  });

  it('does not retry a job that is still queued or running', async () => {
    const kb = await createKb(n, 'retry-guard');
    await upload(n, kb, 'guard.txt', 'still queued');
    const jobs = (await n.app.inject({ method: 'GET', url: `/api/ingestion/jobs?knowledgeBaseId=${kb}`, headers: authz(n) })).json();
    const res = await n.app.inject({ method: 'POST', url: `/api/ingestion/jobs/${jobs[0].id}/retry`, headers: authz(n) });
    expect(res.statusCode).toBe(409);
  });

  it('cancels a queued job and marks its document cancelled', async () => {
    const kb = await createKb(n, 'cancel');
    const docId = (await upload(n, kb, 'cancel.txt', 'never processed')).json().items[0].id;
    const [job] = (await n.app.inject({ method: 'GET', url: `/api/ingestion/jobs?knowledgeBaseId=${kb}`, headers: authz(n) })).json();

    const res = await n.app.inject({ method: 'DELETE', url: `/api/ingestion/jobs/${job.id}`, headers: authz(n) });
    expect(res.statusCode).toBe(204);
    const row = (await n.app.db.client.execute({ sql: 'SELECT status FROM ingestion_jobs WHERE id = ?', args: [job.id] })).rows[0] as any;
    expect(row.status).toBe('cancelled');
    const doc = (await n.app.db.client.execute({ sql: 'SELECT status, error_message FROM documents WHERE id = ?', args: [docId] })).rows[0] as any;
    expect(doc).toMatchObject({ status: 'failed', error_message: 'Cancelled' });
  });

  it('answers 404 for unknown jobs', async () => {
    const retry = await n.app.inject({ method: 'POST', url: '/api/ingestion/jobs/nope/retry', headers: authz(n) });
    const cancel = await n.app.inject({ method: 'DELETE', url: '/api/ingestion/jobs/nope', headers: authz(n) });
    expect([retry.statusCode, cancel.statusCode]).toEqual([404, 404]);
  });
});
