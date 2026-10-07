import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { createKb, buildMultipart } from '../test/multipart.js';
import { ApiKeyService } from '../auth/api-keys.js';

let t: TestApp;
let limited: TestApp;
let port: number;
let limitedPort: number;
let keys: ApiKeyService;
let kbA: string;
let kbB: string;
let docA: string;
let docB: string;
let bigDoc: string;
let allKey: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const url = (p: number) => new URL(`http://127.0.0.1:${p}/mcp`);

async function upload(app: TestApp, kb: string, filename: string, text: string): Promise<string> {
  const { payload, headers } = buildMultipart([
    { name: 'knowledgeBaseId', value: kb },
    { name: 'file', filename, data: Buffer.from(text) },
  ]);
  const res = await app.app.inject({ method: 'POST', url: '/api/documents/upload', headers: { authorization: `Bearer ${app.token}`, ...headers }, payload });
  return res.json().items[0].id;
}
async function untilReady(app: TestApp, docId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const rs = await app.app.db.client.execute({ sql: 'SELECT status, error_message FROM documents WHERE id = ?', args: [docId] });
    const row = rs.rows[0] as any;
    if (row.status === 'ready') return;
    if (row.status === 'failed') throw new Error(`ingestion failed: ${row.error_message}`);
    await sleep(25);
  }
  throw new Error('document never became ready');
}
async function connect(key: string, p = port): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url(p), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  return { isError: Boolean(res.isError), text, json: () => JSON.parse(text) };
}

beforeAll(async () => {
  t = await createTestApp({ worker: true });
  limited = await createTestApp({ mcpRateLimit: 3 });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  await limited.app.listen({ port: 0, host: '127.0.0.1' });
  port = (t.app.server.address() as any).port;
  limitedPort = (limited.app.server.address() as any).port;
  keys = new ApiKeyService(t.app.db);

  kbA = await createKb(t, 'alpha-kb');
  kbB = await createKb(t, 'beta-kb');
  docA = await upload(t, kbA, 'alpha.txt', 'The zeppelin hangar in Friedrichshafen was enormous and cold.');
  docB = await upload(t, kbB, 'beta.txt', 'Secret beta document about the quokka research programme.');
  const paragraphs = Array.from({ length: 60 }, (_, i) => `Section ${i} about the zeppelin fleet. ` + 'Airship engineering notes continue here. '.repeat(120));
  bigDoc = await upload(t, kbA, 'big.txt', paragraphs.join('\n\n'));
  await Promise.all([untilReady(t, docA), untilReady(t, docB), untilReady(t, bigDoc)]);
  allKey = (await keys.create({ name: 'all', scopeKbIds: null, createdBy: 'test' })).key;
}, 60_000);
afterAll(async () => {
  await t.close();
  await limited.close();
});

