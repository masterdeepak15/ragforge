import { drizzle } from 'drizzle-orm/libsql';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createClient } from '@libsql/client';
import * as sqliteSchema from './schema/sqlite.js';
import * as pgSchema from './schema/pg.js';
import { SqliteVectorStore } from '../core/vector/sqlite.vector.js';
import { PgVectorStore } from '../core/vector/pg.vector.js';
import type { IVectorStore } from '../core/vector/vector.interface.js';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export type StorageMode = 'sqlite' | 'postgres';

export interface DatabaseContext {
  mode: StorageMode;
  sqlite?: LibSQLDatabase<typeof sqliteSchema>;
  postgres?: PostgresJsDatabase<typeof pgSchema>;
  vectorStore: IVectorStore;
  client: any; // Raw database client for direct queries
  close: () => Promise<void>;
}

export async function createDatabaseContext(
  mode: StorageMode,
  options: {
    sqliteUrl?: string;
    sqliteAuthToken?: string;
    postgresUrl?: string;
  } = {}
): Promise<DatabaseContext> {
  if (mode === 'sqlite') {
    const url = options.sqliteUrl || 'file:./ragforge.db';
    const sqliteClient = createClient({
      url,
      authToken: options.sqliteAuthToken,
    });

    const db = drizzle(sqliteClient, { schema: sqliteSchema });
    const vectorStore = new SqliteVectorStore(sqliteClient);

    return {
      mode: 'sqlite',
      sqlite: db,
      vectorStore,
      client: sqliteClient,
      close: async () => {
        sqliteClient.close();
      },
    };
  }

  if (mode === 'postgres') {
    if (!options.postgresUrl) {
      throw new Error('POSTGRES_URL is required for postgres mode');
    }

    const client = postgres(options.postgresUrl);
    const db = drizzlePg(client, { schema: pgSchema });
    const vectorStore = new PgVectorStore(db);

    return {
      mode: 'postgres',
      postgres: db,
      vectorStore,
      client, // Store raw client for direct queries
      close: async () => {
        await client.end();
      },
    };
  }

  throw new Error(`Unsupported storage mode: ${mode}`);
}

export async function runMigrations(ctx: DatabaseContext): Promise<void> {
  if (ctx.mode === 'sqlite') {
    const statements = [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        avatar_url TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS ai_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        base_url TEXT,
        api_key_encrypted TEXT,
        is_default_llm INTEGER NOT NULL DEFAULT 0,
        is_default_embedding INTEGER NOT NULL DEFAULT 0,
        default_llm_model TEXT,
        default_embedding_model TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        icon TEXT DEFAULT 'database',
        color TEXT DEFAULT 'emerald',
        embedding_provider_id TEXT REFERENCES ai_providers(id) ON DELETE SET NULL,
        embedding_model TEXT DEFAULT 'nomic-embed-text',
        embedding_dimension INTEGER NOT NULL DEFAULT 768,
        chunk_size INTEGER NOT NULL DEFAULT 1000,
        chunk_overlap INTEGER NOT NULL DEFAULT 200,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_url TEXT,
        file_path TEXT,
        file_size INTEGER,
        mime_type TEXT,
        token_count INTEGER DEFAULT 0,
        chunk_count INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS document_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        metadata TEXT,
        embedding_blob BLOB,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT REFERENCES knowledge_bases(id) ON DELETE SET NULL,
        title TEXT NOT NULL DEFAULT 'New Chat',
        system_prompt TEXT,
        model_override TEXT,
        provider_id TEXT REFERENCES ai_providers(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        citations_json TEXT,
        token_usage_json TEXT,
        latency_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_documents_kb ON documents(knowledge_base_id)`,
      `CREATE INDEX IF NOT EXISTS idx_chunks_kb ON document_chunks(knowledge_base_id)`,
      `CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id)`,
    ];

    for (const sql of statements) {
      await ctx.client.execute(sql);
    }
    return;
  }

  if (ctx.mode === 'postgres') {
    const client = postgres(process.env.POSTGRES_URL!);
    await client.unsafe(`
      CREATE EXTENSION IF NOT EXISTS vector;

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        avatar_url TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ai_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        base_url TEXT,
        api_key_encrypted TEXT,
        is_default_llm BOOLEAN NOT NULL DEFAULT FALSE,
        is_default_embedding BOOLEAN NOT NULL DEFAULT FALSE,
        default_llm_model TEXT,
        default_embedding_model TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        icon TEXT DEFAULT 'database',
        color TEXT DEFAULT 'emerald',
        embedding_provider_id TEXT REFERENCES ai_providers(id) ON DELETE SET NULL,
        embedding_model TEXT DEFAULT 'nomic-embed-text',
        embedding_dimension INTEGER NOT NULL DEFAULT 768,
        chunk_size INTEGER NOT NULL DEFAULT 1000,
        chunk_overlap INTEGER NOT NULL DEFAULT 200,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_url TEXT,
        file_path TEXT,
        file_size INTEGER,
        mime_type TEXT,
        token_count INTEGER DEFAULT 0,
        chunk_count INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        metadata JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS document_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        metadata JSONB,
        embedding VECTOR(1536),
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT REFERENCES knowledge_bases(id) ON DELETE SET NULL,
        title TEXT NOT NULL DEFAULT 'New Chat',
        system_prompt TEXT,
        model_override TEXT,
        provider_id TEXT REFERENCES ai_providers(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        citations_json JSONB,
        token_usage_json JSONB,
        latency_ms INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_documents_kb ON documents(knowledge_base_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_kb ON document_chunks(knowledge_base_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id);
    `);
    await client.end();
  }
}
