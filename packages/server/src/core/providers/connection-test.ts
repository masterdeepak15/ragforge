import type { AIProviderType } from '@ragforge/shared';

export interface ProviderSpec {
  type: AIProviderType;
  label: string;
  description: string;
  supportsLlm: boolean;
  supportsEmbeddings: boolean;
  needsApiKey: boolean;
  /** Whether the user normally chooses the server address (self-hosted). */
  usesBaseUrl: boolean;
  defaultBaseUrl?: string;
  defaultLlmModel: string;
  defaultEmbeddingModel?: string;
  keyHelpUrl?: string;
}

/** What each provider can do and the models RAGForge picks unless told otherwise. */
export const PROVIDER_SPECS: Record<AIProviderType, ProviderSpec> = {
  ollama: {
    type: 'ollama', label: 'Ollama (local)', description: 'Models running on your own machine or server. Free, private, no key needed.',
    supportsLlm: true, supportsEmbeddings: true, needsApiKey: false, usesBaseUrl: true, defaultBaseUrl: 'http://localhost:11434',
    defaultLlmModel: 'llama3.1', defaultEmbeddingModel: 'nomic-embed-text',
  },
  openai: {
    type: 'openai', label: 'OpenAI', description: 'GPT models for answers and text-embedding models for indexing.',
    supportsLlm: true, supportsEmbeddings: true, needsApiKey: true, usesBaseUrl: false,
    defaultLlmModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small', keyHelpUrl: 'https://platform.openai.com/api-keys',
  },
  gemini: {
    type: 'gemini', label: 'Google Gemini', description: 'Gemini models for answers and embeddings.',
    supportsLlm: true, supportsEmbeddings: true, needsApiKey: true, usesBaseUrl: false,
    defaultLlmModel: 'gemini-1.5-flash', defaultEmbeddingModel: 'text-embedding-004', keyHelpUrl: 'https://aistudio.google.com/apikey',
  },
  anthropic: {
    type: 'anthropic', label: 'Anthropic', description: 'Claude models for answers. It has no embeddings API, so pair it with another provider for indexing.',
    supportsLlm: true, supportsEmbeddings: false, needsApiKey: true, usesBaseUrl: false,
    defaultLlmModel: 'claude-haiku-4-5-20251001', keyHelpUrl: 'https://console.anthropic.com/settings/keys',
  },
  groq: {
    type: 'groq', label: 'Groq', description: 'Very fast open models for answers. It has no embeddings API, so pair it with another provider for indexing.',
    supportsLlm: true, supportsEmbeddings: false, needsApiKey: true, usesBaseUrl: false,
    defaultLlmModel: 'llama-3.1-8b-instant', keyHelpUrl: 'https://console.groq.com/keys',
  },
};

export type ConnectionResult = { ok: true; models: string[] } | { ok: false; message: string };

/** Returns an error message for an address RAGForge must not call, or null when it is fine. */
export function validateBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? null : 'The address must start with http:// or https://.';
  } catch {
    return 'The address must start with http:// or https://, for example http://localhost:11434.';
  }
}

const HOSTED_BASES: Partial<Record<AIProviderType, string>> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

function buildRequest(type: AIProviderType, base: string, apiKey?: string): { url: string; headers: Record<string, string> } {
  switch (type) {
    case 'ollama':
      return { url: `${base}/api/tags`, headers: {} };
    case 'anthropic':
      return { url: `${base}/v1/models`, headers: { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' } };
    case 'gemini':
      return { url: `${base}/v1beta/models?key=${encodeURIComponent(apiKey ?? '')}`, headers: {} };
    default: // openai, groq: OpenAI-compatible
      return { url: `${base}/models`, headers: { Authorization: `Bearer ${apiKey ?? ''}` } };
  }
}

function modelNames(type: AIProviderType, body: any): string[] {
  const names: string[] =
    type === 'ollama' ? (body?.models ?? []).map((m: any) => m.name)
    : type === 'gemini' ? (body?.models ?? []).map((m: any) => String(m.name).replace(/^models\//, ''))
    : (body?.data ?? []).map((m: any) => m.id);
  return names.filter((n) => typeof n === 'string').sort().slice(0, 200);
}

/**
 * Makes one real, authenticated request so a wrong key or address is caught when the user adds the
 * provider, not later during indexing. Messages are written for the person using the settings page and
 * never contain the key.
 */
export async function testProviderConnection(
  type: AIProviderType,
  settings: { baseUrl?: string; apiKey?: string },
  opts: { timeoutMs?: number } = {},
): Promise<ConnectionResult> {
  const spec = PROVIDER_SPECS[type];
  if (spec.needsApiKey && !settings.apiKey) return { ok: false, message: `${spec.label} needs an API key.` };

  const base = (settings.baseUrl?.trim() || spec.defaultBaseUrl || HOSTED_BASES[type] || '').replace(/\/+$/, '');
  const invalid = validateBaseUrl(base);
  if (invalid) return { ok: false, message: invalid };

  const { url, headers } = buildRequest(type, base, settings.apiKey);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const host = new URL(base).host;

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { ok: false, message: `${spec.label} did not answer in time (${Math.round(timeoutMs / 1000)} s). Check the address and that the server is running.` };
    }
    return { ok: false, message: `Could not reach ${host}. Check the address and that the server is running.` };
  }

  if (res.status === 401 || res.status === 403 || (type === 'gemini' && res.status === 400)) {
    return { ok: false, message: `The API key was rejected by ${spec.label}. Check that it is copied in full and has access.` };
  }
  if (!res.ok) return { ok: false, message: `${spec.label} answered with an error (HTTP ${res.status}).` };

  try {
    return { ok: true, models: modelNames(type, await res.json()) };
  } catch {
    return { ok: false, message: `${host} answered, but it does not look like ${spec.label}.` };
  }
}
