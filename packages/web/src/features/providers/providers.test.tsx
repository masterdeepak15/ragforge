import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProvidersSection } from './ProvidersSection';
import { json, mockFetch, type Route } from '../../test/fetch';

const SPECS = {
  providers: [
    { type: 'ollama', label: 'Ollama (local)', description: 'Models on your own machine.', supportsLlm: true, supportsEmbeddings: true, needsApiKey: false, usesBaseUrl: true, defaultBaseUrl: 'http://localhost:11434', defaultLlmModel: 'llama3.1', defaultEmbeddingModel: 'nomic-embed-text', oauthConfigured: false },
    { type: 'openai', label: 'OpenAI', description: 'GPT models.', supportsLlm: true, supportsEmbeddings: true, needsApiKey: true, usesBaseUrl: false, defaultLlmModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small', keyHelpUrl: 'https://platform.openai.com/api-keys', oauthConfigured: false },
    { type: 'anthropic', label: 'Anthropic', description: 'Claude models. No embeddings.', supportsLlm: true, supportsEmbeddings: false, needsApiKey: true, usesBaseUrl: false, defaultLlmModel: 'claude-haiku-4-5-20251001', keyHelpUrl: 'https://console.anthropic.com/settings/keys', oauthConfigured: false },
  ],
};

const provider = (over: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'Ollama (local)', provider: 'ollama', baseUrl: 'http://localhost:11434', hasApiKey: false, apiKeyMasked: null,
  isDefaultLlm: true, isDefaultEmbedding: true, defaultLlmModel: 'llama3.1', defaultEmbeddingModel: 'nomic-embed-text', createdAt: '', updatedAt: '', ...over,
});

function renderSection(providers: unknown[], extra: Route[] = []) {
  const net = mockFetch([
    { method: 'GET', path: '/api/providers', handler: () => providers },
    { method: 'GET', path: '/api/providers/capabilities', handler: () => SPECS },
    ...extra,
  ]);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ProvidersSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return net;
}

