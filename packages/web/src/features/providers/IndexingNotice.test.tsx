import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IndexingNotice } from './IndexingNotice';
import { indexingGap } from './indexing';
import { mockFetch } from '../../test/fetch';
import type { ProviderConfig, ProviderSpec } from './types';

const spec = (type: string, label: string, supportsEmbeddings: boolean) => ({ type, label, supportsEmbeddings, supportsLlm: true }) as ProviderSpec;
const SPECS = [spec('ollama', 'Ollama', true), spec('openai', 'OpenAI', true), spec('anthropic', 'Anthropic', false), spec('groq', 'Groq', false)];
const prov = (provider: string, over: Partial<ProviderConfig> = {}) => ({ id: provider, name: provider, provider, isDefaultLlm: false, isDefaultEmbedding: false, ...over }) as ProviderConfig;

describe('indexingGap', () => {
  it('is null when a provider is chosen for indexing', () => {
    expect(indexingGap([prov('ollama', { isDefaultEmbedding: true })], SPECS)).toBeNull();
  });
  it('asks for a provider when there is none', () => {
    expect(indexingGap([], SPECS)).toMatch(/add an AI provider/i);
  });
  it('explains that Claude cannot index and names what to add', () => {
    const msg = indexingGap([prov('anthropic', { isDefaultLlm: true })], SPECS)!;
    expect(msg).toMatch(/Anthropic cannot create embeddings/);
    expect(msg).toMatch(/Ollama, OpenAI or Google Gemini/);
  });
  it('names every provider that cannot index', () => {
    expect(indexingGap([prov('anthropic'), prov('groq')], SPECS)).toMatch(/Anthropic and Groq cannot create embeddings/);
  });
  it('points at the button when a capable provider is not selected', () => {
    expect(indexingGap([prov('openai')], SPECS)).toMatch(/Use .* for indexing/);
  });
});

function renderNotice(providers: ProviderConfig[]) {
  mockFetch([
    { method: 'GET', path: '/api/providers', handler: () => providers },
    { method: 'GET', path: '/api/providers/capabilities', handler: () => ({ providers: SPECS }) },
  ]);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <IndexingNotice />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('IndexingNotice', () => {
  it('tells the user why uploads cannot be indexed and links to Settings', async () => {
    renderNotice([prov('anthropic', { isDefaultLlm: true })]);
    expect(await screen.findByRole('status')).toHaveTextContent(/Anthropic cannot create embeddings/);
    expect(screen.getByRole('link', { name: 'Open settings' })).toHaveAttribute('href', '/settings');
  });

  it('renders nothing when indexing is set up', async () => {
    const { container } = renderNotice([prov('ollama', { isDefaultEmbedding: true })]);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
