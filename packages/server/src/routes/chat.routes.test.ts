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

describe('PATCH /api/chat/sessions/:id (choosing the knowledge base of a chat)', () => {
  const headers = () => ({ authorization: `Bearer ${t.token}` });
  const newSession = async (knowledgeBaseId?: string) =>
    (await t.app.inject({ method: 'POST', url: '/api/chat/sessions', headers: headers(), payload: knowledgeBaseId ? { knowledgeBaseId } : {} })).json();
  const patch = (id: string, payload: unknown) => t.app.inject({ method: 'PATCH', url: `/api/chat/sessions/${id}`, headers: headers(), payload: payload as any });

  it('attaches a knowledge base to a chat that had none, and later questions search it', async () => {
    const kb = await createKb(t, 'attach-me');
    const session = await newSession();
    expect(session.knowledge_base_id).toBeNull();

    const res = await patch(session.id, { knowledgeBaseId: kb });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: session.id, knowledge_base_id: kb });

    let searched: any;
    const original = t.app.retriever.retrieve.bind(t.app.retriever);
    (t.app.retriever as any).retrieve = async (q: any) => {
      searched = q;
      return [];
    };
    try {
      await t.app.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/stream`, headers: headers(), payload: { message: 'hi' } });
    } finally {
      (t.app.retriever as any).retrieve = original;
    }
    expect(searched).toMatchObject({ knowledgeBaseId: kb });
  });

  it('detaches it again with null', async () => {
    const kb = await createKb(t, 'detach-me');
    const session = await newSession(kb);
    const res = await patch(session.id, { knowledgeBaseId: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().knowledge_base_id).toBeNull();
  });

  it('refuses a knowledge base that does not exist, and leaves the chat as it was', async () => {
    const kb = await createKb(t, 'keep-me');
    const session = await newSession(kb);
    const res = await patch(session.id, { knowledgeBaseId: 'no-such-kb' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/knowledge base/i);
    const after = (await t.app.inject({ method: 'GET', url: `/api/chat/sessions/${session.id}`, headers: headers() })).json();
    expect(after.knowledge_base_id).toBe(kb);
  });

  it('answers 404 for an unknown chat and 400 for a body without knowledgeBaseId', async () => {
    expect((await patch('no-such-chat', { knowledgeBaseId: null })).statusCode).toBe(404);
    const session = await newSession();
    expect((await patch(session.id, {})).statusCode).toBe(400);
    expect((await patch(session.id, { knowledgeBaseId: 5 })).statusCode).toBe(400);
  });

  it('requires a signed-in user', async () => {
    const session = await newSession();
    expect((await t.app.inject({ method: 'PATCH', url: `/api/chat/sessions/${session.id}`, payload: { knowledgeBaseId: null } })).statusCode).toBe(401);
  });
});

describe('DELETE /api/chat/sessions/:id', () => {
  const headers = () => ({ authorization: `Bearer ${t.token}` });
  const newSession = async () => (await t.app.inject({ method: 'POST', url: '/api/chat/sessions', headers: headers(), payload: { title: 'to delete' } })).json();
  const messagesOf = async (id: string) => Number(((await t.app.db.client.execute({ sql: 'SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?', args: [id] })).rows[0] as any).n);

  it('deletes the chat together with all of its messages, leaving nothing behind', async () => {
    const session = await newSession();
    for (const [i, role] of ['user', 'assistant'].entries()) {
      await t.app.db.client.execute({ sql: `INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)`, args: [`m-${session.id}-${i}`, session.id, role, 'text'] });
    }
    expect(await messagesOf(session.id)).toBe(2);

    const res = await t.app.inject({ method: 'DELETE', url: `/api/chat/sessions/${session.id}`, headers: headers() });
    expect(res.statusCode).toBe(204);
    expect(await messagesOf(session.id)).toBe(0);
    expect((await t.app.inject({ method: 'GET', url: `/api/chat/sessions/${session.id}`, headers: headers() })).statusCode).toBe(404);
  });

  it('does not touch other chats', async () => {
    const keep = await newSession();
    const drop = await newSession();
    await t.app.db.client.execute({ sql: `INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, 'user', 'hi')`, args: [`m-${keep.id}`, keep.id] });
    await t.app.inject({ method: 'DELETE', url: `/api/chat/sessions/${drop.id}`, headers: headers() });
    expect(await messagesOf(keep.id)).toBe(1);
    expect((await t.app.inject({ method: 'GET', url: `/api/chat/sessions/${keep.id}`, headers: headers() })).statusCode).toBe(200);
  });

  it('answers 404 for a chat that does not exist, and needs a signed-in user', async () => {
    expect((await t.app.inject({ method: 'DELETE', url: '/api/chat/sessions/no-such-chat', headers: headers() })).statusCode).toBe(404);
    const session = await newSession();
    expect((await t.app.inject({ method: 'DELETE', url: `/api/chat/sessions/${session.id}` })).statusCode).toBe(401);
  });
});
