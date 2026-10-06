import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DashboardPage from './DashboardPage';
import { json, mockFetch } from '../../test/fetch';

const STATS = {
  knowledgeBases: 2,
  documents: { total: 1290, ready: 1284, processing: 3, failed: 3 },
  chunks: 96410,
  storageBytes: 4_500_000_000,
  queue: { queued: 14, running: 3, failed: 1 },
  recent: [
    { id: 'd1', title: 'runbook-payments.md', status: 'ready', knowledgeBaseId: 'kb1', knowledgeBaseName: 'Engineering handbook', at: '2026-10-06 11:58:00' },
    { id: 'd2', title: 'scan-0114-invoice.pdf', status: 'failed', knowledgeBaseId: 'kb1', knowledgeBaseName: 'Engineering handbook', at: '2026-10-06 11:00:00' },
  ],
  system: { version: '1.0.0', storageMode: 'sqlite', ingestConcurrency: 2, workerRunning: true },
};
const SETUP = { isInitialized: true, hasAdminUser: true, hasDefaultProvider: true, hasKnowledgeBase: true, version: '1.0.0', storageMode: 'sqlite' };

function renderPage(stats: unknown = STATS, setup: unknown = SETUP) {
  mockFetch([
    { method: 'GET', path: '/api/stats', handler: () => stats },
    { method: 'GET', path: '/api/setup/status', handler: () => setup },
  ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DashboardPage', () => {
  it('summarises the library and the ingestion queue in plain words', async () => {
    renderPage();
    expect(await screen.findByText(/1,284 documents ready/)).toBeInTheDocument();
    expect(screen.getByText(/96,410 chunks/)).toBeInTheDocument();
    expect(screen.getByText(/4\.2 GB/)).toBeInTheDocument();
    expect(screen.getByText(/2 knowledge bases/)).toBeInTheDocument();
    expect(screen.getByText(/3 processing/)).toBeInTheDocument();
    expect(screen.getByText(/14 queued/)).toBeInTheDocument();
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
  });

  it('lists recent documents with their knowledge base and status', async () => {
    renderPage();
    const row = await screen.findByRole('row', { name: /runbook-payments\.md/ });
    expect(within(row).getByRole('link', { name: 'Engineering handbook' })).toHaveAttribute('href', '/knowledge-bases/kb1');
    expect(within(row).getByText('Ready')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /scan-0114-invoice\.pdf/ })).getByText('Failed')).toBeInTheDocument();
  });

  it('does not show the getting-started checklist once everything is set up', async () => {
    renderPage();
    await screen.findByText(/1,284 documents ready/);
    expect(screen.queryByText('Get started')).not.toBeInTheDocument();
  });

  it('walks a brand new install through the first steps in order', async () => {
    renderPage(
      { ...STATS, knowledgeBases: 0, documents: { total: 0, ready: 0, processing: 0, failed: 0 }, chunks: 0, storageBytes: 0, queue: { queued: 0, running: 0, failed: 0 }, recent: [] },
      { ...SETUP, hasDefaultProvider: false, hasKnowledgeBase: false },
    );
    expect(await screen.findByText('Get started')).toBeInTheDocument();
    const steps = screen.getAllByRole('listitem');
    expect(steps).toHaveLength(4);
    expect(within(steps[0]).getByRole('link', { name: 'Add an AI provider' })).toHaveAttribute('href', '/settings');
    expect(within(steps[1]).getByRole('link', { name: 'Create a knowledge base' })).toHaveAttribute('href', '/knowledge-bases');
    expect(within(steps[2]).getByText('Upload documents')).toBeInTheDocument();
    expect(within(steps[3]).getByRole('link', { name: 'Connect an AI tool' })).toHaveAttribute('href', '/connect');
  });

  it('marks finished steps as done', async () => {
    renderPage(
      { ...STATS, documents: { total: 0, ready: 0, processing: 0, failed: 0 }, recent: [], chunks: 0, storageBytes: 0 },
      { ...SETUP, hasDefaultProvider: true, hasKnowledgeBase: true },
    );
    await screen.findByText('Get started');
    const steps = screen.getAllByRole('listitem');
    expect(within(steps[0]).getByText('Done')).toBeInTheDocument();
    expect(within(steps[1]).getByText('Done')).toBeInTheDocument();
    expect(within(steps[2]).queryByText('Done')).not.toBeInTheDocument();
  });

  it('shows a skeleton while loading', () => {
    mockFetch([
      { method: 'GET', path: '/api/stats', handler: () => new Promise(() => {}) },
      { method: 'GET', path: '/api/setup/status', handler: () => SETUP },
    ]);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('dashboard-loading')).toBeInTheDocument();
  });

  it('explains a failure and retries', async () => {
    let fail = true;
    mockFetch([
      { method: 'GET', path: '/api/stats', handler: () => (fail ? json({ error: 'Database unavailable' }, 500) : STATS) },
      { method: 'GET', path: '/api/setup/status', handler: () => SETUP },
    ]);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/1,284 documents ready/)).toBeInTheDocument();
  });
});
