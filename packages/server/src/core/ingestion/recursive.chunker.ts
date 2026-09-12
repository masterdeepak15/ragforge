export interface TextChunk {
  content: string;
  tokenCount: number;
  metadata: {
    chunkIndex: number;
    startChar: number;
    endChar: number;
    breadcrumb?: string;
    sectionHeader?: string;
    pageNumber?: number;
    [key: string]: any;
  };
}

const SEPARATORS = ['\n\n', '\n', '. ', '! ', '? ', '; ', ', ', ' ', ''];

function estimateTokens(text: string): number {
  // ~4 chars per token is a reasonable approximation for English
  return Math.ceil(text.length / 4);
}

function splitOnSeparator(text: string, sep: string): string[] {
  if (sep === '') return text.split('');
  return text.split(sep).map((s, i, arr) => (i < arr.length - 1 ? s + sep : s));
}

function mergeSplits(splits: string[], chunkSize: number): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const split of splits) {
    const candidate = current + split;
    if (estimateTokens(candidate) > chunkSize && current.length > 0) {
      chunks.push(current.trimEnd());
      current = split;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) chunks.push(current.trimEnd());
  return chunks;
}

function recursiveSplit(text: string, separators: string[], chunkSize: number): string[] {
  const [sep, ...rest] = separators;

  if (!sep && sep !== '') return [text];

  const splits = splitOnSeparator(text, sep);
  const goodSplits: string[] = [];
  const finalChunks: string[] = [];

  for (const split of splits) {
    if (estimateTokens(split) <= chunkSize) {
      goodSplits.push(split);
    } else {
      if (goodSplits.length) {
        finalChunks.push(...mergeSplits(goodSplits, chunkSize));
        goodSplits.length = 0;
      }
      finalChunks.push(...recursiveSplit(split, rest, chunkSize));
    }
  }

  if (goodSplits.length) finalChunks.push(...mergeSplits(goodSplits, chunkSize));
  return finalChunks;
}

export function chunkText(
  text: string,
  options: {
    chunkSize?: number;
    chunkOverlap?: number;
    baseMetadata?: Record<string, any>;
  } = {}
): TextChunk[] {
  const { chunkSize = 1000, chunkOverlap = 200, baseMetadata = {} } = options;

  const rawChunks = recursiveSplit(text, SEPARATORS, chunkSize);
  const chunks: TextChunk[] = [];
  let charOffset = 0;

  for (let i = 0; i < rawChunks.length; i++) {
    let content = rawChunks[i];

    // Add overlap from the previous chunk
    if (i > 0 && chunkOverlap > 0) {
      const prev = rawChunks[i - 1];
      const overlapText = prev.slice(-Math.min(chunkOverlap * 4, prev.length));
      if (overlapText.trim()) {
        content = overlapText + '\n\n' + content;
      }
    }

    // Extract section header for breadcrumb context
    const headerMatch = content.match(/^#{1,6}\s+(.+)/m);
    const sectionHeader = headerMatch?.[1]?.trim();

    const startChar = charOffset;
    charOffset += rawChunks[i].length;

    chunks.push({
      content: content.trim(),
      tokenCount: estimateTokens(content),
      metadata: {
        ...baseMetadata,
        chunkIndex: i,
        startChar,
        endChar: charOffset,
        ...(sectionHeader && { sectionHeader }),
        ...(sectionHeader && { breadcrumb: sectionHeader }),
      },
    });
  }

  return chunks.filter(c => c.content.length > 20);
}
