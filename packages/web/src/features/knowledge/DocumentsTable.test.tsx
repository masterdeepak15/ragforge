import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DocumentsTable } from './DocumentsTable';
import type { DocumentRow } from './types';

const doc = (i: number, over: Partial<DocumentRow> = {}): DocumentRow => ({
  id: `d${i}`, knowledge_base_id: 'kb1', title: `file-${i}.pdf`, source_type: 'pdf', file_size: 2_400_000, status: 'ready',
  chunk_count: 91, created_at: '2026-10-06 11:58:00', ...over,
});
const counts = { ready: 3, failed: 1, processing: 1, pending: 0 };

function setup(props: Partial<React.ComponentProps<typeof DocumentsTable>> = {}) {
  const handlers = { onFiltersChange: vi.fn(), onLoadMore: vi.fn(), onDelete: vi.fn(), onViewChunks: vi.fn() };
  const items = props.items ?? [doc(1), doc(2)];
  const utils = render(
    <DocumentsTable
      items={items}
      total={props.total ?? items.length}
      counts={counts}
      filters={{ status: 'all', q: '' }}
      hasMore={false}
      loading={false}
      searchDebounceMs={0}
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...utils };
}
const rows = () => screen.getAllByRole('row').filter((r) => r.getAttribute('aria-rowindex') !== '1');

describe('DocumentsTable', () => {
  it('shows name, status, chunks, size and age for each document', () => {
    setup({ items: [doc(1, { title: 'runbook-payments.md', chunk_count: 38, file_size: 112 * 1024 })] });
    const row = screen.getByRole('row', { name: /runbook-payments\.md/ });
    expect(within(row).getByText('Ready')).toBeInTheDocument();
    expect(within(row).getByText('38')).toBeInTheDocument();
    expect(within(row).getByText('112 KB')).toBeInTheDocument();
    expect(within(row).getByText(/ago|now/)).toBeInTheDocument();
  });

  it('puts the failure reason right under the name of a failed document', () => {
    setup({ items: [doc(1, { status: 'failed', error_message: 'No extractable text', chunk_count: 0 })] });
    const row = screen.getByRole('row', { name: /file-1\.pdf/ });
    expect(within(row).getByText('Failed')).toBeInTheDocument();
    expect(within(row).getByText('No extractable text')).toBeInTheDocument();
  });

  it('renders only the visible slice of a very large list', () => {
    const many = Array.from({ length: 500 }, (_, i) => doc(i));
    setup({ items: many, total: 5000, hasMore: true });
    expect(rows().length).toBeLessThan(100);
    expect(rows().length).toBeGreaterThan(5);
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '5001');
  });

  it('asks for the next page when the end of the loaded list is in view', () => {
    const h = setup({ items: Array.from({ length: 12 }, (_, i) => doc(i)), total: 300, hasMore: true });
    expect(h.onLoadMore).toHaveBeenCalled();
  });

  it('does not ask for more when everything is loaded or a page is already loading', () => {
    const a = setup({ items: [doc(1)], hasMore: false });
    expect(a.onLoadMore).not.toHaveBeenCalled();
    a.unmount();
    const b = setup({ items: [doc(1)], hasMore: true, loading: true });
    expect(b.onLoadMore).not.toHaveBeenCalled();
  });

  it('filters by status using the counts as labels', async () => {
    const h = setup();
    expect(screen.getByRole('button', { name: 'All 5' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Failed 1' }));
    expect(h.onFiltersChange).toHaveBeenCalledWith({ status: 'failed', q: '' });
    await userEvent.click(screen.getByRole('button', { name: 'Processing 1' }));
    expect(h.onFiltersChange).toHaveBeenLastCalledWith({ status: 'processing', q: '' });
  });

  it('reports the search text as the user types', async () => {
    const h = setup();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search documents' }), 'run');
    expect(h.onFiltersChange).toHaveBeenLastCalledWith({ status: 'all', q: 'run' });
  });

  it('deletes selected documents only after an in-app confirmation (never window.confirm)', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
    const h = setup({ items: [doc(1), doc(2), doc(3)] });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select file-1.pdf' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select file-3.pdf' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete 2 documents?' })).toBeInTheDocument();
    expect(h.onDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete documents' }));
    expect(h.onDelete).toHaveBeenCalledWith(['d1', 'd3']);
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('keeps everything when the confirmation is cancelled', async () => {
    const h = setup();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select file-1.pdf' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.onDelete).not.toHaveBeenCalled();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('selects every loaded document at once and clears the selection', async () => {
    setup({ items: [doc(1), doc(2), doc(3)] });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all loaded documents' }));
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('opens the chunk inspector for a document', async () => {
    const h = setup({ items: [doc(1)] });
    await userEvent.click(screen.getByRole('button', { name: 'View chunks of file-1.pdf' }));
    expect(h.onViewChunks).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }));
  });

  it('invites the first upload when the knowledge base is empty', () => {
    setup({ items: [], total: 0, counts: { ready: 0, failed: 0, processing: 0, pending: 0 } });
    expect(screen.getByText('No documents yet')).toBeInTheDocument();
  });

  it('offers to clear filters when a filter matches nothing', async () => {
    const h = setup({ items: [], total: 0, filters: { status: 'failed', q: 'zzz' } });
    expect(screen.getByText('No documents match')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(h.onFiltersChange).toHaveBeenCalledWith({ status: 'all', q: '' });
  });

  it('shows skeleton rows while the first page loads', () => {
    setup({ items: [], total: 0, loading: true });
    expect(screen.getByTestId('documents-loading')).toBeInTheDocument();
    expect(screen.queryByText('No documents yet')).not.toBeInTheDocument();
  });
});
