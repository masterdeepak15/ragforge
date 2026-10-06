/**
 * Search latency benchmark (not part of the test suite).
 *   npx tsx src/core/vector/bench.mts [chunks=200000] [dim=768] [queries=200]
 * Builds a synthetic knowledge base in a temp SQLite file, then reports p50/p95/p99 search latency.
 */
import { randomUUID } from 'crypto';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDatabaseContext, runMigrations } from '../../db/connection.js';
import { createKeywordIndex } from '../search/fts.js';

const N = Number(process.argv[2] ?? 200_000);
const DIM = Number(process.argv[3] ?? 768);
const QUERIES = Number(process.argv[4] ?? 200);
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];

const rand = () => Array.from({ length: DIM }, () => Math.random() - 0.5);
const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

const dir = await mkdtemp(join(tmpdir(), 'ragforge-bench-'));
const db = await createDatabaseContext('sqlite', { sqliteUrl: `file:${join(dir, 'bench.db').split('\\').join('/')}` });
await runMigrations(db);

const kb = randomUUID();
const doc = randomUUID();
await db.client.execute({ sql: `INSERT INTO knowledge_bases (id, name) VALUES (?, 'bench')`, args: [kb] });
await db.client.execute({ sql: `INSERT INTO documents (id, knowledge_base_id, title, source_type, status) VALUES (?, ?, 'd', 'txt', 'ready')`, args: [doc, kb] });

const t0 = Date.now();
const BATCH = 500;
for (let i = 0; i < N; i += BATCH) {
  const chunks = Array.from({ length: Math.min(BATCH, N - i) }, (_, j) => ({
    id: randomUUID(),
    documentId: doc,
    knowledgeBaseId: kb,
    chunkIndex: i + j,
    content: Array.from({ length: 30 }, () => WORDS[Math.floor(Math.random() * WORDS.length)] + Math.floor(Math.random() * 500)).join(' '),
    tokenCount: 30,
    embedding: rand(),
  }));
  await db.vectorStore.upsertChunks(chunks);
  if ((i / BATCH) % 20 === 0) console.log(`  inserted ${i + chunks.length}/${N} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
console.log(`Indexed ${N} chunks x ${DIM} dims in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const keyword = createKeywordIndex(db);
const vec: number[] = [];
const kw: number[] = [];
for (let q = 0; q < QUERIES; q++) {
  let s = performance.now();
  await db.vectorStore.search(kb, rand(), 10);
  vec.push(performance.now() - s);
  s = performance.now();
  await keyword.search(kb, `${WORDS[q % WORDS.length]}${q % 500} ${WORDS[(q + 3) % WORDS.length]}`, 10);
  kw.push(performance.now() - s);
}
vec.sort((a, b) => a - b);
kw.sort((a, b) => a - b);
const fmt = (xs: number[]) => `p50 ${pct(xs, 50).toFixed(1)}ms  p95 ${pct(xs, 95).toFixed(1)}ms  p99 ${pct(xs, 99).toFixed(1)}ms`;
console.log(`vector  (top10): ${fmt(vec)}`);
console.log(`keyword (top10): ${fmt(kw)}`);
await db.close();
