import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import KnowledgeBasesPage from './KnowledgeBasesPage';
import { json, mockFetch } from '../test/fetch';

const KBS = [
  { id: 'kb1', name: 'Engineering handbook', description: 'Runbooks and postmortems', documentCount: 1284, chunkCount: 96410, created_at: '2026-10-01 09:00:00' },
  { id: 'kb2', name: 'Support macros', description: null, documentCount: 0, chunkCount: 0, created_at: '2026-10-05 09:00:00' },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/knowledge-bases']}>
        <Routes>
          <Route path="/knowledge-bases" element={<KnowledgeBasesPage />} />
          <Route path="/knowledge-bases/:id" element={<div>Detail of the new knowledge base</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('KnowledgeBasesPage', () => {
  it('lists knowledge bases with formatted counts', async () => {
    mockFetch([{ method: 'GET', path: '/api/knowledge-bases', handler: () => KBS }]);
    renderPage();
    const row = await screen.findByRole('row', { name: /Engineering handbook/ });
    expect(within(row).getByText('Runbooks and postmortems')).toBeInTheDocument();
    expect(within(row).getByText('1,284')).toBeInTheDocument();
    expect(within(row).getByText('96,410')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Engineering handbook' })).toHaveAttribute('href', '/knowledge-bases/kb1');
  });

  it('shows a skeleton while loading', () => {
    mockFetch([{ method: 'GET', path: '/api/knowledge-bases', handler: () => new Promise(() => {}) }]);
    renderPage();
    expect(screen.getByTestId('kb-loading')).toBeInTheDocument();
  });

  it('invites the user to create the first knowledge base', async () => {
    mockFetch([{ method: 'GET', path: '/api/knowledge-bases', handler: () => [] }]);
    renderPage();
    expect(await screen.findByText('No knowledge bases yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New knowledge base' }).length).toBeGreaterThan(0);
  });

  it('explains a load failure and retries', async () => {
    let fail = true;
    mockFetch([{ method: 'GET', path: '/api/knowledge-bases', handler: () => (fail ? json({ error: 'Database unavailable' }, 500) : KBS) }]);
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Engineering handbook' })).toBeInTheDocument();
  });

  it('creates a knowledge base and opens it', async () => {
    const net = mockFetch([
      { method: 'GET', path: '/api/knowledge-bases', handler: () => KBS },
      { method: 'POST', path: '/api/knowledge-bases', handler: () => ({ id: 'kb3', name: 'Contracts' }) },
    ]);
    renderPage();
    await screen.findByRole('link', { name: 'Support macros' });
    await userEvent.click(screen.getAllByRole('button', { name: 'New knowledge base' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'New knowledge base' });
    const create = within(dialog).getByRole('button', { name: 'Create knowledge base' });
    expect(create).toBeDisabled(); // a name is required
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Contracts');
    await userEvent.type(within(dialog).getByLabelText('Description'), 'Signed agreements');
    await userEvent.click(create);
    expect(await screen.findByText('Detail of the new knowledge base')).toBeInTheDocument();
    expect(net.find('POST', /knowledge-bases$/)[0].body).toEqual({ name: 'Contracts', description: 'Signed agreements' });
  });

  it('shows the server error inside the dialog when creation fails', async () => {
    mockFetch([
      { method: 'GET', path: '/api/knowledge-bases', handler: () => KBS },
      { method: 'POST', path: '/api/knowledge-bases', handler: () => json({ error: 'A knowledge base with that name already exists' }, 409) },
    ]);
    renderPage();
    await screen.findByRole('link', { name: 'Support macros' });
    await userEvent.click(screen.getAllByRole('button', { name: 'New knowledge base' })[0]);
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Support macros');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create knowledge base' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already exists');
  });

  it('deletes a knowledge base only after an in-app confirmation', async () => {
    const net = mockFetch([
      { method: 'GET', path: '/api/knowledge-bases', handler: () => KBS },
      { method: 'DELETE', path: '/api/knowledge-bases/kb2', handler: () => undefined },
    ]);
    renderPage();
    await screen.findByRole('link', { name: 'Support macros' });
    await userEvent.click(screen.getByRole('button', { name: 'Delete Support macros' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete “Support macros”?' });
    expect(net.find('DELETE', /kb2/)).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete knowledge base' }));
    await waitFor(() => expect(net.find('DELETE', /kb2/)).toHaveLength(1));
  });
});