describe('ProvidersSection: overview', () => {
  it('tells a new user that nothing can be indexed yet and offers the first step', async () => {
    renderSection([]);
    expect(await screen.findByText('No AI provider yet')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/cannot be indexed/i);
    expect(screen.getAllByRole('button', { name: 'Add provider' }).length).toBeGreaterThan(0);
  });

  it('shows which provider answers questions and which one indexes documents', async () => {
    renderSection([provider(), provider({ id: 'p2', name: 'Claude', provider: 'anthropic', isDefaultLlm: false, isDefaultEmbedding: false, defaultLlmModel: 'claude-haiku-4-5-20251001', defaultEmbeddingModel: null })]);
    const answers = await screen.findByText('Used for answers');
    expect(answers.closest('div')).toHaveTextContent('Ollama (local) · llama3.1');
    expect(screen.getByText('Used for indexing').closest('div')).toHaveTextContent('Ollama (local) · nomic-embed-text');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('warns when no provider can index documents', async () => {
    renderSection([provider({ id: 'p2', name: 'Claude', provider: 'anthropic', isDefaultEmbedding: false, defaultEmbeddingModel: null })]);
    expect(await screen.findByRole('status')).toHaveTextContent(/cannot be indexed/i);
    expect(screen.getByRole('status')).toHaveTextContent(/Anthropic cannot create embeddings|another provider/i);
  });

  it('explains a load failure and retries', async () => {
    let fail = true;
    mockFetch([
      { method: 'GET', path: '/api/providers', handler: () => (fail ? json({ error: 'Database unavailable' }, 500) : [provider()]) },
      { method: 'GET', path: '/api/providers/capabilities', handler: () => SPECS },
    ]);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><ProvidersSection /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Ollama (local)')).toBeInTheDocument();
  });
});

describe('ProvidersSection: managing providers', () => {
  const two = () => [provider(), provider({ id: 'p2', name: 'Work OpenAI', provider: 'openai', baseUrl: null, hasApiKey: true, isDefaultLlm: false, isDefaultEmbedding: false, defaultLlmModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' })];

  it('marks the roles each provider holds and only offers roles it can fulfil', async () => {
    renderSection([...two(), provider({ id: 'p3', name: 'Claude', provider: 'anthropic', isDefaultLlm: false, isDefaultEmbedding: false, defaultEmbeddingModel: null })]);
    const row = await screen.findByRole('row', { name: /Ollama \(local\)/ });
    expect(within(row).getByText('Answers')).toBeInTheDocument();
    expect(within(row).getByText('Indexing')).toBeInTheDocument();
    const claude = screen.getByRole('row', { name: /Claude/ });
    expect(within(claude).getByRole('button', { name: 'Use Claude for answers' })).toBeInTheDocument();
    expect(within(claude).queryByRole('button', { name: /for indexing/ })).not.toBeInTheDocument();
  });

  it('switches the provider used for indexing', async () => {
    const net = renderSection(two(), [{ method: 'PATCH', path: '/api/providers/p2', handler: () => provider({ id: 'p2', isDefaultEmbedding: true }) }]);
    await userEvent.click(await screen.findByRole('button', { name: 'Use Work OpenAI for indexing' }));
    await waitFor(() => expect(net.find('PATCH', /p2$/)).toHaveLength(1));
    expect(net.find('PATCH', /p2$/)[0].body).toEqual({ isDefaultEmbedding: true });
  });

  it('shows the result of testing a saved provider right in its row', async () => {
    renderSection(two(), [{ method: 'POST', path: '/api/providers/p2/test', handler: () => ({ ok: false, message: 'The API key was rejected by OpenAI. Check that it is copied in full and has access.' }) }]);
    await userEvent.click(await screen.findByRole('button', { name: 'Test Work OpenAI' }));
    const row = screen.getByRole('row', { name: /Work OpenAI/ });
    expect(await within(row).findByRole('status')).toHaveTextContent('The API key was rejected by OpenAI');
  });

  it('removes a provider only after an in-app confirmation', async () => {
    const net = renderSection(two(), [{ method: 'DELETE', path: '/api/providers/p2', handler: () => undefined }]);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Work OpenAI' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove “Work OpenAI”?' });
    expect(net.find('DELETE', /p2$/)).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove provider' }));
    await waitFor(() => expect(net.find('DELETE', /p2$/)).toHaveLength(1));
  });
});

describe('Add provider dialog', () => {
  const open = async () => {
    await userEvent.click((await screen.findAllByRole('button', { name: 'Add provider' }))[0]);
    return screen.findByRole('dialog', { name: 'Add AI provider' });
  };

  it('sends the field names the API expects ("provider", not "type") with models and key', async () => {
    const net = renderSection([], [{ method: 'POST', path: '/api/providers', handler: () => provider({ id: 'new', name: 'OpenAI', provider: 'openai' }) }]);
    const dialog = await open();
    await userEvent.selectOptions(within(dialog).getByLabelText('Provider'), 'openai');
    const add = within(dialog).getByRole('button', { name: 'Add provider' });
    expect(add).toBeDisabled(); // an API key is required
    await userEvent.type(within(dialog).getByLabelText('API key'), 'sk-test-123');
    expect(add).toBeEnabled();
    await userEvent.click(add);
    await waitFor(() => expect(net.find('POST', /\/api\/providers$/)).toHaveLength(1));
    const body = net.find('POST', /\/api\/providers$/)[0].body;
    expect(body).toEqual({ provider: 'openai', apiKey: 'sk-test-123', defaultLlmModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' });
    expect(body).not.toHaveProperty('type');
  });

  it('prefills the address for Ollama and asks for no key', async () => {
    const net = renderSection([], [{ method: 'POST', path: '/api/providers', handler: () => provider() }]);
    const dialog = await open();
    expect(within(dialog).getByLabelText('Provider')).toHaveValue('ollama');
    expect(within(dialog).getByLabelText('Server address')).toHaveValue('http://localhost:11434');
    expect(within(dialog).queryByLabelText('API key')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(net.find('POST', /\/api\/providers$/)).toHaveLength(1));
    expect(net.find('POST', /\/api\/providers$/)[0].body).toMatchObject({ provider: 'ollama', baseUrl: 'http://localhost:11434', defaultLlmModel: 'llama3.1', defaultEmbeddingModel: 'nomic-embed-text' });
  });

  it('does not offer an indexing model for providers without embeddings', async () => {
    renderSection([]);
    const dialog = await open();
    await userEvent.selectOptions(within(dialog).getByLabelText('Provider'), 'anthropic');
    expect(within(dialog).getByLabelText('Model for answers')).toHaveValue('claude-haiku-4-5-20251001');
    expect(within(dialog).queryByLabelText('Model for indexing (embeddings)')).not.toBeInTheDocument();
    expect(within(dialog).getByText(/no embeddings API/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Get an API key' })).toHaveAttribute('href', 'https://console.anthropic.com/settings/keys');
  });

  it('tests the connection before saving and reports what it found', async () => {
    const net = renderSection([], [{ method: 'POST', path: '/api/providers/test', handler: () => ({ ok: true, models: ['llama3.1', 'nomic-embed-text'] }) }]);
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Test connection' }));
    expect(await within(dialog).findByText(/Connected\. Found 2 models\./)).toBeInTheDocument();
    expect(net.find('POST', /providers\/test$/)[0].body).toEqual({ provider: 'ollama', baseUrl: 'http://localhost:11434' });
  });

  it('shows why a test failed but still lets the user add the provider', async () => {
    renderSection([], [{ method: 'POST', path: '/api/providers/test', handler: () => ({ ok: false, message: 'Could not reach localhost:11434. Check the address and that the server is running.' }) }]);
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Test connection' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not reach localhost:11434');
    expect(within(dialog).getByRole('button', { name: 'Add provider' })).toBeEnabled();
  });

  it('shows the server\'s reason inside the dialog when saving fails', async () => {
    renderSection([], [{ method: 'POST', path: '/api/providers', handler: () => json({ error: 'The address must start with http:// or https://.' }, 400) }]);
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('must start with http');
    expect(screen.getByRole('dialog', { name: 'Add AI provider' })).toBeInTheDocument();
  });

  it('closes and refreshes the list after a successful add', async () => {
    let providers: unknown[] = [];
    mockFetch([
      { method: 'GET', path: '/api/providers', handler: () => providers },
      { method: 'GET', path: '/api/providers/capabilities', handler: () => SPECS },
      { method: 'POST', path: '/api/providers', handler: () => { providers = [provider()]; return provider(); } },
    ]);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><ProvidersSection /></MemoryRouter></QueryClientProvider>);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Add provider' }))[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Add AI provider' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    expect(await screen.findByRole('row', { name: /Ollama \(local\)/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Add AI provider' })).not.toBeInTheDocument();
  });
});
