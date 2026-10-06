import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ConnectPage from './ConnectPage';
import { buildSnippets, testMcpConnection } from './snippets';
import { json, mockFetch } from '../../test/fetch';

describe('buildSnippets', () => {
  const s = buildSnippets('https://rag.acme.internal', 'rf_abc123');

  it('builds the exact Claude Code command', () => {
    expect(s.claudeCode).toBe('claude mcp add --transport http ragforge https://rag.acme.internal/mcp --header "Authorization: Bearer rf_abc123"');
  });

  it('builds a Claude Desktop config that bridges to the HTTP endpoint', () => {
    const cfg = JSON.parse(s.claudeDesktop);
    expect(cfg.mcpServers.ragforge).toEqual({
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://rag.acme.internal/mcp', '--header', 'Authorization: Bearer rf_abc123'],
    });
  });

  it('builds a Cursor config with the URL and bearer header', () => {
    expect(JSON.parse(s.cursor)).toEqual({
      mcpServers: { ragforge: { url: 'https://rag.acme.internal/mcp', headers: { Authorization: 'Bearer rf_abc123' } } },
    });
  });

  it('copes with a trailing slash on the origin', () => {
    expect(buildSnippets('http://localhost:8080/', 'k').claudeCode).toContain('http://localhost:8080/mcp');
  });
});

describe('testMcpConnection', () => {
  const ok = (names: string[]) => json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ knowledge_bases: names.map((n) => ({ name: n })) }) }] } });

  it('reports how many knowledge bases the key can see', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(['a', 'b']));
    const res = await testMcpConnection('http://x', 'rf_k', fetchImpl as never);
    expect(res).toEqual({ ok: true, knowledgeBases: 2 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://x/mcp');
    expect(init.headers.Authorization).toBe('Bearer rf_k');
    expect(JSON.parse(init.body)).toMatchObject({ method: 'tools/call', params: { name: 'list_knowledge_bases' } });
  });

  it('explains a rejected key', async () => {
    const res = await testMcpConnection('http://x', 'rf_bad', vi.fn().mockResolvedValue(json({ error: { message: 'Unauthorized' } }, 401)) as never);
    expect(res).toMatchObject({ ok: false, reason: 'rejected' });
    expect((res as { message: string }).message).toMatch(/rejected/i);
  });

  it('explains rate limiting and unreachable servers', async () => {
    expect(await testMcpConnection('http://x', 'k', vi.fn().mockResolvedValue(json({}, 429)) as never)).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(await testMcpConnection('http://x', 'k', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as never)).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('surfaces a tool error', async () => {
    const res = await testMcpConnection('http://x', 'k', vi.fn().mockResolvedValue(json({ result: { isError: true, content: [{ type: 'text', text: 'boom' }] } })) as never);
    expect(res).toMatchObject({ ok: false, reason: 'error', message: 'boom' });
  });
});

const KBS = [
  { id: 'kb1', name: 'Engineering handbook', documentCount: 3, chunkCount: 30 },
  { id: 'kb2', name: 'Support macros', documentCount: 1, chunkCount: 5 },
];
const KEYS = [
  { id: 'k1', name: 'Cursor on laptop', prefix: 'rf_k3Qx', scopeKbIds: ['kb1'], createdAt: '2026-10-01 09:00:00', lastUsedAt: new Date(Date.now() - 4 * 60_000).toISOString(), revokedAt: null },
  { id: 'k2', name: 'Claude Desktop', prefix: 'rf_9aT2', scopeKbIds: null, createdAt: '2026-10-01 09:00:00', lastUsedAt: null, revokedAt: null },
  { id: 'k3', name: 'Old CI key', prefix: 'rf_Zp0m', scopeKbIds: ['kb1', 'kb2'], createdAt: '2026-09-01 09:00:00', lastUsedAt: null, revokedAt: '2026-09-02T00:00:00.000Z' },
];

function renderPage(over: { keys?: unknown[] } = {}) {
  const net = mockFetch([
    { method: 'GET', path: '/api/api-keys', handler: () => over.keys ?? KEYS },
    { method: 'GET', path: '/api/knowledge-bases', handler: () => KBS },
    { method: 'POST', path: '/api/api-keys', handler: () => ({ id: 'k9', key: 'rf_FRESH_SECRET_KEY_123', prefix: 'rf_FRESH', name: 'Cursor', scopeKbIds: ['kb1'] }) },
    { method: 'DELETE', path: /\/api\/api-keys\/k\d$/, handler: () => undefined },
    { method: 'POST', path: '/mcp', handler: () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ knowledge_bases: [{}, {}] }) }] } }) },
  ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ConnectPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return net;
}

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

