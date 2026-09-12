import type { ScoredChunk, DocumentChunk } from '@ragforge/shared';

/**
 * In-memory BM25 index for a knowledge base.
 * BM25 parameters: k1=1.5, b=0.75
 */
const K1 = 1.5;
const B = 0.75;

interface BM25Entry {
  id: string;
  terms: Map<string, number>; // term -> tf
  length: number;
}

export class BM25Index {
  private docs: BM25Entry[] = [];
  private df: Map<string, number> = new Map(); // term -> doc freq
  private avgDocLen = 0;

  tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }

  addDocument(id: string, content: string) {
    const terms = this.tokenize(content);
    const tf = new Map<string, number>();
    for (const term of terms) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }
    this.docs.push({ id, terms: tf, length: terms.length });
    for (const term of tf.keys()) {
      this.df.set(term, (this.df.get(term) || 0) + 1);
    }
    this.avgDocLen = this.docs.reduce((s, d) => s + d.length, 0) / this.docs.length;
  }

  score(queryTerms: string[]): Array<{ id: string; score: number }> {
    const N = this.docs.length;
    if (N === 0) return [];

    const scores = new Map<string, number>();

    for (const term of queryTerms) {
      const df = this.df.get(term) || 0;
      if (df === 0) continue;
      // IDF with smoothing
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      for (const doc of this.docs) {
        const tf = doc.terms.get(term) || 0;
        if (tf === 0) continue;
        const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (doc.length / this.avgDocLen)));
        scores.set(doc.id, (scores.get(doc.id) || 0) + idf * norm);
      }
    }

    return Array.from(scores.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score);
  }

  search(query: string, topK: number): Array<{ id: string; score: number }> {
    return this.score(this.tokenize(query)).slice(0, topK);
  }
}

export interface RRFResult {
  id: string;
  rrfScore: number;
  vectorScore?: number;
  bm25Score?: number;
  vectorRank?: number;
  bm25Rank?: number;
}

/**
 * Reciprocal Rank Fusion: RRF(d) = sum_m(w_m / (60 + rank_m(d)))
 */
export function reciprocalRankFusion(
  vectorResults: Array<{ id: string; score: number }>,
  bm25Results: Array<{ id: string; score: number }>,
  options: { k?: number; vectorWeight?: number; bm25Weight?: number } = {}
): RRFResult[] {
  const k = options.k ?? 60;
  const vw = options.vectorWeight ?? 0.7;
  const bw = options.bm25Weight ?? 0.3;

  const scores = new Map<string, RRFResult>();

  vectorResults.forEach(({ id, score }, rank) => {
    scores.set(id, {
      id,
      rrfScore: vw / (k + rank + 1),
      vectorScore: score,
      vectorRank: rank + 1,
    });
  });

  bm25Results.forEach(({ id, score }, rank) => {
    const existing = scores.get(id);
    if (existing) {
      existing.rrfScore += bw / (k + rank + 1);
      existing.bm25Score = score;
      existing.bm25Rank = rank + 1;
    } else {
      scores.set(id, {
        id,
        rrfScore: bw / (k + rank + 1),
        bm25Score: score,
        bm25Rank: rank + 1,
      });
    }
  });

  return Array.from(scores.values()).sort((a, b) => b.rrfScore - a.rrfScore);
}
