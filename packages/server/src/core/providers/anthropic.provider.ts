import Anthropic from '@anthropic-ai/sdk';
import type { ILLMProvider, ProviderConfig } from './provider.interface.js';
import type { LLMStreamOptions, AIProviderModel } from '@ragforge/shared';

export class AnthropicProvider implements ILLMProvider {
  private client: Anthropic;

  constructor(config: ProviderConfig) {
    const apiKey = config.apiKey || config.oauthCredentials?.accessToken || '';
    this.client = new Anthropic({ apiKey, baseURL: config.baseUrl });
  }

  async *streamChat(options: LLMStreamOptions): AsyncGenerator<string, void, unknown> {
    const systemMsg = options.messages.find(m => m.role === 'system');
    const userMsgs = options.messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const stream = await this.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      system: systemMsg?.content,
      messages: userMsgs,
      stream: true,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }

  async listModels(): Promise<AIProviderModel[]> {
    return ANTHROPIC_MODELS;
  }
}

const ANTHROPIC_MODELS: AIProviderModel[] = [
  { id: 'claude-opus-5', name: 'Claude Opus 5', type: 'llm', contextWindow: 200000 },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', type: 'llm', contextWindow: 200000 },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', type: 'llm', contextWindow: 200000 },
];
