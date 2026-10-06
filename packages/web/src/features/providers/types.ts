export interface ProviderSpec {
  type: string;
  label: string;
  description: string;
  supportsLlm: boolean;
  supportsEmbeddings: boolean;
  needsApiKey: boolean;
  usesBaseUrl: boolean;
  defaultBaseUrl?: string;
  defaultLlmModel: string;
  defaultEmbeddingModel?: string;
  keyHelpUrl?: string;
  oauthConfigured: boolean;
}

export interface ProviderConfig {
  id: string;
  name: string;
  provider: string;
  baseUrl: string | null;
  hasApiKey: boolean;
  isDefaultLlm: boolean;
  isDefaultEmbedding: boolean;
  defaultLlmModel: string | null;
  defaultEmbeddingModel: string | null;
}

export type TestResult = { ok: true; models: string[] } | { ok: false; message: string };
