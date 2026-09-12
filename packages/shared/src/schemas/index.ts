import { z } from 'zod';

// --- Auth Schemas ---
export const LoginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
});

export type LoginInput = z.infer<typeof LoginSchema>;

export const RegisterAdminSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  username: z.string().min(3, 'Username must be at least 3 characters long'),
  password: z.string().min(8, 'Password must be at least 8 characters long'),
});

export type RegisterAdminInput = z.infer<typeof RegisterAdminSchema>;

// --- Setup Wizard Schema ---
export const InitialSetupSchema = z.object({
  admin: RegisterAdminSchema,
  provider: z.object({
    provider: z.enum(['ollama', 'openai', 'anthropic', 'gemini', 'groq']),
    name: z.string().default('Default Provider'),
    baseUrl: z.string().url().optional().or(z.literal('')),
    apiKey: z.string().optional(),
    defaultLlmModel: z.string().min(1, 'LLM model name is required'),
    defaultEmbeddingModel: z.string().min(1, 'Embedding model name is required'),
  }),
  knowledgeBase: z.object({
    name: z.string().min(2, 'Knowledge Base name is required').default('Default Workspace'),
    description: z.string().optional(),
    chunkSize: z.number().int().min(100).max(4000).default(800),
    chunkOverlap: z.number().int().min(0).max(1000).default(120),
  }).optional(),
});

export type InitialSetupInput = z.infer<typeof InitialSetupSchema>;

// --- Provider Management Schemas ---
export const CreateProviderSchema = z.object({
  name: z.string().min(2, 'Provider name must be at least 2 characters'),
  provider: z.enum(['ollama', 'openai', 'anthropic', 'gemini', 'groq']),
  baseUrl: z.string().url().optional().or(z.literal('')),
  apiKey: z.string().optional(),
  isDefaultLlm: z.boolean().default(false),
  isDefaultEmbedding: z.boolean().default(false),
  defaultLlmModel: z.string().optional(),
  defaultEmbeddingModel: z.string().optional(),
});

export type CreateProviderInput = z.infer<typeof CreateProviderSchema>;

export const UpdateProviderSchema = CreateProviderSchema.partial();
export type UpdateProviderInput = z.infer<typeof UpdateProviderSchema>;

export const TestProviderConnectionSchema = z.object({
  provider: z.enum(['ollama', 'openai', 'anthropic', 'gemini', 'groq']),
  baseUrl: z.string().url().optional().or(z.literal('')),
  apiKey: z.string().optional(),
  model: z.string().optional(),
});

export type TestProviderConnectionInput = z.infer<typeof TestProviderConnectionSchema>;

// --- Knowledge Base Schemas ---
export const CreateKnowledgeBaseSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  description: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  embeddingProviderId: z.string().optional(),
  embeddingModel: z.string().optional(),
  embeddingDimension: z.number().int().default(1536),
  chunkSize: z.number().int().min(100).max(4000).default(800),
  chunkOverlap: z.number().int().min(0).max(1000).default(120),
});

export type CreateKnowledgeBaseInput = z.infer<typeof CreateKnowledgeBaseSchema>;

export const UpdateKnowledgeBaseSchema = CreateKnowledgeBaseSchema.partial();
export type UpdateKnowledgeBaseInput = z.infer<typeof UpdateKnowledgeBaseSchema>;

// --- Document Ingestion Schemas ---
export const IngestUrlSchema = z.object({
  knowledgeBaseId: z.string().uuid(),
  url: z.string().url('Must be a valid URL'),
  title: z.string().optional(),
});

export type IngestUrlInput = z.infer<typeof IngestUrlSchema>;

export const IngestTextSchema = z.object({
  knowledgeBaseId: z.string().uuid(),
  title: z.string().min(1, 'Title is required'),
  content: z.string().min(10, 'Content must have at least 10 characters'),
  metadata: z.record(z.any()).optional(),
});

export type IngestTextInput = z.infer<typeof IngestTextSchema>;

// --- Retrieval & Search Schemas ---
export const RetrievalQuerySchema = z.object({
  knowledgeBaseId: z.string().uuid(),
  query: z.string().min(1, 'Query is required'),
  topK: z.number().int().min(1).max(50).default(5),
  similarityThreshold: z.number().min(0).max(1).default(0.3),
  useHybridSearch: z.boolean().default(true),
  vectorWeight: z.number().min(0).max(1).default(0.7),
  bm25Weight: z.number().min(0).max(1).default(0.3),
  rrfK: z.number().int().min(1).max(100).default(60),
});

export type RetrievalQueryInput = z.infer<typeof RetrievalQuerySchema>;

// --- Chat Schemas ---
export const CreateChatSessionSchema = z.object({
  knowledgeBaseId: z.string().uuid().optional(),
  title: z.string().min(1).default('New Conversation'),
  systemPrompt: z.string().optional(),
  modelOverride: z.string().optional(),
  providerId: z.string().uuid().optional(),
});

export type CreateChatSessionInput = z.infer<typeof CreateChatSessionSchema>;

export const SendChatMessageSchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1, 'Message cannot be empty'),
  useKnowledgeBase: z.boolean().default(true),
  temperature: z.number().min(0).max(2).default(0.7),
});

export type SendChatMessageInput = z.infer<typeof SendChatMessageSchema>;
