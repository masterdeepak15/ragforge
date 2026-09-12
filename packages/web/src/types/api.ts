export type UserRole = 'admin' | 'member' | 'viewer';
export type AIProviderType = 'ollama' | 'openai' | 'anthropic' | 'gemini' | 'groq';
export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type DocumentFileType = 'pdf' | 'docx' | 'txt' | 'md' | 'url' | 'other';
export type StorageMode = 'sqlite' | 'postgres';

export interface User {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  avatarUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SetupStatus {
  isInitialized: boolean;
  hasAdminUser: boolean;
  hasDefaultProvider: boolean;
  hasKnowledgeBase: boolean;
  version: string;
  storageMode: StorageMode;
}

export interface AIProviderModel {
  id: string;
  name: string;
  type: 'llm' | 'embedding' | 'both';
  contextWindow?: number;
  dimension?: number;
}

export interface AIProviderConfig {
  id: string;
  name: string;
  provider: AIProviderType;
  baseUrl?: string | null;
  hasApiKey: boolean;
  apiKeyMasked?: string | null;
  isDefaultLlm: boolean;
  isDefaultEmbedding: boolean;
  defaultLlmModel?: string | null;
  defaultEmbeddingModel?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string | null;
  icon?: string;
  color?: string;
  embedding_provider_id?: string | null;
  embedding_model?: string;
  embedding_dimension?: number;
  chunk_size?: number;
  chunk_overlap?: number;
  document_count?: number;
  chunk_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface Document {
  id: string;
  knowledge_base_id?: string;
  title: string;
  source_type?: string;
  source_url?: string | null;
  file_size?: number | null;
  token_count?: number;
  chunk_count?: number;
  status: DocumentStatus;
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface DocumentChunk {
  id: string;
  document_id?: string;
  knowledge_base_id?: string;
  chunk_index?: number;
  content: string;
  token_count?: number;
  metadata?: string | null;
}

export interface Citation {
  id: string;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  citationIndex: number;
  pageNumber?: number;
  sectionHeader?: string;
  chunkContent: string;
  score: number;
  metadata?: Record<string, any>;
  sourceUrl?: string;
}

export interface ChatMessage {
  id: string;
  session_id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations?: Citation[];
  citations_json?: string | null;
  latency_ms?: number;
  created_at?: string;
}

export interface ChatSession {
  id: string;
  knowledge_base_id?: string | null;
  knowledge_base_name?: string | null;
  title: string;
  system_prompt?: string | null;
  model_override?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type ChatStreamEvent =
  | { type: 'token'; token: string }
  | { type: 'citation'; citation: Citation }
  | { type: 'done'; messageId: string; latencyMs: number; totalTokens?: number }
  | { type: 'error'; error: string };
