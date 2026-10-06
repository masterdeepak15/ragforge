import type { FastifyInstance } from 'fastify';

export async function playgroundRoutes(app: FastifyInstance) {
  /** POST /api/playground/retrieve — test retrieval without generating a response */
  app.post<{
    Body: {
      query: string;
      knowledgeBaseId: string;
      topK?: number;
      useHybridSearch?: boolean;
      vectorWeight?: number;
      bm25Weight?: number;
      minScore?: number;
    };
  }>('/api/playground/retrieve', { onRequest: [app.authenticate] }, async (req, reply) => {
    const {
      query,
      knowledgeBaseId,
      topK = 6,
      useHybridSearch = true,
      vectorWeight = 0.7,
      bm25Weight = 0.3,
      minScore = 0,
    } = req.body;

    if (!query?.trim()) {
      return reply.status(400).send({ error: 'query is required' });
    }
    if (!knowledgeBaseId) {
      return reply.status(400).send({ error: 'knowledgeBaseId is required' });
    }

    // Verify KB exists
    const client: any = app.db.client;
    const kbRs = await client.execute({
      sql: `SELECT id, name FROM knowledge_bases WHERE id = ?`,
      args: [knowledgeBaseId],
    });
    if (!kbRs.rows.length) {
      return reply.status(404).send({ error: 'Knowledge base not found' });
    }

    const results = await app.retriever.retrieve({
      query,
      knowledgeBaseId,
      topK,
      useHybridSearch,
      vectorWeight,
      bm25Weight,
    });

    // Fetch document titles for context
    const docIds = [...new Set(results.map((r: any) => r.documentId).filter(Boolean))];
    const docTitles: Record<string, string> = {};
    if (docIds.length > 0) {
      const placeholders = docIds.map(() => '?').join(',');
      const docsRs = await client.execute({
        sql: `SELECT id, title FROM documents WHERE id IN (${placeholders})`,
        args: docIds,
      });
      for (const row of docsRs.rows) {
        docTitles[row.id as string] = row.title as string;
      }
    }

    // The minimum applies to how similar the chunk is (0 to 1), not to the rank-fusion score, which is
    // about 0.01 to 0.03 and meaningless as a threshold. A chunk that contains the searched words is
    // kept when keyword search is on, since the user asked for exactly that.
    const keywordHit = (r: any) => useHybridSearch && typeof r.bm25Score === 'number' && r.bm25Score > 0;
    const chunks = results
      .filter((r: any) => (r.vectorScore ?? 0) >= minScore || keywordHit(r))
      .map((r: any, i: number) => ({
        id: r.id,
        content: r.content,
        score: r.score,
        similarity: r.vectorScore ?? null,
        keywordMatch: typeof r.bm25Score === 'number' && r.bm25Score > 0,
        rank: i + 1,
        documentId: r.documentId,
        documentTitle: docTitles[r.documentId] ?? 'Unknown',
        metadata: r.metadata,
        token_count: r.tokenCount,
      }));

    return reply.send({ chunks, query, knowledgeBaseId });
  });
}
