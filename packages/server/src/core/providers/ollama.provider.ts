import type { ILLMProvider, IEmbeddingProvider, ProviderConfig } from './provider.interface.js';
import type { LLMStreamOptions, EmbeddingOptions, EmbeddingResult, AIProviderModel } from '@ragforge/shared';

export class OllamaProvider implements ILLMProvider, IEmbeddingProvider {
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.baseUrl = config.baseUrl?.replace(/\/$/, '') || 'http://localhost:11434';
  }

  async *streamChat(options: LLMStreamOptions): AsyncGenerator<string, void, unknown> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: true,
        options: {
          temperature: options.temperature ?? 0.7,
          num_predict: options.maxTokens,
        },
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value, { stream: true }).split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.message?.content) yield json.message.content;
          if (json.done) return;
        } catch {
          // partial JSON chunk, skip
        }
      }
    }
  }

  async listModels(): Promise<AIProviderModel[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return [];
      const data = await res.json() as { models?: Array<{ name: string; details?: { parameter_size?: string } }> };
      return (data.models || []).map(m => ({
        id: m.name,
        name: m.name,
        type: 'both' as const,
      }));
    } catch {
      return [];
    }
  }

  async generateEmbeddings(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const embeddings: number[][] = [];
    for (const text of options.texts) {
      const res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: options.model, prompt: text }),
      });
      if (!res.ok) throw new Error(`Ollama embed error: ${res.status}`);
      const data = await res.json() as { embedding: number[] };
      embeddings.push(data.embedding);
    }
    return { embeddings };
  }

  async listEmbeddingModels(): Promise<AIProviderModel[]> {
    const all = await this.listModels();
    return all.map(m => ({ ...m, type: 'embedding' as const }));
  }
}
