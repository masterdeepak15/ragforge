import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AppShell from './AppShell';
import { ThemeProvider } from '../../lib/theme';
import { AuthProvider } from '../../lib/auth';

const KBS = [
  { id: 'kb-1', name: 'Engineering handbook', description: null },
  { id: 'kb-2', name: 'Support macros', description: null },
];

function mockApi() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/api/knowledge-bases')) {
      return new Response(JSON.stringify(KBS), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

function renderShell(path = '/knowledge-bases') {
  localStorage.setItem('ragforge_token', 'tok');
  localStorage.setItem('ragforge_user', JSON.stringify({ id: 'u1', email: 'd@x.io', username: 'Deepak', role: 'admin', createdAt: '', updatedAt: '' }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="/" element={<div>Chat page</div>} />
                <Route path="/knowledge-bases" element={<div>Knowledge bases page</div>} />
                <Route path="/knowledge-bases/:id" element={<div>Knowledge base detail</div>} />
                <Route path="/settings" element={<div>Settings page</div>} />
                <Route path="/playground" element={<div>Playground page</div>} />
              </Route>
              <Route path="/login" element={<div>Login page</div>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(mockApi);

describe('AppShell', () => {
  it('renders the page inside the shell and marks the current section', async () => {
    renderShell('/knowledge-bases');
    expect(screen.getByText('Knowledge bases page')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: /Knowledge bases/ })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: /Settings/ })).not.toHaveAttribute('aria-current');
  });

  it('keeps the section highlighted on nested routes', () => {
    renderShell('/knowledge-bases/kb-1');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: /Knowledge bases/ })).toHaveAttribute('aria-current', 'page');
  });

  it('lists knowledge bases from the API as links', async () => {
    renderShell();
    const link = await screen.findByRole('link', { name: 'Engineering handbook' });
    expect(link).toHaveAttribute('href', '/knowledge-bases/kb-1');
    expect(screen.getByRole('link', { name: 'Support macros' })).toBeInTheDocument();
  });

  it('shows the signed-in user', () => {
    renderShell();
    expect(screen.getByText('Deepak')).toBeInTheDocument();
  });

  it('switches theme from the sidebar and remembers it', async () => {
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Dark theme' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('ragforge_theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark theme' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Light theme' }));
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('signs out and returns to the login page', async () => {
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(localStorage.getItem('ragforge_token')).toBeNull();
    await waitFor(() => expect(screen.queryByText('Knowledge bases page')).not.toBeInTheDocument());
  });
});

describe('command palette', () => {
  it('opens with Ctrl+K and navigates to a page', async () => {
    renderShell('/knowledge-bases');
    await userEvent.keyboard('{Control>}k{/Control}');
    const input = await screen.findByPlaceholderText(/search or jump to/i);
    await userEvent.type(input, 'settings');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('Settings page')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search or jump to/i)).not.toBeInTheDocument();
  });

  it('finds knowledge bases by name', async () => {
    renderShell('/settings');
    await screen.findByRole('link', { name: 'Support macros' }); // KB list is loaded
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.type(await screen.findByPlaceholderText(/search or jump to/i), 'support');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('Knowledge base detail')).toBeInTheDocument();
  });

  it('can change the theme', async () => {
    renderShell();
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.type(await screen.findByPlaceholderText(/search or jump to/i), 'dark');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'));
  });

  it('opens from the sidebar button too', async () => {
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: /search or jump to/i }));
    expect(await screen.findByPlaceholderText(/search or jump to/i)).toBeInTheDocument();
  });
});
