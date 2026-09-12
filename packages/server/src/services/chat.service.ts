import { randomUUID } from 'crypto';
import { ProviderFactory } from '../core/providers/factory.js';
import type { HybridRetriever } from '../core/retrieval/hybrid.retriever.js';
import type { ChatStreamEvent, Citation, ScoredChunk } from '@ragforge/shared';

export interface ChatInput {
  sessionId: string;
  knowledgeBaseId?: string;
  userMessage: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt?: string;
  providerId?: string;
  model?: string;
  temperature?: number;
  topK?: number;
  similarityThreshold?: number;
  useHybridSearch?: boolean;
}

export interface ChatServiceDeps {
  getProvider(id?: string): Promise<{ provider: string; baseUrl?: string; apiKeyEncrypted?: string; defaultLlmModel?: string } | null>;
  saveMessage(params: { id: string; sessionId: string; role: string; content: string; citationsJson?: string; tokenUsageJson?: string; latencyMs?: number }): Promise<void>;
  retriever?: HybridRetriever;
}

export class ChatService {
  constructor(private deps: ChatServiceDeps) {}

  async *stream(input: ChatInput): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const startMs = Date.now();
    const messageId = randomUUID();
    let fullResponse = '';
    const citations: Citation[] = [];

    try {
      // 1. Retrieve context if knowledge base specified
      let contextBlock = '';
      let scoredChunks: ScoredChunk[] = [];

      if (input.knowledgeBaseId && this.deps.retriever) {
        scoredChunks = await this.deps.retriever.retrieve({
          knowledgeBaseId: input.knowledgeBaseId,
          query: input.userMessage,
          topK: input.topK ?? 6,
          similarityThreshold: input.similarityThreshold ?? 0.3,
          useHybridSearch: input.useHybridSearch ?? true,
        });

        if (scoredChunks.length > 0) {
          contextBlock = this.buildContextBlock(scoredChunks);
          scoredChunks.forEach((chunk, i) => {
            const citation: Citation = {
              id: randomUUID(),
              chunkId: chunk.id,
              documentId: chunk.documentId,
              documentTitle: chunk.documentTitle ?? chunk.documentId,
              citationIndex: i + 1,
              pageNumber: chunk.metadata?.pageNumber,
              sectionHeader: chunk.metadata?.sectionHeader,
              snippet: chunk.content.slice(0, 300),
              similarityScore: chunk.score,
            };
            citations.push(citation);
          });
        }
      }

      // 2. Build messages for LLM
      const systemPrompt = input.systemPrompt
        ?? `You are a helpful AI assistant${input.knowledgeBaseId ? ' with access to a knowledge base' : ''}. Answer clearly and concisely.${contextBlock ? '\n\nUse the following context to answer the user\'s question. Cite sources with [N] notation:\n\n' + contextBlock : ''}`;

      const messages = [
        { role: 'system' as const, content: systemPrompt },
        ...input.history,
        { role: 'user' as const, content: input.userMessage },
      ];

      // 3. Get LLM provider
      const providerRow = await this.deps.getProvider(input.providerId);
      if (!providerRow) {
        yield { type: 'error', error: 'No LLM provider configured. Please add a provider in Settings.' };
        return;
      }

      const apiKey = providerRow.apiKeyEncrypted ? ProviderFactory.decryptApiKey(providerRow.apiKeyEncrypted) : undefined;
      const llm = ProviderFactory.create(providerRow.provider as any, {
        baseUrl: providerRow.baseUrl ?? undefined,
        apiKey,
      });

      if (!llm.streamChat) {
        yield { type: 'error', error: `Provider "${providerRow.provider}" does not support chat.` };
        return;
      }

      // 4. Emit citations before streaming
      for (const citation of citations) {
        yield { type: 'citation', citation };
      }

      // 5. Stream tokens
      const model = input.model ?? providerRow.defaultLlmModel ?? 'llama3';
      for await (const token of llm.streamChat!({ model, messages, temperature: input.temperature ?? 0.7 })) {
        fullResponse += token;
        yield { type: 'token', token };
      }

      const latencyMs = Date.now() - startMs;

      // 6. Persist the assistant message
      await this.deps.saveMessage({
        id: messageId,
        sessionId: input.sessionId,
        role: 'assistant',
        content: fullResponse,
        citationsJson: citations.length ? JSON.stringify(citations) : undefined,
        latencyMs,
      });

      yield { type: 'done', messageId, latencyMs };
    } catch (err: any) {
      yield { type: 'error', error: err?.message ?? 'Chat error' };
    }
  }

  private buildContextBlock(chunks: ScoredChunk[]): string {
    return chunks
      .map((c, i) => {
        const header = c.metadata?.breadcrumb ? ` (${c.metadata.breadcrumb})` : '';
        return `[${i + 1}] ${c.documentTitle ?? c.documentId}${header}\n${c.content}`;
      })
      .join('\n\n---\n\n');
  }
}
