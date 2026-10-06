import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RetrievalSection } from './RetrievalSection';
import { json, mockFetch } from '../../test/fetch';

const DEFAULTS = { topK: 6, useHybridSearch: true, vectorWeight: 0.7, bm25Weight: 0.3, minSimilarity: 0.3 };
const view = (settings = DEFAULTS, customized = false) => ({ settings, defaults: DEFAULTS, customized });

function setup(initial = view(), extra: Parameters<typeof mockFetch>[0] = []) {
  const net = mockFetch([{ method: 'GET', path: '/api/knowledge-bases/kb1/retrieval-settings', handler: () => initial }, ...extra]);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RetrievalSection kbId="kb1" />
    </QueryClientProvider>,
  );
  return net;
}

describe('RetrievalSection', () => {
  it('shows how this knowledge base is searched today', async () => {
    setup(view({ ...DEFAULTS, topK: 8, minSimilarity: 0.45 }, true));
    expect(await screen.findByLabelText('Passages per search')).toHaveValue(8);
    expect(screen.getByLabelText(/Minimum similarity/)).toHaveValue('0.45');
    expect(screen.getByText(/Used by the Playground, Chat and connected AI tools/)).toBeInTheDocument();
  });

  it('cannot be saved until something changes', async () => {
    setup();
    await screen.findByLabelText('Passages per search');
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Minimum similarity/), { target: { value: '0.5' } });
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled();
  });

  it('saves the changed settings for this knowledge base', async () => {
    const net = setup(view(), [
      { method: 'PUT', path: '/api/knowledge-bases/kb1/retrieval-settings', handler: () => view({ ...DEFAULTS, minSimilarity: 0.5 }, true) },
    ]);
    await screen.findByLabelText('Passages per search');
    fireEvent.change(screen.getByLabelText(/Minimum similarity/), { target: { value: '0.5' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(net.find('PUT', /retrieval-settings$/)).toHaveLength(1));
    expect(net.find('PUT', /retrieval-settings$/)[0].body).toEqual({ ...DEFAULTS, minSimilarity: 0.5 });
    expect(await screen.findByRole('button', { name: 'Save settings' })).toBeDisabled(); // saved: nothing left to save
  });

  it('turns the weights off when keyword search is off', async () => {
    setup();
    await screen.findByLabelText('Passages per search');
    await userEvent.click(screen.getByRole('checkbox', { name: /keyword search/i }));
    expect(screen.getByLabelText(/Meaning weight/)).toBeDisabled();
    expect(screen.getByLabelText(/Keyword weight/)).toBeDisabled();
  });

  it('shows why saving failed', async () => {
    setup(view(), [{ method: 'PUT', path: '/api/knowledge-bases/kb1/retrieval-settings', handler: () => json({ error: 'topK must be a whole number from 1 to 50.' }, 400) }]);
    await screen.findByLabelText('Passages per search');
    fireEvent.change(screen.getByLabelText('Passages per search'), { target: { value: '12' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('topK must be a whole number');
  });

  it('offers to go back to the defaults only when settings were customized', async () => {
    setup(view());
    await screen.findByLabelText('Passages per search');
    expect(screen.queryByRole('button', { name: 'Reset to defaults' })).not.toBeInTheDocument();
  });

  it('resets to the defaults', async () => {
    const net = setup(view({ ...DEFAULTS, topK: 12 }, true), [
      { method: 'DELETE', path: '/api/knowledge-bases/kb1/retrieval-settings', handler: () => view() },
    ]);
    await userEvent.click(await screen.findByRole('button', { name: 'Reset to defaults' }));
    await waitFor(() => expect(net.find('DELETE', /retrieval-settings$/)).toHaveLength(1));
    await waitFor(() => expect(screen.getByLabelText('Passages per search')).toHaveValue(6));
  });
});
