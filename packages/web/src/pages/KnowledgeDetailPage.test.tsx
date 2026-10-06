import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import KnowledgeDetailPage from './KnowledgeDetailPage';
import { json, mockFetch, type Route as FetchRoute } from '../test/fetch';
import * as upload from '../lib/upload';

vi.mock('../lib/upload', async (orig) => ({ ...(await orig<typeof import('../lib/upload')>()), uploadFiles: vi.fn() }));

class SilentEventSource {
  onmessage = null;
  onerror = null;
  onopen = null;
  close() {}
}

const KB = { id: 'kb1', name: 'Engineering handbook', description: 'Runbooks and postmortems', embedding_model: 'nomic-embed-text', embedding_dimension: 768, chunk_size: 1000, chunk_overlap: 200, documentCount: 4, chunkCount: 135 };
const doc = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, knowledge_base_id: 'kb1', title, source_type: 'pdf', file_size: 1000, status: 'ready', chunk_count: 10, created_at: '2026-10-06 11:00:00', ...over,
});
const PAGE = {
  items: [doc('d1', 'runbook-payments.md', { source_type: 'md', chunk_count: 38 }), doc('d2', 'incident-postmortem.pdf', { chunk_count: 91 }), doc('d3', 'scan-0114-invoice.pdf', { status: 'failed', chunk_count: 0, error_message: 'No extractable text' })],
  total: 3,
  counts: { ready: 2, failed: 1, processing: 0, pending: 0 },
  stats: { documents: 3, readyDocuments: 2, chunks: 129, bytes: 4_500_000 },
};
const JOB = { id: 'j1', documentId: 'd9', knowledgeBaseId: 'kb1', title: 'Q3-architecture-review.pdf', status: 'running', stage: 'embedding', chunksTotal: 664, chunksDone: 412, attempts: 1, error: null, createdAt: '', updatedAt: '' };

function baseRoutes(over: Partial<{ page: unknown; jobs: unknown[]; kb: unknown }> = {}): FetchRoute[] {
  return [
    { method: 'GET', path: '/api/knowledge-bases/kb1', handler: () => over.kb ?? KB },
    { method: 'GET', path: '/api/knowledge-bases/kb1/documents', handler: () => over.page ?? PAGE },
    { method: 'GET', path: '/api/ingestion/jobs', handler: () => over.jobs ?? [] },
    { method: 'GET', path: '/api/providers', handler: () => [{ id: 'p1', name: 'Ollama', provider: 'ollama', isDefaultLlm: true, isDefaultEmbedding: true }] },
    { method: 'GET', path: '/api/providers/capabilities', handler: () => ({ providers: [{ type: 'ollama', label: 'Ollama', supportsLlm: true, supportsEmbeddings: true }] }) },
  ];
}

function renderPage(path = '/knowledge-bases/kb1') {
  vi.stubGlobal('EventSource', SilentEventSource);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/knowledge-bases" element={<div>Knowledge bases list</div>} />
          <Route path="/knowledge-bases/:id" element={<KnowledgeDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(upload.uploadFiles).mockReset();
});

