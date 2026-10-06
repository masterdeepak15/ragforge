import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { ProviderFactory } from '../core/providers/factory.js';
import { createKb } from '../test/multipart.js';

let t: TestApp;
let seen: { config: any; options: any } | undefined;

beforeAll(async () => {
  t = await createTestApp();
  ProviderFactory.register('anthropic', (config) => ({
    async *streamChat(options: any) {
      seen = { config, options };
      yield 'Hello ';
      yield 'there';
    },
  }));
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/providers',
    headers: { authorization: `Bearer ${t.token}` },
    payload: { provider: 'anthropic', apiKey: 'sk-ant-secret', defaultLlmModel: 'claude-test-model' },
  });
  expect(res.statusCode).toBe(201);
});
afterAll(async () => {
  await t.close();
});

async function ask(message: string) {
  const headers = { authorization: `Bearer ${t.token}` };
  const session = (await t.app.inject({ method: 'POST', url: '/api/chat/sessions', headers, payload: {} })).json();
  const res = await t.app.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/stream`, headers, payload: { message } });
  const events = res.body
    .split('\n\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
  return { sessionId: session.id as string, events };
}

describe('POST /api/chat/sessions/:id/stream', () => {
  it('calls the answering provider with its saved API key and model, and stores the reply', async () => {
    seen = undefined;
    const { sessionId, events } = await ask('hi');

    expect(events.filter((e) => e.type === 'token').map((e) => e.token).join('')).toBe('Hello there');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(events.some((e) => e.type === 'error')).toBe(false);

    const call = seen as { config: any; options: any } | undefined;
    expect(call?.config.apiKey).toBe('sk-ant-secret');
    expect(call?.options.model).toBe('claude-test-model');

    const msgs = (await t.app.inject({ method: 'GET', url: `/api/chat/sessions/${sessionId}/messages`, headers: { authorization: `Bearer ${t.token}` } })).json();
    expect(msgs.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1].content).toBe('Hello there');
  });
});

describe('chat searches with the knowledge base retrieval settings', () => {
  async function askWith(kbId: string, body: Record<string, unknown> = {}) {
    const headers = { authorization: `Bearer ${t.token}` };
    const session = (await t.app.inject({ method: 'POST', url: '/api/chat/sessions', headers, payload: { knowledgeBaseId: kbId } })).json();
    let seenQuery: any;
    const original = t.app.retriever.retrieve.bind(t.app.retriever);
    (t.app.retriever as any).retrieve = async (q: any) => {
      seenQuery = q;
      return [];
    };
    try {
      await t.app.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/stream`, headers, payload: { message: 'hi', ...body } });
    } finally {
      (t.app.retriever as any).retrieve = original;
    }
    return seenQuery;
  }

  it('uses the defaults when nothing was saved', async () => {
    const kb = await createKb(t, 'plain');
    expect(await askWith(kb)).toMatchObject({ topK: 6, useHybridSearch: true, vectorWeight: 0.7, bm25Weight: 0.3, similarityThreshold: 0.3 });
  });

  it('uses what was saved for that knowledge base', async () => {
    const kb = await createKb(t, 'tuned');
    await t.app.inject({ method: 'PUT', url: `/api/knowledge-bases/${kb}/retrieval-settings`, headers: { authorization: `Bearer ${t.token}` }, payload: { topK: 11, minSimilarity: 0.55, useHybridSearch: false, vectorWeight: 0.9, bm25Weight: 0.1 } });
    expect(await askWith(kb)).toMatchObject({ knowledgeBaseId: kb, topK: 11, similarityThreshold: 0.55, useHybridSearch: false, vectorWeight: 0.9, bm25Weight: 0.1 });
  });

  it('lets a request override a saved setting', async () => {
    const kb = await createKb(t, 'override');
    await t.app.inject({ method: 'PUT', url: `/api/knowledge-bases/${kb}/retrieval-settings`, headers: { authorization: `Bearer ${t.token}` }, payload: { topK: 11 } });
    expect(await askWith(kb, { topK: 2 })).toMatchObject({ topK: 2 });
  });
});
