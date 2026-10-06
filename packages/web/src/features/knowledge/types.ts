export type DocStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface DocumentRow {
  id: string;
  knowledge_base_id: string;
  title: string;
  source_type: string;
  source_url?: string | null;
  file_size: number | null;
  status: DocStatus | string;
  chunk_count: number | null;
  error_message?: string | null;
  created_at: string;
}

export interface DocumentCounts {
  ready: number;
  failed: number;
  processing: number;
  pending: number;
}

export interface DocumentsPage {
  items: DocumentRow[];
  total: number;
  counts: DocumentCounts;
  stats: { documents: number; readyDocuments: number; chunks: number; bytes: number };
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface IngestionJob {
  id: string;
  documentId: string;
  knowledgeBaseId: string;
  title: string;
  status: JobStatus;
  stage: string | null;
  chunksTotal: number | null;
  chunksDone: number | null;
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Events pushed over /api/ingestion/events. */
export type IngestionEvent =
  | { type: 'document.uploaded'; documentId: string; knowledgeBaseId: string }
  | { type: 'job.progress'; jobId: string; documentId: string; knowledgeBaseId: string; stage: string; chunksTotal?: number; chunksDone?: number }
  | { type: 'document.ready'; documentId: string; knowledgeBaseId: string; chunkCount: number }
  | { type: 'job.failed'; jobId: string; documentId: string; knowledgeBaseId: string; error: string };

export interface DocumentFilters {
  status: 'all' | 'ready' | 'processing' | 'failed';
  q: string;
}

/** Maps the UI filter onto the API's status values. */
export function statusParam(status: DocumentFilters['status']): string {
  switch (status) {
    case 'ready':
      return 'ready';
    case 'failed':
      return 'failed';
    case 'processing':
      return 'pending,processing';
    default:
      return '';
  }
}

/** A knowledge base as listed by GET /api/knowledge-bases. */
export interface KbSummary {
  id: string;
  name: string;
  description?: string | null;
  documentCount?: number;
  chunkCount?: number;
  created_at?: string;
}
