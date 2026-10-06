import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PlaygroundPage from './PlaygroundPage';
import { json, mockFetch, type Route } from '../test/fetch';

const SAVED = { topK: 9, useHybridSearch: true, vectorWeight: 0.8, bm25Weight: 0.2, minSimilarity: 0.45 };
const DEFAULTS = { topK: 6, useHybridSearch: true, vectorWeight: 0.7, bm25Weight: 0.3, minSimilarity: 0.3 };
const view = (settings = SAVED) => ({ settings, defaults: DEFAULTS, customized: true });

function setup(extra: Route[] = []) {
  const net = mockFetch([
    { method: 'GET', path: '/api/knowledge-bases', handler: () => [{ id: 'kb1', name: 'Handbook' }] },
    { method: 'GET', path: '/api/knowledge-bases/kb1/retrieval-settings', handler: () => view() },
    { method: 'POST', path: '/api/playground/retrieve', handler: () => ({ chunks: [] }) },
    ...extra,
  ]);
  render(<PlaygroundPage />);
  return net;
}

async function chooseKb() {
  await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Knowledge base' }), 'kb1');
  await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Top K' })).toHaveValue(9));
}

describe('PlaygroundPage: retrieval settings', () => {
  it('starts from the settings saved for the chosen knowledge base', async () => {
    setup();
    await chooseKb();
    await userEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    expect(screen.getByLabelText(/Minimum similarity/)).toHaveValue('0.45');
    expect(screen.getByLabelText(/Vector weight/)).toHaveValue('0.8');
  });

  it('searches with those settings', async () => {
    const net = setup();
    await chooseKb();
    await userEvent.type(screen.getByPlaceholderText(/Enter a search query/), 'whatware');
    await userEvent.click(screen.getByRole('button', { name: 'Run Retrieval' }));
    await waitFor(() => expect(net.find('POST', /playground\/retrieve$/)).toHaveLength(1));
    expect(net.find('POST', /playground\/retrieve$/)[0].body).toMatchObject({ knowledgeBaseId: 'kb1', query: 'whatware', topK: 9, minScore: 0.45, vectorWeight: 0.8, bm25Weight: 0.2, useHybridSearch: true });
  });

  it('cannot save defaults before a knowledge base is chosen', async () => {
    setup();
    expect(await screen.findByRole('button', { name: /Save as defaults/ })).toBeDisabled();
  });

  it('saves what was tuned as the defaults for that knowledge base', async () => {
    const net = setup([{ method: 'PUT', path: '/api/knowledge-bases/kb1/retrieval-settings', handler: () => view({ ...SAVED, topK: 4 }) }]);
    await chooseKb();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Top K' }), { target: { value: '4' } });
    await userEvent.click(screen.getByRole('button', { name: /Save as defaults/ }));
    await waitFor(() => expect(net.find('PUT', /retrieval-settings$/)).toHaveLength(1));
    expect(net.find('PUT', /retrieval-settings$/)[0].body).toEqual({ ...SAVED, topK: 4 });
    expect(await screen.findByRole('status')).toHaveTextContent(/Chat and connected AI tools now search this way/);
  });

  it('shows why saving failed', async () => {
    setup([{ method: 'PUT', path: '/api/knowledge-bases/kb1/retrieval-settings', handler: () => json({ error: 'topK must be a whole number from 1 to 50.' }, 400) }]);
    await chooseKb();
    await userEvent.click(screen.getByRole('button', { name: /Save as defaults/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('topK must be a whole number');
  });
});
