import { reciprocalRankFusion } from './bm25.js';
import type { IKeywordIndex } from '../search/fts.js';
import type { IVectorStore } from '../vector/vector.interface.js';
import type { RetrievalQuery, ScoredChunk, DocumentChunk } from '@ragforge/shared';

export interface RetrieverDeps {
  vectorStore: IVectorStore;
  getChunksByIds(ids: string[]): Promise<DocumentChunk[]>;
  keywordIndex: IKeywordIndex;
  getEmbedding(text: string, knowledgeBaseId: string): Promise<number[]>;
}

export class HybridRetriever {
  constructor(private deps: RetrieverDeps) {}

  async retrieve(query: RetrievalQuery): Promise<ScoredChunk[]> {
    const {
      knowledgeBaseId,
      query: queryText,
      topK = 8,
      similarityThreshold = 0,
      useHybridSearch = true,
      vectorWeight = 0.7,
      bm25Weight = 0.3,
      rrfK = 60,
    } = query;

    // 1. Generate query embedding
    const queryEmbedding = await this.deps.getEmbedding(queryText, knowledgeBaseId);

    // 2. Vector search
    const vectorResults = await this.deps.vectorStore.search(
      knowledgeBaseId,
      queryEmbedding,
      topK * 2, // over-fetch before RRF merge
      similarityThreshold
    );

    let candidateIds: string[];
    let rrfScores: Map<string, { rrfScore: number; vectorScore?: number; bm25Score?: number }> | null = null;

    if (useHybridSearch) {
      // 3. Keyword search (database full-text index)
      const bm25Results = await this.deps.keywordIndex.search(knowledgeBaseId, queryText, topK * 2);

      // 4. Merge with RRF
      const merged = reciprocalRankFusion(vectorResults, bm25Results, {
        k: rrfK,
        vectorWeight,
        bm25Weight,
      });

      rrfScores = new Map(merged.map(r => [r.id, r]));
      candidateIds = merged.slice(0, topK).map(r => r.id);
    } else {
      candidateIds = vectorResults.slice(0, topK).map(r => r.id);
    }

    // 5. Fetch full chunk rows
    const chunks = await this.deps.getChunksByIds(candidateIds);

    // 6. Build ScoredChunks preserving rank order
    const chunkMap = new Map(chunks.map(c => [c.id, c]));
    const scored: ScoredChunk[] = [];

    for (const id of candidateIds) {
      const chunk = chunkMap.get(id);
      if (!chunk) continue;

      const vectorHit = vectorResults.find(r => r.id === id);
      const rrf = rrfScores?.get(id);

      scored.push({
        ...chunk,
        score: rrf?.rrfScore ?? vectorHit?.score ?? 0,
        vectorScore: vectorHit?.score,
        bm25Score: rrf?.bm25Score,
        rrfScore: rrf?.rrfScore,
      });
    }

    return scored;
  }
}
