import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Outlet } from 'react-router-dom';
import App from './App';
import { mockFetch, type Route } from './test/fetch';

vi.mock('./components/shell/AppShell', () => ({ default: () => <Outlet /> }));
vi.mock('./features/dashboard/DashboardPage', () => ({ default: () => <h1>Overview page</h1> }));

const ADMIN = { id: 'u1', email: 'admin@example.com', username: 'admin', role: 'admin', createdAt: '', updatedAt: '' };

function routes(initial: boolean, over: { initUser?: boolean } = {}): Route[] {
  let initialized = initial;
  return [
    { method: 'GET', path: '/api/setup/status', handler: () => ({ isInitialized: initialized, hasDefaultProvider: false, hasEmbeddingProvider: false, hasKnowledgeBase: false }) },
    {
      method: 'POST',
      path: '/api/setup/init',
      handler: () => {
        initialized = true;
        return { success: true, token: 'tok', userId: 'u1', ...(over.initUser === false ? {} : { user: ADMIN }) };
      },
    },
    { method: 'GET', path: '/api/auth/me', handler: () => ADMIN },
  ];
}

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

async function createAdmin() {
  const user = userEvent.setup();
  await user.type(await screen.findByPlaceholderText('admin'), 'admin');
  await user.type(screen.getByPlaceholderText('admin@example.com'), 'admin@example.com');
  await user.type(screen.getByPlaceholderText('Min 8 characters'), 'correct-horse');
  await user.click(screen.getByRole('button', { name: /continue/i }));
  return user;
}

beforeEach(() => {
  localStorage.clear();
});

describe('App routing around first-run setup', () => {
  it('sends a fresh install to setup, then into the app (not back to setup) once the admin skips the provider step', async () => {
    mockFetch(routes(false));
    renderApp('/');
    const user = await createAdmin();
    await user.click(await screen.findByRole('button', { name: 'Skip' }));
    expect(await screen.findByRole('heading', { name: 'Overview page' })).toBeInTheDocument();
    expect(screen.queryByText('Create Admin Account')).not.toBeInTheDocument();
  });

  it('lands in the app after connecting a provider in the wizard', async () => {
    const m = mockFetch([...routes(false), { method: 'POST', path: '/api/providers', handler: () => ({ id: 'p1' }) }]);
    renderApp('/');
    const user = await createAdmin();
    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('heading', { name: 'Overview page' })).toBeInTheDocument();
    expect(m.find('POST', /\/api\/providers$/)).toHaveLength(1);
  });

  it('still signs the admin in when the server reply carries no user object', async () => {
    mockFetch(routes(false, { initUser: false }));
    renderApp('/');
    const user = await createAdmin();
    await user.click(await screen.findByRole('button', { name: 'Skip' }));
    expect(await screen.findByRole('heading', { name: 'Overview page' })).toBeInTheDocument();
  });

  it('sends an already set-up install without a session to the login page', async () => {
    mockFetch(routes(true));
    renderApp('/');
    expect(await screen.findByText('Sign in to your knowledge base')).toBeInTheDocument();
    expect(screen.queryByText('Create Admin Account')).not.toBeInTheDocument();
  });

  it('sends /setup on an already set-up install to login, never back to the wizard', async () => {
    mockFetch(routes(true));
    renderApp('/setup');
    expect(await screen.findByText('Sign in to your knowledge base')).toBeInTheDocument();
  });

  it('opens the app for a signed-in user', async () => {
    localStorage.setItem('ragforge_token', 'tok');
    localStorage.setItem('ragforge_user', JSON.stringify(ADMIN));
    mockFetch(routes(true));
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Overview page' })).toBeInTheDocument();
  });
});
