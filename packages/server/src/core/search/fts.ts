import type { DatabaseContext } from '../../db/connection.js';

export interface KeywordHit {
  id: string;
  score: number;
}

export interface IKeywordIndex {
  /** Full-text search restricted to one knowledge base; higher score = better match. */
  search(knowledgeBaseId: string, query: string, limit: number): Promise<KeywordHit[]>;
}

const MAX_TERMS = 32;

/**
 * Splits free text into plain word terms (letters/digits of any script). Everything
 * else — quotes, operators, wildcards, punctuation — is dropped so user input can
 * never produce FTS syntax errors.
 */
export function toFtsTerms(raw: string): string[] {
  return (raw.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_TERMS);
}

class SqliteKeywordIndex implements IKeywordIndex {
  constructor(private db: DatabaseContext) {}

  async search(knowledgeBaseId: string, query: string, limit: number): Promise<KeywordHit[]> {
    const terms = toFtsTerms(query);
    if (terms.length === 0) return [];
    const match = terms.map((t) => `"${t}"`).join(' OR ');
    const rs = await this.db.client.execute({
      sql: `SELECT c.id AS id, -bm25(chunks_fts) AS score
            FROM chunks_fts
            JOIN document_chunks c ON c.rowid = chunks_fts.rowid
            WHERE chunks_fts MATCH ? AND c.knowledge_base_id = ?
            ORDER BY bm25(chunks_fts)
            LIMIT ?`,
      args: [match, knowledgeBaseId, limit],
    });
    return (rs.rows as any[]).map((r) => ({ id: r.id as string, score: Number(r.score) }));
  }
}

class PgKeywordIndex implements IKeywordIndex {
  constructor(private db: DatabaseContext) {}

  async search(knowledgeBaseId: string, query: string, limit: number): Promise<KeywordHit[]> {
    const terms = toFtsTerms(query);
    if (terms.length === 0) return [];
    const rows: any[] = await (this.db.client as any).unsafe(
      `SELECT id, ts_rank_cd(content_tsv, q) AS score
       FROM document_chunks, to_tsquery('simple', $1) q
       WHERE knowledge_base_id = $2 AND content_tsv @@ q
       ORDER BY score DESC
       LIMIT $3`,
      [terms.join(' | '), knowledgeBaseId, limit]
    );
    return rows.map((r) => ({ id: r.id as string, score: Number(r.score) }));
  }
}

export function createKeywordIndex(db: DatabaseContext): IKeywordIndex {
  return db.mode === 'postgres' ? new PgKeywordIndex(db) : new SqliteKeywordIndex(db);
}
