import type { Job, JobQueue } from './job-queue.js';

/** Throw from a handler when retrying cannot help (corrupt file, no text, misconfiguration). */
export class NonRetryableError extends Error {
  readonly retryable = false;
}

export type JobHandler = (job: Job, signal: AbortSignal) => Promise<void>;

export interface WorkerStartOptions {
  concurrency: number;
  handler: JobHandler;
}

/** Runs queued jobs with a fixed number of concurrent slots. */
export class Worker {
  private running = false;
  private slots: Promise<void>[] = [];
  private controllers = new Map<string, AbortController>();
  private sleepers = new Set<() => void>();
  private readonly pollMs: number;

  constructor(private queue: JobQueue, opts: { pollMs?: number } = {}) {
    this.pollMs = opts.pollMs ?? 500;
  }

  start({ concurrency, handler }: WorkerStartOptions): void {
    if (this.running) return;
    this.running = true;
    this.slots = Array.from({ length: Math.max(1, concurrency) }, () => this.loop(handler));
  }

  /** Stops claiming new jobs and resolves once in-flight handlers have finished. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake();
    await Promise.all(this.slots);
    this.slots = [];
  }

  /** Nudges idle slots to look for work immediately instead of waiting for the next poll. */
  wake(): void {
    for (const resolve of [...this.sleepers]) resolve();
  }

  /** Cancels a queued or running job; a running handler is aborted through its signal. */
  async cancel(jobId: string): Promise<void> {
    await this.queue.cancel(jobId);
    this.controllers.get(jobId)?.abort();
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, this.pollMs);
      this.sleepers.add(done);
    });
  }

  private async loop(handler: JobHandler): Promise<void> {
    while (this.running) {
      let job: Job | null = null;
      try {
        job = await this.queue.claimNext();
      } catch (err) {
        console.error('[RAGForge] job claim failed:', err);
      }
      if (!job) {
        await this.sleep();
        continue;
      }

      const controller = new AbortController();
      this.controllers.set(job.id, controller);
      try {
        await handler(job, controller.signal);
        await this.queue.complete(job.id);
      } catch (err: any) {
        if (!controller.signal.aborted) {
          await this.queue
            .fail(job.id, err?.message ?? String(err), err?.retryable !== false)
            .catch((e) => console.error('[RAGForge] recording job failure failed:', e));
        }
      } finally {
        this.controllers.delete(job.id);
      }
    }
  }
}