describe('MCP /mcp endpoint', () => {
  it('lists the four read-only tools', async () => {
    const client = await connect(allKey);
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(['get_document', 'list_documents', 'list_knowledge_bases', 'search_knowledge']);
    await client.close();
  });

  it('search_knowledge returns matching chunks with document titles', async () => {
    const client = await connect(allKey);
    const res = await call(client, 'search_knowledge', { query: 'quokka research', knowledge_base: kbB });
    expect(res.isError).toBe(false);
    const hit = res.json().results[0];
    expect(hit).toMatchObject({ document_id: docB, document_title: 'beta.txt', knowledge_base_id: kbB });
    expect(hit.text).toContain('quokka');
    expect(typeof hit.score).toBe('number');
    expect(hit.chunk_index).toBe(0);
    await client.close();
  });

  it('searches every accessible knowledge base when none is named', async () => {
    const client = await connect(allKey);
    const res = await call(client, 'search_knowledge', { query: 'quokka zeppelin', top_k: 10 });
    const kbs = new Set(res.json().results.map((r: any) => r.knowledge_base_id));
    expect(kbs).toEqual(new Set([kbA, kbB]));
    await client.close();
  });

  it('clamps top_k to 20', async () => {
    const client = await connect(allKey);
    const res = await call(client, 'search_knowledge', { query: 'zeppelin fleet airship', knowledge_base: kbA, top_k: 500 });
    expect(res.isError).toBe(false);
    expect(res.json().results).toHaveLength(20);
    await client.close();
  });

  it('keeps a scoped key inside its knowledge bases', async () => {
    const { key } = await keys.create({ name: 'only-a', scopeKbIds: [kbA], createdBy: 'test' });
    const client = await connect(key);

    const list = await call(client, 'list_knowledge_bases');
    expect(list.json().knowledge_bases.map((k: any) => k.id)).toEqual([kbA]);

    const blockedSearch = await call(client, 'search_knowledge', { query: 'quokka', knowledge_base: kbB });
    expect(blockedSearch.isError).toBe(true);
    expect(blockedSearch.text).not.toContain('Secret beta');

    const blockedDoc = await call(client, 'get_document', { document_id: docB });
    expect(blockedDoc.isError).toBe(true);
    expect(blockedDoc.text).not.toContain('quokka');

    const blockedList = await call(client, 'list_documents', { knowledge_base: kbB });
    expect(blockedList.isError).toBe(true);

    const open = await call(client, 'search_knowledge', { query: 'quokka zeppelin', top_k: 20 });
    expect(open.json().results.every((r: any) => r.knowledge_base_id === kbA)).toBe(true);
    await client.close();
  });

  it('list_documents and get_document expose document metadata and paginated chunks', async () => {
    const client = await connect(allKey);
    const docs = await call(client, 'list_documents', { knowledge_base: kbA });
    expect(docs.json().documents.map((d: any) => d.id).sort()).toEqual([docA, bigDoc].sort());
    expect(docs.json().documents[0]).toMatchObject({ status: 'ready' });

    const page1 = (await call(client, 'get_document', { document_id: bigDoc, limit: 5 })).json();
    expect(page1.document).toMatchObject({ id: bigDoc, title: 'big.txt', knowledge_base_id: kbA });
    expect(page1.chunks).toHaveLength(5);
    expect(page1.chunks[0].index).toBe(0);
    expect(page1.next_offset).toBe(5);

    const page2 = (await call(client, 'get_document', { document_id: bigDoc, offset: page1.next_offset, limit: 5 })).json();
    expect(page2.chunks[0].index).toBe(5);

    const unknown = await call(client, 'get_document', { document_id: 'missing' });
    expect(unknown.isError).toBe(true);
    await client.close();
  });

  it('rejects missing, malformed and unknown keys with 401', async () => {
    const post = (headers: Record<string, string>) =>
      fetch(url(port), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: 'Bearer nonsense' })).status).toBe(401);
    expect((await post({ authorization: 'Bearer rf_' + 'a'.repeat(43) })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${t.token}` })).status).toBe(401); // a user JWT is not an API key
    const res = await post({});
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect((await res.json()).error.message).toMatch(/unauthorized/i);
    await expect(connect('rf_' + 'b'.repeat(43))).rejects.toThrow();
  });

  it('rejects the very next call after a key is revoked', async () => {
    const created = await keys.create({ name: 'short-lived', scopeKbIds: null, createdBy: 'test' });
    const client = await connect(created.key);
    expect((await call(client, 'list_knowledge_bases')).isError).toBe(false);
    await keys.revoke(created.id);
    await expect(call(client, 'list_knowledge_bases')).rejects.toThrow();
    await client.close().catch(() => {});
  });

  it('answers 405 to GET and DELETE (stateless server)', async () => {
    const headers = { authorization: `Bearer ${allKey}`, accept: 'text/event-stream' };
    expect((await fetch(url(port), { method: 'GET', headers })).status).toBe(405);
    expect((await fetch(url(port), { method: 'DELETE', headers })).status).toBe(405);
  });

  it('rate-limits each key', async () => {
    const { key } = await new ApiKeyService(limited.app.db).create({ name: 'rl', scopeKbIds: null, createdBy: 'test' });
    const rpc = () =>
      fetch(url(limitedPort), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await rpc()).status);
    expect(statuses.slice(0, 3).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(3)).toEqual([429, 429]);
    const blocked = await rpc();
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});

describe('MCP search follows the knowledge base retrieval settings', () => {
  /** Runs a search while recording how the retriever was asked. */
  async function searchRecording(args: Record<string, unknown>) {
    const asked: any[] = [];
    const original = t.app.retriever.retrieve.bind(t.app.retriever);
    (t.app.retriever as any).retrieve = async (q: any) => {
      asked.push(q);
      return original(q);
    };
    const client = await connect(allKey);
    try {
      const res = await call(client, 'search_knowledge', args);
      return { asked, res };
    } finally {
      (t.app.retriever as any).retrieve = original;
      await client.close();
    }
  }
  const save = (kb: string, payload: Record<string, unknown>) =>
    t.app.inject({ method: 'PUT', url: `/api/knowledge-bases/${kb}/retrieval-settings`, headers: { authorization: `Bearer ${t.token}` }, payload });
  const reset = (kb: string) => t.app.inject({ method: 'DELETE', url: `/api/knowledge-bases/${kb}/retrieval-settings`, headers: { authorization: `Bearer ${t.token}` } });

  it('uses the saved settings when the caller does not choose', async () => {
    await save(kbB, { topK: 3, minSimilarity: 0, useHybridSearch: false, vectorWeight: 0.9, bm25Weight: 0.1 });
    try {
      const { asked, res } = await searchRecording({ query: 'quokka research', knowledge_base: kbB });
      expect(res.isError).toBe(false);
      expect(asked[0]).toMatchObject({ knowledgeBaseId: kbB, topK: 3, similarityThreshold: 0, useHybridSearch: false, vectorWeight: 0.9, bm25Weight: 0.1 });
    } finally {
      await reset(kbB);
    }
  });

  it('lets the caller override how many results with top_k', async () => {
    await save(kbB, { topK: 3, minSimilarity: 0 });
    try {
      const { asked } = await searchRecording({ query: 'quokka research', knowledge_base: kbB, top_k: 2 });
      expect(asked[0]).toMatchObject({ topK: 2 });
    } finally {
      await reset(kbB);
    }
  });

  it('applies each knowledge base its own settings when searching several', async () => {
    await save(kbA, { minSimilarity: 0, topK: 4 });
    await save(kbB, { minSimilarity: 0, topK: 2 });
    try {
      const { asked } = await searchRecording({ query: 'quokka zeppelin' });
      expect(asked.find((q) => q.knowledgeBaseId === kbA)).toMatchObject({ topK: 4 });
      expect(asked.find((q) => q.knowledgeBaseId === kbB)).toMatchObject({ topK: 2 });
    } finally {
      await reset(kbA);
      await reset(kbB);
    }
  });
});

describe('how an AI chooses between knowledge bases', () => {
  it('is told to look at the list first and pick by name and description, or to search all when unsure', async () => {
    const client = await connect(allKey);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((x) => [x.name, x.description ?? '']));
    expect(byName.list_knowledge_bases).toMatch(/name and description/i);
    expect(byName.search_knowledge).toMatch(/list_knowledge_bases/);
    expect(byName.search_knowledge).toMatch(/omit.*search (all|every)/i);
    const search: any = tools.find((x) => x.name === 'search_knowledge');
    expect(search.inputSchema.properties.knowledge_base.description).toMatch(/list_knowledge_bases/);
    await client.close();
  });
});
