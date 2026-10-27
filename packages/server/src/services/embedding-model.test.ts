import { describe, it, expect } from 'vitest';
import { sameEmbeddingModel } from './ingestion.handler.js';

describe('sameEmbeddingModel', () => {
  it('treats "name" and "name:latest" as the same model (Ollama lists models with the tag)', () => {
    expect(sameEmbeddingModel('nomic-embed-text', 'nomic-embed-text:latest')).toBe(true);
    expect(sameEmbeddingModel('nomic-embed-text:latest', 'nomic-embed-text')).toBe(true);
  });

  it('is case-insensitive and ignores surrounding spaces', () => {
    expect(sameEmbeddingModel(' Nomic-Embed-Text ', 'nomic-embed-text:LATEST')).toBe(true);
  });

  it('still tells different models and different tags apart', () => {
    expect(sameEmbeddingModel('nomic-embed-text', 'mxbai-embed-large')).toBe(false);
    expect(sameEmbeddingModel('bge-m3:567m', 'bge-m3:latest')).toBe(false);
    expect(sameEmbeddingModel('text-embedding-3-small', 'text-embedding-3-large')).toBe(false);
  });
});
