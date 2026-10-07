import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChatPage from './ChatPage';
import { mockFetch, type Route as FetchRoute } from '../test/fetch';

const SESSION = { id: 's1', title: 'New Chat', knowledge_base_id: null, created_at: '2026-10-07 10:00:00' };

function sse(...events: unknown[]) {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function renderChat(streamResponse: () => Response) {
  return renderChatWithNet(streamResponse);
}

function renderChatWithNet(streamResponse: () => Response, opts: { session?: Record<string, unknown>; kbs?: unknown[]; extra?: FetchRoute[] } = {}) {
  const session = opts.session ?? SESSION;
  const net = mockFetch([
    ...(opts.extra ?? []),
    { method: 'GET', path: '/api/chat/sessions', handler: () => [session] },
    { method: 'GET', path: '/api/knowledge-bases', handler: () => opts.kbs ?? [] },
    { method: 'GET', path: '/api/knowledge-bases/kb1/documents', handler: () => ({ counts: { ready: 3, processing: 0, pending: 0 } }) },
    { method: 'GET', path: '/api/chat/sessions/s1', handler: () => session },
    { method: 'GET', path: '/api/chat/sessions/s1/messages', handler: () => [] },
    { method: 'POST', path: '/api/chat/sessions/s1/stream', handler: streamResponse },
  ]);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/chat/s1']}>
        <Routes>
          <Route path="/chat/:id" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return net;
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

  it('leaves how many passages to fetch to the knowledge base settings', async () => {
    const net = renderChatWithNet(() => sse({ type: 'done', messageId: 'm', latencyMs: 1 }));
    await ask('How long?');
    await waitFor(() => expect(net.find('POST', /stream$/)).toHaveLength(1));
    expect(net.find('POST', /stream$/)[0].body).toEqual({ message: 'How long?' });
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

describe('which knowledge base a chat uses', () => {
  const KB = { id: 'kb1', name: 'Handbook' };
  const withKb = { ...SESSION, knowledge_base_id: 'kb1' };
  const done = () => sse({ type: 'done', messageId: 'm', latencyMs: 1 });

  it('warns that a chat without a knowledge base answers from general knowledge only, and offers to choose one', async () => {
    renderChatWithNet(done, { kbs: [KB] });
    const notice = await screen.findByText(/not using a knowledge base/i);
    expect(notice).toHaveTextContent(/general knowledge/i);
    expect(screen.getByRole('combobox', { name: 'Knowledge base for this chat' })).toHaveValue('');
  });

  it('sends the user to create a knowledge base when there is none yet', async () => {
    renderChatWithNet(done, { kbs: [] });
    expect(await screen.findByRole('link', { name: 'Create a knowledge base' })).toHaveAttribute('href', '/knowledge-bases');
  });

  it('attaches the chosen knowledge base to this chat, and the warning goes away', async () => {
    const attached = { ...SESSION, knowledge_base_id: 'kb1' };
    const net = renderChatWithNet(done, { kbs: [KB], extra: [{ method: 'PATCH', path: '/api/chat/sessions/s1', handler: () => attached }] });
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Knowledge base for this chat' }), 'kb1');
    await waitFor(() => expect(net.find('PATCH', /sessions\/s1$/)).toHaveLength(1));
    expect(net.find('PATCH', /sessions\/s1$/)[0].body).toEqual({ knowledgeBaseId: 'kb1' });
    await waitFor(() => expect(screen.queryByText(/not using a knowledge base/i)).not.toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: 'Knowledge base for this chat' })).toHaveValue('kb1');
  });

  it('can go back to a general chat', async () => {
    const net = renderChatWithNet(done, { session: withKb, kbs: [KB], extra: [{ method: 'PATCH', path: '/api/chat/sessions/s1', handler: () => SESSION }] });
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Knowledge base for this chat' }), '');
    await waitFor(() => expect(net.find('PATCH', /sessions\/s1$/)[0]?.body).toEqual({ knowledgeBaseId: null }));
  });

  it('shows no warning for a chat that uses a knowledge base', async () => {
    renderChatWithNet(done, { session: withKb, kbs: [KB] });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Knowledge base for this chat' })).toHaveValue('kb1'));
    expect(screen.queryByText(/not using a knowledge base/i)).not.toBeInTheDocument();
  });

  it('explains when the choice could not be saved, and keeps the previous one', async () => {
    renderChatWithNet(done, { kbs: [KB], extra: [{ method: 'PATCH', path: '/api/chat/sessions/s1', handler: () => new Response(JSON.stringify({ error: 'Knowledge base not found' }), { status: 404, headers: { 'content-type': 'application/json' } }) }] });
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Knowledge base for this chat' }), 'kb1');
    expect(await screen.findByText(/Knowledge base not found/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Knowledge base for this chat' })).toHaveValue('');
  });

  it('preselects your knowledge base when you start a new chat, so it is not forgotten', async () => {
    renderChatWithNet(done, { kbs: [KB] });
    await userEvent.click((await screen.findAllByRole('button', { name: /New Chat/ }))[0]);
    expect(await screen.findByLabelText('Knowledge base')).toHaveValue('kb1');
  });
});
