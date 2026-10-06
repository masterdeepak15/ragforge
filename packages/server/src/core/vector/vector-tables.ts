/** Rows per transaction when writing chunks + vectors. */
export const WRITE_BATCH_SIZE = 500;

/**
 * Each knowledge base owns one vector table (`cv_<kb id>`) whose dimension is fixed by the
 * first embedding written. ANN indexes need a fixed dimension, KBs may use different models,
 * and per-KB tables keep approximate search from being diluted by other KBs' vectors.
 */
export function vectorTableName(knowledgeBaseId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(knowledgeBaseId)) {
    throw new Error(`Invalid knowledge base id: ${knowledgeBaseId}`);
  }
  return `cv_${knowledgeBaseId.replace(/-/g, '_')}`;
}

export function dimensionMismatch(knowledgeBaseId: string, expected: number, got: number): Error {
  return new Error(
    `Embedding dimension mismatch for knowledge base ${knowledgeBaseId}: expected ${expected}, got ${got}. ` +
      `The embedding model changed after documents were indexed; re-create the knowledge base or switch back to the original model.`
  );
}

export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}
