import { describe, it, expect } from 'vitest';
import { chunkText } from './recursive.chunker.js';

describe('chunkText', () => {
  it('keeps a document that is shorter than the noise threshold', () => {
    const chunks = chunkText('Meeting at 5pm.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('Meeting at 5pm.');
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('  \n\t ')).toEqual([]);
  });

  it('still drops tiny trailing fragments when real content exists', () => {
    const body = 'This sentence is long enough to be a real chunk of text. '.repeat(120);
    const chunks = chunkText(`${body}\n\nok`, { chunkSize: 100, chunkOverlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length > 20)).toBe(true);
  });
});
