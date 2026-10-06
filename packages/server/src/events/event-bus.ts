export type IngestStage = 'loading' | 'chunking' | 'embedding' | 'storing';

export type AppEvent =
  | { type: 'document.uploaded'; documentId: string; knowledgeBaseId: string }
  | {
      type: 'job.progress';
      jobId: string;
      documentId: string;
      knowledgeBaseId: string;
      stage: IngestStage;
      chunksTotal?: number;
      chunksDone?: number;
    }
  | { type: 'document.ready'; documentId: string; knowledgeBaseId: string; chunkCount: number }
  | { type: 'job.failed'; jobId: string; documentId: string; knowledgeBaseId: string; error: string };

export interface EventBus {
  publish(event: AppEvent): void;
  /** Returns an unsubscribe function. */
  subscribe(listener: (event: AppEvent) => void): () => void;
}

/**
 * Default, dependency-free bus for single-node deployments. Delivery is synchronous and in order;
 * a failing listener never affects other listeners or the publisher. A Redis/NATS implementation
 * of `EventBus` can replace this for multi-node setups.
 */
export class InProcessEventBus implements EventBus {
  private listeners = new Set<(event: AppEvent) => void>();

  publish(event: AppEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error('[RAGForge] event listener failed:', err);
      }
    }
  }

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
