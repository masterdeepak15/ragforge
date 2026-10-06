import type { ProviderConfig, ProviderSpec } from './types';

/**
 * Why documents cannot be indexed right now, or null when indexing is set up.
 * Indexing needs a provider that creates embeddings; Claude (Anthropic) and Groq can only write answers.
 */
export function indexingGap(providers: ProviderConfig[], specs: ProviderSpec[]): string | null {
  if (providers.some((p) => p.isDefaultEmbedding)) return null;
  if (providers.length === 0) return 'Documents cannot be indexed until you add an AI provider.';

  const specOf = (p: ProviderConfig) => specs.find((s) => s.type === p.provider);
  if (providers.some((p) => specOf(p)?.supportsEmbeddings)) {
    return 'Documents cannot be indexed until a provider is chosen for indexing. Use the “Use … for indexing” button in Settings.';
  }
  const labels = [...new Set(providers.map((p) => specOf(p)?.label ?? p.provider))];
  return `Documents cannot be indexed yet. ${labels.join(' and ')} cannot create embeddings, so add Ollama, OpenAI or Google Gemini for indexing.`;
}
