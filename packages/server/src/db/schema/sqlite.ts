import { sqliteTable, text, integer, blob } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'member', 'viewer'] }).notNull().default('member'),
  avatarUrl: text('avatar_url'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const aiProviders = sqliteTable('ai_providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  provider: text('provider', { enum: ['ollama', 'openai', 'anthropic', 'gemini', 'groq'] }).notNull(),
  baseUrl: text('base_url'),
  apiKeyEncrypted: text('api_key_encrypted'),
  isDefaultLlm: integer('is_default_llm', { mode: 'boolean' }).notNull().default(false),
  isDefaultEmbedding: integer('is_default_embedding', { mode: 'boolean' }).notNull().default(false),
  defaultLlmModel: text('default_llm_model'),
  defaultEmbeddingModel: text('default_embedding_model'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const knowledgeBases = sqliteTable('knowledge_bases', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  icon: text('icon').default('database'),
  color: text('color').default('emerald'),
  embeddingProviderId: text('embedding_provider_id').references(() => aiProviders.id, { onDelete: 'set null' }),
  embeddingModel: text('embedding_model').default('nomic-embed-text'),
  embeddingDimension: integer('embedding_dimension').notNull().default(768),
  chunkSize: integer('chunk_size').notNull().default(1000),
  chunkOverlap: integer('chunk_overlap').notNull().default(200),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  knowledgeBaseId: text('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  sourceType: text('source_type', { enum: ['pdf', 'docx', 'txt', 'md', 'url', 'other'] }).notNull(),
  sourceUrl: text('source_url'),
  filePath: text('file_path'),
  fileSize: integer('file_size'),
  mimeType: text('mime_type'),
  tokenCount: integer('token_count').default(0),
  chunkCount: integer('chunk_count').default(0),
  status: text('status', { enum: ['pending', 'processing', 'ready', 'failed'] }).notNull().default('pending'),
  errorMessage: text('error_message'),
  metadata: text('metadata'), // JSON string
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const documentChunks = sqliteTable('document_chunks', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  knowledgeBaseId: text('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
  chunkIndex: integer('chunk_index').notNull(),
  content: text('content').notNull(),
  tokenCount: integer('token_count').notNull().default(0),
  metadata: text('metadata'), // JSON string
  embeddingBlob: blob('embedding_blob', { mode: 'buffer' }), // Float32Array serialized as raw Buffer
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const chatSessions = sqliteTable('chat_sessions', {
  id: text('id').primaryKey(),
  knowledgeBaseId: text('knowledge_base_id').references(() => knowledgeBases.id, { onDelete: 'set null' }),
  title: text('title').notNull().default('New Chat'),
  systemPrompt: text('system_prompt'),
  modelOverride: text('model_override'),
  providerId: text('provider_id').references(() => aiProviders.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const chatMessages = sqliteTable('chat_messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
  content: text('content').notNull(),
  citationsJson: text('citations_json'), // JSON serialized Citation[]
  tokenUsageJson: text('token_usage_json'), // JSON serialized usage
  latencyMs: integer('latency_ms'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});
