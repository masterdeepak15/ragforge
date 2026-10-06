import { randomUUID } from 'crypto';
import type { DatabaseContext } from '../db/connection.js';
import type { IngestStage } from '../events/event-bus.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  documentId: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  error?: string;
}

export interface JobQueueOptions {
  /** Attempts before a retryable failure becomes permanent. Default 3. */
  maxAttempts?: number;
  /** First retry delay; doubles each attempt. Default 5000 ms. */
  backoffBaseMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

function toJob(row: any): Job {
  return {
    id: row.id,
    documentId: row.document_id,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    error: row.error ?? undefined,
  };
}

/**
 * Persistent ingestion queue stored in the `ingestion_jobs` table. All state transitions are
 * single guarded UPDATEs (`WHERE status = ...`) so a job cannot be claimed twice and a
 * cancelled job is never overwritten by a late `complete`/`fail`.
 */
export class JobQueue {
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly now: () => number;

  constructor(private db: DatabaseContext, opts: JobQueueOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 5000;
    this.now = opts.now ?? Date.now;
  }

  private get client() {
    return this.db.client;
  }

  async enqueue(documentId: string): Promise<string> {
    const id = randomUUID();
    await this.client.execute({
      sql: `INSERT INTO ingestion_jobs (id, document_id, status, max_attempts, created_ms) VALUES (?, ?, 'queued', ?, ?)`,
      args: [id, documentId, this.maxAttempts, this.now()],
    });
    return id;
  }

  /** Atomically takes the oldest runnable job and marks it running (attempts + 1). */
  async claimNext(): Promise<Job | null> {
    const now = this.now();
    const rs = await this.client.execute({
      sql: `UPDATE ingestion_jobs
            SET status = 'running', attempts = attempts + 1, locked_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = (
              SELECT id FROM ingestion_jobs
              WHERE status = 'queued' AND (run_after IS NULL OR run_after <= ?)
              ORDER BY created_ms, id LIMIT 1
            ) AND status = 'queued'
            RETURNING *`,
      args: [now, now],
    });
    return rs.rows[0] ? toJob(rs.rows[0]) : null;
  }

  async complete(jobId: string): Promise<void> {
    await this.client.execute({
      sql: `UPDATE ingestion_jobs SET status = 'done', error = NULL, locked_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'running'`,
      args: [jobId],
    });
  }

  /** Records a failure: retryable errors go back in the queue with backoff until attempts run out. */
  async fail(jobId: string, error: string, retryable: boolean): Promise<void> {
    const rs = await this.client.execute({
      sql: `SELECT attempts, max_attempts FROM ingestion_jobs WHERE id = ? AND status = 'running'`,
      args: [jobId],
    });
    const row = rs.rows[0] as any;
    if (!row) return;
    const attempts = Number(row.attempts);
    if (retryable && attempts < Number(row.max_attempts)) {
      const delay = this.backoffBaseMs * 2 ** (attempts - 1);
      await this.client.execute({
        sql: `UPDATE ingestion_jobs SET status = 'queued', error = ?, run_after = ?, locked_at = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND status = 'running'`,
        args: [error, this.now() + delay, jobId],
      });
    } else {
      await this.client.execute({
        sql: `UPDATE ingestion_jobs SET status = 'failed', error = ?, locked_at = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND status = 'running'`,
        args: [error, jobId],
      });
    }
  }

  /** Re-queues running jobs whose lock is older than `olderThanMs` (crash recovery). Returns how many. */
  async recoverStale(olderThanMs: number): Promise<number> {
    const rs = await this.client.execute({
      sql: `UPDATE ingestion_jobs SET status = 'queued', locked_at = NULL, run_after = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE status = 'running' AND locked_at <= ?`,
      args: [this.now() - olderThanMs],
    });
    return rs.rowsAffected;
  }

  async cancel(jobId: string): Promise<void> {
    await this.client.execute({
      sql: `UPDATE ingestion_jobs SET status = 'cancelled', locked_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status IN ('queued', 'running')`,
      args: [jobId],
    });
  }

  /** Puts a failed or cancelled job back in the queue with a fresh attempt budget. */
  async retry(jobId: string): Promise<void> {
    await this.client.execute({
      sql: `UPDATE ingestion_jobs
            SET status = 'queued', attempts = 0, error = NULL, run_after = NULL, locked_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status IN ('failed', 'cancelled')`,
      args: [jobId],
    });
  }

  async updateProgress(jobId: string, p: { stage: IngestStage; chunksTotal?: number; chunksDone?: number }): Promise<void> {
    await this.client.execute({
      sql: `UPDATE ingestion_jobs
            SET progress_stage = ?, chunks_total = COALESCE(?, chunks_total), chunks_done = COALESCE(?, chunks_done), updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
      args: [p.stage, p.chunksTotal ?? null, p.chunksDone ?? null, jobId],
    });
  }
}
