import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { IngestionEvent, IngestionJob } from './types';

const timers = new WeakMap<QueryClient, Map<string, ReturnType<typeof setTimeout>>>();

/** Invalidates a query now, or at most once per `ms` when events arrive in bursts. */
function schedule(qc: QueryClient, queryKey: readonly unknown[], ms: number): void {
  if (ms <= 0) {
    void qc.invalidateQueries({ queryKey: [...queryKey] });
    return;
  }
  let pending = timers.get(qc);
  if (!pending) timers.set(qc, (pending = new Map()));
  const id = JSON.stringify(queryKey);
  if (pending.has(id)) return;
  pending.set(
    id,
    setTimeout(() => {
      pending!.delete(id);
      void qc.invalidateQueries({ queryKey: [...queryKey] });
    }, ms),
  );
}

function refreshAll(qc: QueryClient, kbId: string, ms: number): void {
  schedule(qc, ['jobs', kbId], ms);
  schedule(qc, ['documents', kbId], ms);
  schedule(qc, ['kb', kbId], ms);
}

/** Folds one server event into the cached queries. Progress is patched in place; state changes refetch. */
export function applyIngestionEvent(qc: QueryClient, kbId: string, event: IngestionEvent, debounceMs = 400): void {
  if (event.type === 'job.progress') {
    const jobs = qc.getQueryData<IngestionJob[]>(['jobs', kbId]);
    if (jobs?.some((j) => j.id === event.jobId)) {
      qc.setQueryData<IngestionJob[]>(
        ['jobs', kbId],
        jobs.map((j) =>
          j.id === event.jobId
            ? { ...j, status: 'running', stage: event.stage, chunksDone: event.chunksDone ?? j.chunksDone, chunksTotal: event.chunksTotal ?? j.chunksTotal }
            : j,
        ),
      );
    } else {
      schedule(qc, ['jobs', kbId], debounceMs);
    }
    return;
  }
  refreshAll(qc, kbId, debounceMs);
}

export interface IngestionEventsOptions {
  queryClient?: QueryClient;
  EventSourceImpl?: typeof EventSource;
  debounceMs?: number;
}

const MAX_BACKOFF_MS = 30_000;

function readToken(): string | null {
  try {
    return localStorage.getItem('ragforge_token');
  } catch {
    return null;
  }
}

/**
 * Live ingestion updates for a knowledge base over SSE. Reconnects with exponential backoff
 * (1 s up to 30 s) and refetches once the stream is back, so nothing is missed while offline.
 */
export function useIngestionEvents(kbId: string | undefined, opts: IngestionEventsOptions = {}): void {
  const qc = useQueryClient(opts.queryClient);
  const Impl = opts.EventSourceImpl ?? (typeof EventSource === 'undefined' ? undefined : EventSource);
  const debounceMs = opts.debounceMs ?? 400;

  useEffect(() => {
    if (!kbId || !Impl) return;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let wasDown = false;
    let stopped = false;

    const open = () => {
      if (stopped) return;
      const token = readToken();
      const url = `/api/ingestion/events?knowledgeBaseId=${encodeURIComponent(kbId)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
      const es = new Impl(url);
      source = es;
      es.onopen = () => {
        attempt = 0;
        if (wasDown) {
          wasDown = false;
          refreshAll(qc, kbId, 0);
        }
      };
      es.onmessage = (message) => {
        try {
          applyIngestionEvent(qc, kbId, JSON.parse(message.data) as IngestionEvent, debounceMs);
        } catch {
          /* ignore a malformed event */
        }
      };
      es.onerror = () => {
        es.close();
        source = null;
        wasDown = true;
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
        attempt++;
        timer = setTimeout(open, delay);
      };
    };

    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      source?.close();
    };
  }, [kbId, qc, Impl, debounceMs]);
}
