import { pgTable, text, integer, boolean, timestamp, jsonb, customType } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Custom pgvector type to support arbitrary dimension vectors
export const pgVector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector';
  },
  toDriver(value: number[]): string {
    return JSON.stringify(value);
  },
  fromDriver(value: string): number[] {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value.replace(/[\[\]]/g, '').split(',').map(Number);
      }
    }
    return value;
  },
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('member'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const aiProviders = pgTable('ai_providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  baseUrl: text('base_url'),
  apiKeyEncrypted: text('api_key_encrypted'),
  isDefaultLlm: boolean('is_default_llm').notNull().default(false),
  isDefaultEmbedding: boolean('is_default_embedding').notNull().default(false),
  defaultLlmModel: text('default_llm_model'),
  defaultEmbeddingModel: text('default_embedding_model'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const knowledgeBases = pgTable('knowledge_bases', {
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
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const documents = pgTable('documents', {
  id: text('id').primaryKey(),
  knowledgeBaseId: text('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  sourceType: text('source_type').notNull(),
  sourceUrl: text('source_url'),
  filePath: text('file_path'),
  fileSize: integer('file_size'),
  mimeType: text('mime_type'),
  tokenCount: integer('token_count').default(0),
  chunkCount: integer('chunk_count').default(0),
  status: text('status').notNull().default('pending'),
  errorMessage: text('error_message'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const documentChunks = pgTable('document_chunks', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  knowledgeBaseId: text('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
  chunkIndex: integer('chunk_index').notNull(),
  content: text('content').notNull(),
  tokenCount: integer('token_count').notNull().default(0),
  metadata: jsonb('metadata'),
  embedding: pgVector('embedding'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const chatSessions = pgTable('chat_sessions', {
  id: text('id').primaryKey(),
  knowledgeBaseId: text('knowledge_base_id').references(() => knowledgeBases.id, { onDelete: 'set null' }),
  title: text('title').notNull().default('New Chat'),
  systemPrompt: text('system_prompt'),
  modelOverride: text('model_override'),
  providerId: text('provider_id').references(() => aiProviders.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const chatMessages = pgTable('chat_messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  citationsJson: jsonb('citations_json'),
  tokenUsageJson: jsonb('token_usage_json'),
  latencyMs: integer('latency_ms'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
