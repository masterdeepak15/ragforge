import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProvidersSection } from './ProvidersSection';
import { splitModels } from './models';
import { mockFetch } from '../../test/fetch';

const SPECS = {
  providers: [
    { type: 'ollama', label: 'Ollama (local)', description: 'Models on your own machine.', supportsLlm: true, supportsEmbeddings: true, needsApiKey: false, usesBaseUrl: true, defaultBaseUrl: 'http://localhost:11434', defaultLlmModel: 'llama3.1', defaultEmbeddingModel: 'nomic-embed-text' },
    { type: 'anthropic', label: 'Anthropic', description: 'Claude models.', supportsLlm: true, supportsEmbeddings: false, needsApiKey: true, usesBaseUrl: false, defaultLlmModel: 'claude-haiku-4-5-20251001' },
  ],
};

describe('splitModels', () => {
  it('separates embedding models from chat models', () => {
    expect(splitModels(['llama3.2:3b', 'nomic-embed-text:latest', 'text-embedding-3-small', 'gpt-4o-mini', 'whisper-1', 'tts-1'])).toEqual({
      chat: ['llama3.2:3b', 'gpt-4o-mini'],
      embedding: ['nomic-embed-text:latest', 'text-embedding-3-small'],
    });
  });
  it('falls back to everything when nothing looks like a chat model', () => {
    expect(splitModels(['nomic-embed-text']).chat).toEqual(['nomic-embed-text']);
  });
});

function setup(models: string[]) {
  const net = mockFetch([
    { method: 'GET', path: '/api/providers', handler: () => [] },
    { method: 'GET', path: '/api/providers/capabilities', handler: () => SPECS },
    { method: 'POST', path: '/api/providers/test', handler: () => ({ ok: true, models }) },
    { method: 'POST', path: '/api/providers', handler: () => ({ id: 'n', name: 'Ollama (local)', provider: 'ollama', isDefaultLlm: true, isDefaultEmbedding: true }) },
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

const openDialog = async () => {
  await userEvent.click((await screen.findAllByRole('button', { name: 'Add provider' }))[0]);
  return screen.findByRole('dialog', { name: 'Add AI provider' });
};

describe('Add provider dialog: model choice', () => {
  it('lets the user type a model until the connection has been tested, and says how to get a list', async () => {
    setup(['llama3.2:3b']);
    const dialog = await openDialog();
    expect(within(dialog).getByLabelText('Model for answers').tagName).toBe('INPUT');
    expect(within(dialog).getByText(/Test the connection to choose from the models this provider offers/)).toBeInTheDocument();
  });

  it('after a successful test, offers only real models in dropdowns split by purpose', async () => {
    setup(['llama3.2:3b', 'qwen2.5:7b', 'nomic-embed-text:latest']);
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Test connection' }));
    await within(dialog).findByText(/Connected\. Found 3 models\./);

    const answers = within(dialog).getByLabelText('Model for answers');
    const indexing = within(dialog).getByLabelText('Model for indexing (embeddings)');
    expect(answers.tagName).toBe('SELECT');
    expect(within(answers).getAllByRole('option').map((o) => o.textContent)).toEqual(['llama3.2:3b', 'qwen2.5:7b']);
    expect(within(indexing).getAllByRole('option').map((o) => o.textContent)).toEqual(['nomic-embed-text:latest']);
  });

  it('replaces a default that is not installed with one that is, so the saved model exists', async () => {
    const net = setup(['llama3.2:3b', 'nomic-embed-text:latest']); // the default "llama3.1" is not installed
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Test connection' }));
    await within(dialog).findByText(/Connected/);
    expect(within(dialog).getByLabelText('Model for answers')).toHaveValue('llama3.2:3b');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(net.find('POST', /\/api\/providers$/)).toHaveLength(1));
    expect(net.find('POST', /\/api\/providers$/)[0].body).toMatchObject({ defaultLlmModel: 'llama3.2:3b', defaultEmbeddingModel: 'nomic-embed-text:latest' });
  });

  it('saves the model the user picks', async () => {
    const net = setup(['llama3.2:3b', 'qwen2.5:7b', 'nomic-embed-text:latest']);
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Test connection' }));
    await within(dialog).findByText(/Connected/);
    await userEvent.selectOptions(within(dialog).getByLabelText('Model for answers'), 'qwen2.5:7b');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(net.find('POST', /\/api\/providers$/)).toHaveLength(1));
    expect(net.find('POST', /\/api\/providers$/)[0].body).toMatchObject({ defaultLlmModel: 'qwen2.5:7b' });
  });
});
