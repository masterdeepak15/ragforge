import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DatabaseContext } from '../db/connection.js';
import type { HybridRetriever } from '../core/retrieval/hybrid.retriever.js';

export interface ToolContext {
  db: DatabaseContext;
  retriever: HybridRetriever;
  /** Knowledge bases the calling key may read; `null` = all. */
  scope: string[] | null;
}

const MAX_TOP_K = 20;
const DEFAULT_TOP_K = 5;
const NOT_ACCESSIBLE = 'Knowledge base not found or not accessible with this API key';

const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });
const fail = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });
const clamp = (n: number | undefined, min: number, max: number, fallback: number) =>
  Math.min(max, Math.max(min, Math.floor(Number.isFinite(n) ? (n as number) : fallback)));

/** Registers the read-only knowledge-base tools. Every tool enforces the key's knowledge-base scope. */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  const client = () => ctx.db.client;
  const inScope = (kbId: string) => ctx.scope === null || ctx.scope.includes(kbId);

  async function accessibleKbs(): Promise<Array<{ id: string; name: string; description: string | null }>> {
    const rs = await client().execute(`SELECT id, name, description FROM knowledge_bases ORDER BY name`);
    return (rs.rows as any[])
      .filter((r) => inScope(r.id as string))
      .map((r) => ({ id: r.id as string, name: r.name as string, description: (r.description ?? null) as string | null }));
  }

  server.registerTool(
    'list_knowledge_bases',
    {
      title: 'List knowledge bases',
      description: 'Lists the knowledge bases this API key can search, with document and chunk counts.',
    },
    async () => {
      const kbs = await accessibleKbs();
      const out = [];
      for (const kb of kbs) {
        const counts = await client().execute({
          sql: `SELECT COUNT(*) AS docs, COALESCE(SUM(chunk_count), 0) AS chunks FROM documents WHERE knowledge_base_id = ? AND status = 'ready'`,
          args: [kb.id],
        });
        const row = counts.rows[0] as any;
        out.push({ ...kb, documents: Number(row.docs), chunks: Number(row.chunks) });
      }
      return ok({ knowledge_bases: out });
    }
  );

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description: 'Lists documents in a knowledge base (id, title, status, chunk count).',
      inputSchema: { knowledge_base: z.string().describe('Knowledge base id') },
    },
    async ({ knowledge_base }) => {
      const exists = await client().execute({ sql: `SELECT id FROM knowledge_bases WHERE id = ?`, args: [knowledge_base] });
      if (!exists.rows[0] || !inScope(knowledge_base)) return fail(NOT_ACCESSIBLE);
      const limit = 500;
      const rs = await client().execute({
        sql: `SELECT id, title, source_type, status, chunk_count, created_at FROM documents WHERE knowledge_base_id = ? ORDER BY title LIMIT ?`,
        args: [knowledge_base, limit + 1],
      });
      const rows = rs.rows as any[];
      return ok({
        documents: rows.slice(0, limit).map((d) => ({
          id: d.id, title: d.title, type: d.source_type, status: d.status, chunks: Number(d.chunk_count), created_at: d.created_at,
        })),
        truncated: rows.length > limit,
      });
    }
  );

  server.registerTool(
    'search_knowledge',
    {
      title: 'Search knowledge',
      description:
        'Hybrid (semantic + keyword) search over the knowledge base. Returns the best matching text chunks with their source document. Omit knowledge_base to search every knowledge base this key can access.',
      inputSchema: {
        query: z.string().min(1).max(2000).describe('Natural-language question or keywords'),
        knowledge_base: z.string().optional().describe('Restrict the search to one knowledge base id'),
        top_k: z.number().optional().describe(`Number of chunks to return (1-${MAX_TOP_K}, default ${DEFAULT_TOP_K})`),
      },
    },
    async ({ query, knowledge_base, top_k }) => {
      const topK = clamp(top_k, 1, MAX_TOP_K, DEFAULT_TOP_K);
      let targets: string[];
      if (knowledge_base) {
        const exists = await client().execute({ sql: `SELECT id FROM knowledge_bases WHERE id = ?`, args: [knowledge_base] });
        if (!exists.rows[0] || !inScope(knowledge_base)) return fail(NOT_ACCESSIBLE);
        targets = [knowledge_base];
      } else {
        const ready = await client().execute(`SELECT DISTINCT knowledge_base_id AS id FROM documents WHERE status = 'ready'`);
        targets = (ready.rows as any[]).map((r) => r.id as string).filter(inScope);
      }

      const merged: Array<{ chunk: any; score: number }> = [];
      const warnings: Array<{ knowledge_base_id: string; message: string }> = [];
      for (const kbId of targets) {
        try {
          const chunks = await ctx.retriever.retrieve({ knowledgeBaseId: kbId, query, topK } as any);
          for (const c of chunks) merged.push({ chunk: c, score: c.score });
        } catch (err: any) {
          warnings.push({ knowledge_base_id: kbId, message: err?.message ?? String(err) });
        }
      }
      if (merged.length === 0 && warnings.length > 0 && warnings.length === targets.length) {
        return fail(`Search failed: ${warnings[0].message}`);
      }

      merged.sort((a, b) => b.score - a.score);
      const top = merged.slice(0, topK);
      const titles = new Map<string, string>();
      const docIds = [...new Set(top.map((m) => m.chunk.documentId as string))];
      if (docIds.length > 0) {
        const rs = await client().execute({
          sql: `SELECT id, title FROM documents WHERE id IN (${docIds.map(() => '?').join(',')})`,
          args: docIds,
        });
        for (const r of rs.rows as any[]) titles.set(r.id as string, r.title as string);
      }
      return ok({
        results: top.map(({ chunk, score }) => ({
          document_id: chunk.documentId,
          document_title: titles.get(chunk.documentId) ?? null,
          knowledge_base_id: chunk.knowledgeBaseId,
          chunk_index: chunk.chunkIndex,
          score,
          text: chunk.content,
        })),
        ...(warnings.length ? { warnings } : {}),
      });
    }
  );

  server.registerTool(
    'get_document',
    {
      title: 'Get document',
      description: 'Returns a document\'s metadata and its text as ordered chunks, paginated by chunk (use next_offset to continue).',
      inputSchema: {
        document_id: z.string(),
        offset: z.number().optional().describe('Index of the first chunk to return (default 0)'),
        limit: z.number().optional().describe('Chunks per page (1-100, default 20)'),
      },
    },
    async ({ document_id, offset, limit }) => {
      const rs = await client().execute({ sql: `SELECT * FROM documents WHERE id = ?`, args: [document_id] });
      const doc = rs.rows[0] as any;
      if (!doc || !inScope(doc.knowledge_base_id as string)) return fail('Document not found or not accessible with this API key');

      const start = clamp(offset, 0, Number.MAX_SAFE_INTEGER, 0);
      const pageSize = clamp(limit, 1, 100, 20);
      const chunks = await client().execute({
        sql: `SELECT chunk_index, content FROM document_chunks WHERE document_id = ? ORDER BY chunk_index LIMIT ? OFFSET ?`,
        args: [document_id, pageSize, start],
      });
      const rows = chunks.rows as any[];
      const total = Number(doc.chunk_count);
      const next = start + rows.length;
      return ok({
        document: {
          id: doc.id, title: doc.title, knowledge_base_id: doc.knowledge_base_id, type: doc.source_type,
          status: doc.status, source_url: doc.source_url ?? null, chunks: total,
        },
        chunks: rows.map((c) => ({ index: Number(c.chunk_index), text: c.content })),
        next_offset: next < total ? next : null,
      });
    }
  );
}