describe('ConnectPage', () => {
  it('shows the endpoint address and lets the user copy it', async () => {
    renderPage();
    expect(await screen.findByText(`${window.location.origin}/mcp`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/mcp`);
  });

  it('lists keys with readable access, last use and prefix, and never the secret', async () => {
    renderPage();
    const cursor = await screen.findByRole('row', { name: /Cursor on laptop/ });
    expect(within(cursor).getByText('Engineering handbook')).toBeInTheDocument();
    expect(within(cursor).getByText('rf_k3Qx…')).toBeInTheDocument();
    expect(within(cursor).getByText(/4 minutes ago/)).toBeInTheDocument();

    const desktop = screen.getByRole('row', { name: /Claude Desktop/ });
    expect(within(desktop).getByText('All knowledge bases')).toBeInTheDocument();
    expect(within(desktop).getByText('Never')).toBeInTheDocument();
  });

  it('marks revoked keys and offers no action on them', async () => {
    renderPage();
    const old = await screen.findByRole('row', { name: /Old CI key/ });
    expect(within(old).getByText('Revoked')).toBeInTheDocument();
    expect(within(old).getByText('Engineering handbook, Support macros')).toBeInTheDocument();
    expect(within(old).queryByRole('button', { name: /Revoke/ })).not.toBeInTheDocument();
  });

  it('invites the first key when there are none', async () => {
    renderPage({ keys: [] });
    expect(await screen.findByText('No API keys yet')).toBeInTheDocument();
  });

  it('creates a scoped key, shows the secret once with ready-to-paste setup, then hides it', async () => {
    const net = renderPage();
    await screen.findByRole('row', { name: /Cursor on laptop/ });
    await userEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create API key' });

    const create = within(dialog).getByRole('button', { name: 'Create key' });
    expect(create).toBeDisabled(); // a name is required
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Cursor');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Only selected knowledge bases' }));
    expect(create).toBeDisabled(); // at least one knowledge base must be chosen
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Engineering handbook' }));
    await userEvent.click(create);

    await waitFor(() => expect(within(dialog).getByDisplayValue('rf_FRESH_SECRET_KEY_123')).toBeInTheDocument());
    expect(net.find('POST', /api-keys$/)[0].body).toEqual({ name: 'Cursor', knowledgeBaseIds: ['kb1'] });
    expect(within(dialog).getByText(/won't be able to see this key again/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/claude mcp add --transport http ragforge/)).toHaveTextContent('Bearer rf_FRESH_SECRET_KEY_123');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Copy key' }));
    expect(writeText).toHaveBeenCalledWith('rf_FRESH_SECRET_KEY_123');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByDisplayValue('rf_FRESH_SECRET_KEY_123')).not.toBeInTheDocument());
    expect(screen.queryByText(/rf_FRESH_SECRET_KEY_123/)).not.toBeInTheDocument();
  });

  it('creates an all-knowledge-bases key by default', async () => {
    const net = renderPage();
    await screen.findByRole('row', { name: /Cursor on laptop/ });
    await userEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Everything');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));
    await waitFor(() => expect(net.find('POST', /api-keys$/)).toHaveLength(1));
    expect(net.find('POST', /api-keys$/)[0].body).toEqual({ name: 'Everything', knowledgeBaseIds: null });
  });

  it('tests a fresh key against the live endpoint', async () => {
    const net = renderPage();
    await screen.findByRole('row', { name: /Cursor on laptop/ });
    await userEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Cursor');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Test connection' }));
    expect(await within(dialog).findByText(/Connected\. This key can see 2 knowledge bases\./)).toBeInTheDocument();
    expect(net.find('POST', /^\/mcp$/)).toHaveLength(1);
  });

  it('revokes a key only after an in-app confirmation', async () => {
    const net = renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke Cursor on laptop' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke “Cursor on laptop”?' });
    expect(net.find('DELETE', /k1$/)).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke key' }));
    await waitFor(() => expect(net.find('DELETE', /k1$/)).toHaveLength(1));
  });

  it('shows setup instructions for each client with a placeholder key', async () => {
    renderPage();
    await screen.findByRole('row', { name: /Cursor on laptop/ });
    expect(screen.getByText(/claude mcp add --transport http ragforge/)).toHaveTextContent('<your-api-key>');
    await userEvent.click(screen.getByRole('tab', { name: 'Claude Desktop' }));
    expect(screen.getByText(/mcp-remote/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Cursor' }));
    expect(screen.getByText(/"headers"/)).toBeInTheDocument();
  });

  it('explains a failure to load keys and retries', async () => {
    let fail = true;
    mockFetch([
      { method: 'GET', path: '/api/api-keys', handler: () => (fail ? json({ error: 'Viewers cannot manage API keys' }, 403) : KEYS) },
      { method: 'GET', path: '/api/knowledge-bases', handler: () => KBS },
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><ConnectPage /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Viewers cannot manage API keys');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('row', { name: /Cursor on laptop/ })).toBeInTheDocument();
  });
});
