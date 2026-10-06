import { describe, it, expect } from 'vitest';
import { ChatService } from './chat.service.js';
import { ProviderFactory } from '../core/providers/factory.js';

describe('ChatService citations', () => {
  it('cites documents by their title, not their id', async () => {
    ProviderFactory.register('ollama', () => ({
      async *streamChat() {
        yield 'ok';
      },
    }));
    const service = new ChatService({
      getProvider: async () => ({ provider: 'ollama', defaultLlmModel: 'm' }),
      saveMessage: async () => {},
      getDocumentTitles: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 'Resume.pdf'])),
      retriever: {
        retrieve: async () => [{ id: 'c1', documentId: 'doc-1', content: 'Seven years of .NET', score: 0.9, metadata: {} }],
      } as any,
    });

    const events: any[] = [];
    for await (const e of service.stream({ sessionId: 's', knowledgeBaseId: 'kb', userMessage: 'q', history: [] })) events.push(e);

    const citation = events.find((e) => e.type === 'citation').citation;
    expect(citation.documentTitle).toBe('Resume.pdf');
  });
});
