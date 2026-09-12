/**
 * RAGForge Core Domain Types
 */

// --- Authentication & User Management ---
export type UserRole = 'admin' | 'member' | 'viewer';

export interface User {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  avatarUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  user: User;
  token: string;
  expiresAt: string;
}

export interface SetupStatus {
  isInitialized: boolean;
  hasAdminUser: boolean;
  hasDefaultProvider: boolean;
  hasKnowledgeBase: boolean;
  version: string;
  storageMode: 'sqlite' | 'postgres';
}

// --- AI Providers & Gateway ---
export type AIProviderType = 'ollama' | 'openai' | 'anthropic' | 'gemini' | 'groq';

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
  baseUrl?: string;
  apiKeyMasked?: string;
  hasApiKey: boolean;
  isDefaultLlm: boolean;
  isDefaultEmbedding: boolean;
  defaultLlmModel?: string;
  defaultEmbeddingModel?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMStreamOptions {
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface EmbeddingOptions {
  model: string;
  texts: string[];
}

export interface EmbeddingResult {
  embeddings: number[][];
  usage?: {
    promptTokens: number;
    totalTokens: number;
  };
}

// --- Knowledge Bases & Documents ---
export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string | null;
  icon?: string;
  color?: string;
  embeddingProviderId?: string | null;
  embeddingModel?: string;
  embeddingDimension: number;
  chunkSize: number;
  chunkOverlap: number;
  documentCount?: number;
  chunkCount?: number;
  createdAt: string;
  updatedAt: string;
}

export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type DocumentFileType = 'pdf' | 'docx' | 'txt' | 'md' | 'url' | 'other';

export interface Document {
  id: string;
  knowledgeBaseId: string;
  title: string;
  sourceType: DocumentFileType;
  sourceUrl?: string | null;
  filePath?: string | null;
  fileSize?: number | null;
  mimeType?: string | null;
  tokenCount?: number;
  chunkCount?: number;
  status: DocumentStatus;
  errorMessage?: string | null;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  knowledgeBaseId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  metadata?: {
    pageNumber?: number;
    sectionHeader?: string;
    breadcrumb?: string;
    [key: string]: any;
  };
  embedding?: number[];
  createdAt: string;
}

// --- Retrieval & Hybrid Search ---
export interface RetrievalQuery {
  knowledgeBaseId: string;
  query: string;
  topK?: number;
  similarityThreshold?: number;
  useHybridSearch?: boolean;
  vectorWeight?: number; // default 0.7
  bm25Weight?: number;   // default 0.3
  rrfK?: number;          // default 60
}

export interface ScoredChunk extends DocumentChunk {
  score: number;
  vectorScore?: number;
  bm25Score?: number;
  rrfScore?: number;
  documentTitle?: string;
}

export interface RetrievalResponse {
  query: string;
  chunks: ScoredChunk[];
  retrievalTimeMs: number;
  hybridApplied: boolean;
}

// --- Chat & Citations ---
export interface ChatSession {
  id: string;
  knowledgeBaseId?: string | null;
  title: string;
  systemPrompt?: string | null;
  modelOverride?: string | null;
  providerId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Citation {
  id: string;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  citationIndex: number;
  pageNumber?: number;
  sectionHeader?: string;
  snippet: string;
  similarityScore: number;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations?: Citation[];
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  latencyMs?: number;
  createdAt: string;
}

export type ChatStreamEvent =
  | { type: 'token'; token: string }
  | { type: 'citation'; citation: Citation }
  | { type: 'done'; messageId: string; latencyMs: number; totalTokens?: number }
  | { type: 'error'; error: string };
