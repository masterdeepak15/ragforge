import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SystemInfo } from './SystemInfo';
import { json, mockFetch } from '../../test/fetch';

const STATS = {
  knowledgeBases: 2, documents: { total: 5, ready: 5, processing: 0, failed: 0 }, chunks: 100, storageBytes: 2_500_000,
  queue: { queued: 0, running: 0, failed: 0 }, recent: [],
  system: { version: '1.0.0', storageMode: 'sqlite', ingestConcurrency: 2, workerRunning: true },
};

function renderIt(stats: unknown) {
  mockFetch([{ method: 'GET', path: '/api/stats', handler: () => stats }]);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SystemInfo />
    </QueryClientProvider>,
  );
}

describe('SystemInfo', () => {
  it('describes the installation in plain words', async () => {
    renderIt(STATS);
    expect(await screen.findByText('RAGForge 1.0.0')).toBeInTheDocument();
    expect(screen.getByText('SQLite (local file)')).toBeInTheDocument();
    expect(screen.getByText('2 at a time, running')).toBeInTheDocument();
    expect(screen.getByText('2.4 MB')).toBeInTheDocument();
  });

  it('names PostgreSQL and a stopped worker', async () => {
    renderIt({ ...STATS, system: { ...STATS.system, storageMode: 'postgres', workerRunning: false } });
    expect(await screen.findByText('PostgreSQL with pgvector')).toBeInTheDocument();
    expect(screen.getByText('2 at a time, stopped')).toBeInTheDocument();
  });

  it('tells the user how to change the ingestion speed', async () => {
    renderIt(STATS);
    expect(await screen.findByText(/INGEST_CONCURRENCY/)).toBeInTheDocument();
  });

  it('says so when it cannot load', async () => {
    mockFetch([{ method: 'GET', path: '/api/stats', handler: () => json({ error: 'nope' }, 500) }]);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SystemInfo />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });
});
