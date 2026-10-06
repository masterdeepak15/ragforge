import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { applyIngestionEvent, useIngestionEvents } from './events';
import type { IngestionJob } from './types';

const job = (over: Partial<IngestionJob> = {}): IngestionJob => ({
  id: 'j1', documentId: 'd1', knowledgeBaseId: 'kb1', title: 'a.pdf', status: 'queued', stage: null,
  chunksTotal: null, chunksDone: null, attempts: 1, error: null, createdAt: '', updatedAt: '', ...over,
});

describe('applyIngestionEvent', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient();
  });

  it('patches job progress in the cache without refetching', () => {
    qc.setQueryData(['jobs', 'kb1'], [job(), job({ id: 'j2', documentId: 'd2' })]);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    applyIngestionEvent(qc, 'kb1', { type: 'job.progress', jobId: 'j1', documentId: 'd1', knowledgeBaseId: 'kb1', stage: 'embedding', chunksDone: 412, chunksTotal: 664 }, 0);
    const jobs = qc.getQueryData<IngestionJob[]>(['jobs', 'kb1'])!;
    expect(jobs[0]).toMatchObject({ status: 'running', stage: 'embedding', chunksDone: 412, chunksTotal: 664 });
    expect(jobs[1].status).toBe('queued');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('refreshes the job list when progress arrives for a job it has not seen', () => {
    qc.setQueryData(['jobs', 'kb1'], []);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    applyIngestionEvent(qc, 'kb1', { type: 'job.progress', jobId: 'new', documentId: 'd9', knowledgeBaseId: 'kb1', stage: 'loading' }, 0);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['jobs', 'kb1'] });
  });

  it.each([
    [{ type: 'document.uploaded', documentId: 'd1', knowledgeBaseId: 'kb1' }],
    [{ type: 'document.ready', documentId: 'd1', knowledgeBaseId: 'kb1', chunkCount: 3 }],
    [{ type: 'job.failed', jobId: 'j1', documentId: 'd1', knowledgeBaseId: 'kb1', error: 'x' }],
  ] as const)('refreshes jobs, documents and counts on %o', (event) => {
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    applyIngestionEvent(qc, 'kb1', event as never, 0);
    const keys = invalidate.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey[0]);
    expect(keys).toEqual(expect.arrayContaining(['jobs', 'documents', 'kb']));
  });

  it('coalesces a burst of events into one refresh per key', async () => {
    vi.useFakeTimers();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    for (let i = 0; i < 50; i++) applyIngestionEvent(qc, 'kb1', { type: 'document.ready', documentId: `d${i}`, knowledgeBaseId: 'kb1', chunkCount: 1 }, 500);
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(invalidate).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe('useIngestionEvents', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    localStorage.setItem('ragforge_token', 'tok123');
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const qc = new QueryClient();
    qc.setQueryData(['jobs', 'kb1'], [job()]);
    const hook = renderHook(() => useIngestionEvents('kb1', { queryClient: qc, EventSourceImpl: FakeEventSource as never, debounceMs: 0 }));
    return { qc, hook };
  };

  it('subscribes for the knowledge base with the session token and applies events', () => {
    const { qc } = setup();
    const es = FakeEventSource.instances[0];
    expect(es.url).toBe('/api/ingestion/events?knowledgeBaseId=kb1&token=tok123');
    es.emit({ type: 'job.progress', jobId: 'j1', documentId: 'd1', knowledgeBaseId: 'kb1', stage: 'chunking' });
    expect(qc.getQueryData<IngestionJob[]>(['jobs', 'kb1'])![0].stage).toBe('chunking');
  });

  it('ignores malformed messages', () => {
    setup();
    expect(() => FakeEventSource.instances[0].onmessage?.({ data: '{not json' })).not.toThrow();
  });

  it('reconnects with backoff after an error and resyncs once reconnected', () => {
    const { qc } = setup();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    FakeEventSource.instances[0].onerror?.();
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1].onopen?.();
    expect(invalidate).toHaveBeenCalled();
  });

  it('backs off further on repeated failures (capped at 30 s)', () => {
    setup();
    for (let i = 0; i < 8; i++) {
      FakeEventSource.instances.at(-1)!.onerror?.();
      vi.advanceTimersByTime(30_000);
    }
    expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(8);
    const before = FakeEventSource.instances.length;
    FakeEventSource.instances.at(-1)!.onerror?.();
    vi.advanceTimersByTime(29_999);
    expect(FakeEventSource.instances).toHaveLength(before);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(before + 1);
  });

  it('closes the stream and stops reconnecting on unmount', () => {
    const { hook } = setup();
    FakeEventSource.instances[0].onerror?.();
    hook.unmount();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });
});
