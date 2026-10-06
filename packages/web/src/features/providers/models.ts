const EMBEDDING = /embed|bge-|minilm/i;
const NOT_CHAT = /whisper|tts|dall-e|moderation|image/i;

/** Splits a provider's model list by purpose, so answers and indexing each offer only models that fit. */
export function splitModels(models: string[]): { chat: string[]; embedding: string[] } {
  const embedding = models.filter((m) => EMBEDDING.test(m));
  const chat = models.filter((m) => !EMBEDDING.test(m) && !NOT_CHAT.test(m));
  // Never leave a dropdown empty: a provider with only odd names still gets its full list.
  return { chat: chat.length ? chat : models, embedding };
}

/** The wanted model when the provider has it, otherwise the first one it does have. */
export function pickModel(options: string[], wanted: string): string {
  if (options.includes(wanted)) return wanted;
  const withTag = options.find((o) => o.split(':')[0] === wanted);
  return withTag ?? options[0] ?? wanted;
}
