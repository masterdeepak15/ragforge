import type { DatabaseContext } from '../db/connection.js';

/**
 * How a knowledge base is searched. One set per knowledge base, shared by the Playground, Chat and the
 * MCP server, so tuning it once changes how every one of them answers.
 */
export interface RetrievalSettings {
  /** Passages returned per search. */
  topK: number;
  /** Combine meaning (vector) search with keyword search. */
  useHybridSearch: boolean;
  vectorWeight: number;
  bm25Weight: number;
  /** Vector matches less similar than this (0 to 1) are dropped. */
  minSimilarity: number;
}

/** What chat used before settings existed, so nothing changes until someone saves their own. */
export const DEFAULT_RETRIEVAL: RetrievalSettings = { topK: 6, useHybridSearch: true, vectorWeight: 0.7, bm25Weight: 0.3, minSimilarity: 0.3 };

export type RetrievalPatch = Partial<RetrievalSettings>;

const unit = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** Validates a partial update. Unknown fields are ignored; any bad value rejects the whole update. */
export function parseRetrievalPatch(input: unknown): { ok: true; value: RetrievalPatch } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Send the settings as a JSON object.' };
  const src = input as Record<string, unknown>;
  const out: RetrievalPatch = {};

  if (src.topK !== undefined) {
    if (!Number.isInteger(src.topK) || (src.topK as number) < 1 || (src.topK as number) > 50) return { ok: false, error: 'topK must be a whole number from 1 to 50.' };
    out.topK = src.topK as number;
  }
  if (src.useHybridSearch !== undefined) {
    if (typeof src.useHybridSearch !== 'boolean') return { ok: false, error: 'useHybridSearch must be true or false.' };
    out.useHybridSearch = src.useHybridSearch;
  }
  for (const key of ['vectorWeight', 'bm25Weight', 'minSimilarity'] as const) {
    if (src[key] === undefined) continue;
    if (!unit(src[key])) return { ok: false, error: `${key} must be a number from 0 to 1.` };
    out[key] = src[key] as number;
  }
  return { ok: true, value: out };
}

function parseStored(raw: unknown): RetrievalPatch {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = parseRetrievalPatch(JSON.parse(raw));
    return parsed.ok ? parsed.value : {};
  } catch {
    return {};
  }
}

/** The settings in force for a knowledge base: the saved ones over the defaults. Never throws on bad data. */
export async function getRetrievalSettings(client: DatabaseContext['client'], knowledgeBaseId: string): Promise<RetrievalSettings> {
  const rs = await client.execute({ sql: `SELECT retrieval_settings FROM knowledge_bases WHERE id = ?`, args: [knowledgeBaseId] });
  return { ...DEFAULT_RETRIEVAL, ...parseStored((rs.rows[0] as any)?.retrieval_settings) };
}

/** Saves a validated partial update on top of what is already saved. */
export async function saveRetrievalSettings(client: DatabaseContext['client'], knowledgeBaseId: string, patch: RetrievalPatch): Promise<RetrievalSettings> {
  const rs = await client.execute({ sql: `SELECT retrieval_settings FROM knowledge_bases WHERE id = ?`, args: [knowledgeBaseId] });
  const stored = { ...parseStored((rs.rows[0] as any)?.retrieval_settings), ...patch };
  await client.execute({ sql: `UPDATE knowledge_bases SET retrieval_settings = ? WHERE id = ?`, args: [JSON.stringify(stored), knowledgeBaseId] });
  return { ...DEFAULT_RETRIEVAL, ...stored };
}

export async function resetRetrievalSettings(client: DatabaseContext['client'], knowledgeBaseId: string): Promise<RetrievalSettings> {
  await client.execute({ sql: `UPDATE knowledge_bases SET retrieval_settings = NULL WHERE id = ?`, args: [knowledgeBaseId] });
  return { ...DEFAULT_RETRIEVAL };
}
