import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChatPage from './ChatPage';
import { mockFetch } from '../test/fetch';

const SESSION = { id: 's1', title: 'New Chat', knowledge_base_id: null, created_at: '2026-10-07 10:00:00' };

function sse(...events: unknown[]) {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function renderChat(streamResponse: () => Response) {
  mockFetch([
    { method: 'GET', path: '/api/chat/sessions', handler: () => [SESSION] },
    { method: 'GET', path: '/api/knowledge-bases', handler: () => [] },
    { method: 'GET', path: '/api/chat/sessions/s1', handler: () => SESSION },
    { method: 'GET', path: '/api/chat/sessions/s1/messages', handler: () => [] },
    { method: 'POST', path: '/api/chat/sessions/s1/stream', handler: streamResponse },
  ]);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/chat/s1']}>
        <Routes>
          <Route path="/chat/:id" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function ask(text: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByRole('textbox', { name: 'Your question' }), `${text}{Enter}`);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ChatPage', () => {
  it('shows the answer as it streams in', async () => {
    renderChat(() => sse({ type: 'token', token: 'Seven ' }, { type: 'token', token: 'years.' }, { type: 'done', messageId: 'm1', latencyMs: 5 }));
    await ask('How long?');
    expect(await screen.findByText('Seven years.')).toBeInTheDocument();
  });

  it('shows why there is no answer when the provider fails, instead of staying silent', async () => {
    renderChat(() => sse({ type: 'error', error: 'Your credit balance is too low to access the Anthropic API.' }));
    await ask('How long?');
    expect(await screen.findByText(/credit balance is too low/i)).toBeInTheDocument();
  });

  describe('while waiting for the answer', () => {
    /** A stream the test releases by hand, so the waiting state can be observed. */
    function heldStream() {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
      const enc = new TextEncoder();
      return {
        response: () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        send: (e: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}

`)),
        end: () => controller.close(),
      };
    }

    it('shows a thinking indicator until the first words arrive, and blocks a second send', async () => {
      const held = heldStream();
      renderChat(held.response);
      await ask('How long?');

      const status = await screen.findByRole('status', { name: /answer in progress/i });
      expect(status).toHaveTextContent(/thinking/i);
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

      held.send({ type: 'token', token: 'Seven years.' });
      expect(await screen.findByText('Seven years.')).toBeInTheDocument();
      expect(screen.queryByRole('status', { name: /answer in progress/i })).not.toBeInTheDocument();

      held.send({ type: 'done', messageId: 'm1', latencyMs: 5 });
      held.end();
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your question' })).toBeEnabled());
    });

    it('says the answer is being written once sources are found', async () => {
      const held = heldStream();
      renderChat(held.response);
      await ask('How long?');
      await screen.findByRole('status', { name: /answer in progress/i });
      held.send({ type: 'citation', citation: { id: 'c', chunkId: 'k', documentId: 'd', documentTitle: 'Resume.pdf', citationIndex: 1, snippet: 'x', similarityScore: 0.5 } });
      expect(await screen.findByText(/writing the answer/i)).toBeInTheDocument();
      held.end();
    });

    it('removes the indicator when the provider fails', async () => {
      renderChat(() => sse({ type: 'error', error: 'Provider is down.' }));
      await ask('How long?');
      expect(await screen.findByText(/Provider is down/)).toBeInTheDocument();
      expect(screen.queryByRole('status', { name: /answer in progress/i })).not.toBeInTheDocument();
    });
  });
});
