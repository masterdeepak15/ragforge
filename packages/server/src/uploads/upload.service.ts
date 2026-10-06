import { createHash, randomUUID } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rename, rm } from 'fs/promises';
import { extname, join } from 'path';
import { Transform, type Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { DocumentFileType } from '@ragforge/shared';
import type { DatabaseContext } from '../db/connection.js';
import type { EventBus } from '../events/event-bus.js';
import type { JobQueue } from '../queue/job-queue.js';

export interface UploadDeps {
  jobs?: JobQueue;
  events?: EventBus;
}

export interface SaveStreamInput {
  knowledgeBaseId: string;
  filename: string;
  mimeType: string;
  stream: Readable;
}

export interface SavedUpload {
  documentId: string;
  title: string;
  deduplicated: boolean;
}

const UNIQUE_VIOLATION = /UNIQUE constraint failed|duplicate key value|23505/i;

export function detectSourceType(filename: string, mimeType: string): DocumentFileType {
  const ext = extname(filename).toLowerCase();
  if (ext === '.pdf' || mimeType === 'application/pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.md' || ext === '.markdown') return 'md';
  if (ext === '.txt') return 'txt';
  return 'other';
}

export class UploadService {
  constructor(private db: DatabaseContext, private dataDir: string, private deps: UploadDeps = {}) {}

  /** Queues ingestion and announces a newly stored document. */
  private async announce(documentId: string, knowledgeBaseId: string): Promise<void> {
    await this.deps.jobs?.enqueue(documentId);
    this.deps.events?.publish({ type: 'document.uploaded', documentId, knowledgeBaseId });
  }

  get uploadsDir(): string {
    return join(this.dataDir, 'uploads');
  }

  /**
   * Streams the upload to `<dataDir>/uploads/<documentId>` while hashing it, then
   * records a `pending` document. Identical bytes already stored in the same
   * knowledge base resolve to the existing document.
   */
  async saveStream(input: SaveStreamInput): Promise<SavedUpload> {
    await mkdir(this.uploadsDir, { recursive: true });
    const documentId = randomUUID();
    const tmpPath = join(this.uploadsDir, `${documentId}.part`);

    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });

    try {
      await pipeline(input.stream, meter, createWriteStream(tmpPath));
    } catch (err) {
      await rm(tmpPath, { force: true });
      throw err;
    }
    return this.commit({
      documentId,
      knowledgeBaseId: input.knowledgeBaseId,
      filename: input.filename,
      mimeType: input.mimeType,
      tmpPath,
      contentHash: hash.digest('hex'),
      size,
    });
  }

  /** Hashes a fully assembled file (e.g. from a resumable upload) and records it. Consumes `partialPath`. */
  async finalizeFile(input: { knowledgeBaseId: string; filename: string; mimeType: string; partialPath: string }): Promise<SavedUpload> {
    await mkdir(this.uploadsDir, { recursive: true });
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(input.partialPath)) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
    return this.commit({
      documentId: randomUUID(),
      knowledgeBaseId: input.knowledgeBaseId,
      filename: input.filename,
      mimeType: input.mimeType,
      tmpPath: input.partialPath,
      contentHash: hash.digest('hex'),
      size,
    });
  }

  private async commit(c: {
    documentId: string;
    knowledgeBaseId: string;
    filename: string;
    mimeType: string;
    tmpPath: string;
    contentHash: string;
    size: number;
  }): Promise<SavedUpload> {
    const { documentId, tmpPath, contentHash, size } = c;
    const finalPath = join(this.uploadsDir, documentId);
    const input = { knowledgeBaseId: c.knowledgeBaseId, filename: c.filename, mimeType: c.mimeType };

    const existing = await this.findByHash(input.knowledgeBaseId, contentHash);
    if (existing) {
      await rm(tmpPath, { force: true });
      return { documentId: existing.id, title: existing.title, deduplicated: true };
    }

    await rename(tmpPath, finalPath);
    try {
      await this.db.client.execute({
        sql: `INSERT INTO documents (id, knowledge_base_id, title, source_type, file_path, file_size, mime_type, content_hash, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        args: [
          documentId,
          input.knowledgeBaseId,
          input.filename,
          detectSourceType(input.filename, input.mimeType),
          documentId,
          size,
          input.mimeType,
          contentHash,
        ],
      });
    } catch (err: any) {
      await rm(finalPath, { force: true });
      if (UNIQUE_VIOLATION.test(String(err?.message ?? err))) {
        const winner = await this.findByHash(input.knowledgeBaseId, contentHash);
        if (winner) return { documentId: winner.id, title: winner.title, deduplicated: true };
      }
      throw err;
    }
    await this.announce(documentId, input.knowledgeBaseId);
    return { documentId, title: input.filename, deduplicated: false };
  }

  /** Records a URL source (no file on disk). Same URL in the same KB is deduplicated. */
  async saveUrl(knowledgeBaseId: string, url: string, title?: string): Promise<SavedUpload> {
    const contentHash = createHash('sha256').update(`url:${url}`).digest('hex');
    const existing = await this.findByHash(knowledgeBaseId, contentHash);
    if (existing) return { documentId: existing.id, title: existing.title, deduplicated: true };

    const documentId = randomUUID();
    const docTitle = title?.trim() || url;
    try {
      await this.db.client.execute({
        sql: `INSERT INTO documents (id, knowledge_base_id, title, source_type, source_url, content_hash, status)
              VALUES (?, ?, ?, 'url', ?, ?, 'pending')`,
        args: [documentId, knowledgeBaseId, docTitle, url, contentHash],
      });
    } catch (err: any) {
      if (UNIQUE_VIOLATION.test(String(err?.message ?? err))) {
        const winner = await this.findByHash(knowledgeBaseId, contentHash);
        if (winner) return { documentId: winner.id, title: winner.title, deduplicated: true };
      }
      throw err;
    }
    await this.announce(documentId, knowledgeBaseId);
    return { documentId, title: docTitle, deduplicated: false };
  }

  private async findByHash(knowledgeBaseId: string, contentHash: string): Promise<{ id: string; title: string } | null> {
    const rs = await this.db.client.execute({
      sql: `SELECT id, title FROM documents WHERE knowledge_base_id = ? AND content_hash = ? LIMIT 1`,
      args: [knowledgeBaseId, contentHash],
    });
    const row = rs.rows[0] as any;
    return row ? { id: row.id as string, title: row.title as string } : null;
  }
}

/** Keep only the last path segment and repair UTF-8 names that busboy decoded as latin1. */
export function cleanFilename(raw: string): string {
  const base = raw.split(/[\/]/).pop() || 'upload';
  const repaired = Buffer.from(base, 'latin1').toString('utf8');
  return repaired.includes('�') ? base : repaired;
}
