import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { ProviderFactory } from '../core/providers/factory.js';

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