describe('KnowledgeDetailPage', () => {
  it('shows the knowledge base, a live summary line and its documents', async () => {
    mockFetch(baseRoutes());
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Engineering handbook' })).toBeInTheDocument();
    expect(screen.getByText('Runbooks and postmortems')).toBeInTheDocument();
    expect(await screen.findByText(/2 documents ready · 129 chunks · 4\.3 MB/)).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /runbook-payments\.md/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Knowledge bases' })).toHaveAttribute('href', '/knowledge-bases');
  });

  it('mentions how many documents are still processing', async () => {
    mockFetch(baseRoutes({ page: { ...PAGE, counts: { ...PAGE.counts, processing: 2, pending: 1 } } }));
    renderPage();
    expect(await screen.findByText(/3 processing/)).toBeInTheDocument();
  });

  it('shows running jobs with their progress', async () => {
    mockFetch(baseRoutes({ jobs: [JOB] }));
    renderPage();
    const row = await screen.findByRole('row', { name: /Q3-architecture-review\.pdf/ });
    expect(within(row).getByText('Embedding')).toBeInTheDocument();
    expect(within(row).getByText('412 / 664')).toBeInTheDocument();
  });

  it('retries a failed job', async () => {
    const failed = { ...JOB, status: 'failed', stage: null, error: 'No embedding provider is configured. Configure an embedding provider in Settings.' };
    const net = mockFetch([...baseRoutes({ jobs: [failed] }), { method: 'POST', path: '/api/ingestion/jobs/j1/retry', handler: () => ({ id: 'j1', status: 'queued' }) }]);
    renderPage();
    expect(await screen.findByText(/Configure an embedding provider in Settings/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry Q3-architecture-review.pdf' }));
    await waitFor(() => expect(net.find('POST', /j1\/retry$/)).toHaveLength(1));
  });

  it('uploads dropped files and refreshes when they finish', async () => {
    const net = mockFetch(baseRoutes());
    vi.mocked(upload.uploadFiles).mockImplementation((files, _kb, onUpdate) => {
      onUpdate({ id: 'u1', name: files[0].name, size: 100, status: 'uploading', loaded: 40 });
      return { cancel: vi.fn(), done: Promise.resolve().then(() => onUpdate({ id: 'u1', name: files[0].name, size: 100, status: 'done', loaded: 100, documentId: 'dN' })) };
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Engineering handbook' });
    const before = net.find('GET', /kb1\/documents$/).length;
    await userEvent.upload(screen.getByLabelText('Choose files'), new File(['x'], 'new-policy.pdf'));
    expect(upload.uploadFiles).toHaveBeenCalledTimes(1);
    expect(vi.mocked(upload.uploadFiles).mock.calls[0][1]).toBe('kb1');
    await waitFor(() => expect(net.find('GET', /kb1\/documents$/).length).toBeGreaterThan(before));
  });

  it('deletes selected documents through the bulk endpoint after confirmation', async () => {
    const net = mockFetch([...baseRoutes(), { method: 'POST', path: '/api/documents/bulk-delete', handler: () => ({ deleted: 1 }) }]);
    renderPage();
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select runbook-payments.md' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete document' }));
    await waitFor(() => expect(net.find('POST', /bulk-delete$/)).toHaveLength(1));
    expect(net.find('POST', /bulk-delete$/)[0].body).toEqual({ ids: ['d1'] });
  });

  it('requests filtered pages from the server', async () => {
    const net = mockFetch(baseRoutes());
    renderPage();
    await screen.findByRole('row', { name: /runbook-payments\.md/ });
    await userEvent.click(screen.getByRole('button', { name: /^Failed/ }));
    await waitFor(() => expect(net.find('GET', /kb1\/documents$/).some((c) => c.url.searchParams.get('status') === 'failed')).toBe(true));
  });

  it('says so when the knowledge base does not exist', async () => {
    mockFetch([{ method: 'GET', path: '/api/knowledge-bases/nope', handler: () => json({ error: 'Knowledge base not found' }, 404) }, { method: 'GET', path: '/api/knowledge-bases/nope/documents', handler: () => json({ error: 'Knowledge base not found' }, 404) }, { method: 'GET', path: '/api/ingestion/jobs', handler: () => [] }]);
    renderPage('/knowledge-bases/nope');
    expect(await screen.findByText('Knowledge base not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to knowledge bases' })).toBeInTheDocument();
  });

  it('has a settings tab with the indexing configuration and a guarded delete', async () => {
    const net = mockFetch([...baseRoutes(), { method: 'DELETE', path: '/api/knowledge-bases/kb1', handler: () => undefined }]);
    renderPage();
    await screen.findByRole('heading', { name: 'Engineering handbook' });
    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByText('nomic-embed-text')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete knowledge base' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete “Engineering handbook”?' });
    expect(net.find('DELETE', /kb1$/)).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete knowledge base' }));
    expect(await screen.findByText('Knowledge bases list')).toBeInTheDocument();
    expect(net.find('DELETE', /kb1$/)).toHaveLength(1);
  });
});
