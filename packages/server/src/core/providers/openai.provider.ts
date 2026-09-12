import OpenAI from 'openai';
import type { ILLMProvider, IEmbeddingProvider, IOAuthProvider, ProviderConfig, OAuthCredentials } from './provider.interface.js';
import type { LLMStreamOptions, EmbeddingOptions, EmbeddingResult, AIProviderModel } from '@ragforge/shared';
import { generateCodeChallenge } from './crypto.js';

// OpenAI does not have a standard OAuth2 provider flow for API access —
// we implement a pseudo-OAuth UI that collects the API key via a styled
// "Connect OpenAI" modal and stores it encrypted, matching the button UX.
export class OpenAIProvider implements ILLMProvider, IEmbeddingProvider {
  private client: OpenAI;

  constructor(config: ProviderConfig) {
    const apiKey = config.apiKey || config.oauthCredentials?.accessToken || '';
    this.client = new OpenAI({ apiKey, baseURL: config.baseUrl });
  }

  async *streamChat(options: LLMStreamOptions): AsyncGenerator<string, void, unknown> {
    const stream = await this.client.chat.completions.create({
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) yield content;
    }
  }

  async listModels(): Promise<AIProviderModel[]> {
    try {
      const { data } = await this.client.models.list();
      return data
        .filter(m => m.id.startsWith('gpt-') || m.id.startsWith('o1') || m.id.startsWith('o3'))
        .map(m => ({
          id: m.id,
          name: m.id,
          type: 'llm' as const,
        }));
    } catch {
      return OPENAI_STATIC_MODELS;
    }
  }

  async generateEmbeddings(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const res = await this.client.embeddings.create({
      model: options.model,
      input: options.texts,
    });
    return {
      embeddings: res.data.map(d => d.embedding),
      usage: {
        promptTokens: res.usage.prompt_tokens,
        totalTokens: res.usage.total_tokens,
      },
    };
  }

  async listEmbeddingModels(): Promise<AIProviderModel[]> {
    return [
      { id: 'text-embedding-3-small', name: 'text-embedding-3-small', type: 'embedding', dimension: 1536 },
      { id: 'text-embedding-3-large', name: 'text-embedding-3-large', type: 'embedding', dimension: 3072 },
      { id: 'text-embedding-ada-002', name: 'text-embedding-ada-002', type: 'embedding', dimension: 1536 },
    ];
  }
}

const OPENAI_STATIC_MODELS: AIProviderModel[] = [
  { id: 'gpt-4o', name: 'GPT-4o', type: 'llm', contextWindow: 128000 },
  { id: 'gpt-4o-mini', name: 'GPT-4o mini', type: 'llm', contextWindow: 128000 },
  { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', type: 'llm', contextWindow: 128000 },
  { id: 'o3-mini', name: 'o3-mini', type: 'llm', contextWindow: 200000 },
];
