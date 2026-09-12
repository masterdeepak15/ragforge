import { chunkText } from './recursive.chunker.js';
import type { TextChunk } from './recursive.chunker.js';

export interface LoadedDocument {
  text: string;
  metadata?: Record<string, any>;
}

// --- PDF Loader ---
export async function loadPdf(buffer: Buffer): Promise<LoadedDocument> {
  // Dynamic import to avoid issues if pdf-parse isn't available in all envs
  const pdfParse = (await import('pdf-parse')).default;
  const result = await pdfParse(buffer);
  return {
    text: result.text,
    metadata: { pageCount: result.numpages },
  };
}

// --- DOCX Loader ---
export async function loadDocx(buffer: Buffer): Promise<LoadedDocument> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return { text: result.value };
}

// --- Plain text / Markdown Loader ---
export function loadText(content: string): LoadedDocument {
  return { text: content };
}

// --- URL / Web Loader ---
export async function loadUrl(url: string): Promise<LoadedDocument> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'RAGForge/1.0 (+https://github.com/ragforge/ragforge)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);

  const html = await res.text();
  const { Readability } = await import('@mozilla/readability');
  const { JSDOM } = await import('jsdom');

  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (article) {
    return {
      text: article.textContent.replace(/\s+/g, ' ').trim(),
      metadata: {
        title: article.title,
        siteName: article.siteName,
        url,
      },
    };
  }

  // Fallback: strip all tags with cheerio
  const { load } = await import('cheerio');
  const $ = load(html);
  $('script, style, nav, footer, header, aside').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return { text, metadata: { url } };
}

// --- Dispatcher ---
export async function loadDocument(
  source: { type: 'pdf' | 'docx' | 'txt' | 'md' | 'url' | 'other'; buffer?: Buffer; text?: string; url?: string }
): Promise<LoadedDocument> {
  switch (source.type) {
    case 'pdf':  return loadPdf(source.buffer!);
    case 'docx': return loadDocx(source.buffer!);
    case 'txt':
    case 'md':
    case 'other':
      return loadText(source.text || source.buffer?.toString('utf-8') || '');
    case 'url':  return loadUrl(source.url!);
    default:     throw new Error(`Unsupported source type: ${source.type}`);
  }
}

export { chunkText, type TextChunk };
