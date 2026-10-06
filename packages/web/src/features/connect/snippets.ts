export interface Snippets {
  claudeCode: string;
  claudeDesktop: string;
  cursor: string;
}

export const KEY_PLACEHOLDER = '<your-api-key>';

const mcpUrl = (origin: string) => `${origin.replace(/\/+$/, '')}/mcp`;

/** Ready-to-paste client configuration for the RAGForge MCP endpoint. */
export function buildSnippets(origin: string, key: string): Snippets {
  const url = mcpUrl(origin);
  const header = `Authorization: Bearer ${key}`;
  return {
    claudeCode: `claude mcp add --transport http ragforge ${url} --header "${header}"`,
    // Claude Desktop launches local commands, so mcp-remote bridges to the HTTP endpoint.
    claudeDesktop: JSON.stringify({ mcpServers: { ragforge: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', header] } } }, null, 2),
    cursor: JSON.stringify({ mcpServers: { ragforge: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
  };
}

export type ConnectionResult =
  | { ok: true; knowledgeBases: number }
  | { ok: false; reason: 'rejected' | 'rate_limited' | 'unreachable' | 'error'; message: string };

/** Calls the live endpoint the way an AI client would, so the user can confirm a key works. */
export async function testMcpConnection(origin: string, key: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<ConnectionResult> {
  let res: Response;
  try {
    res = await fetchImpl(mcpUrl(origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_knowledge_bases', arguments: {} } }),
    });
  } catch {
    return { ok: false, reason: 'unreachable', message: 'Could not reach the server. Check the address and your connection.' };
  }

  if (res.status === 401) return { ok: false, reason: 'rejected', message: 'That key was rejected. Check that it is copied in full and has not been revoked.' };
  if (res.status === 429) return { ok: false, reason: 'rate_limited', message: 'Too many requests with this key. Wait a moment and try again.' };
  if (!res.ok) return { ok: false, reason: 'error', message: `The server answered with an error (HTTP ${res.status}).` };

  try {
    const body = await res.json();
    const text: string = body?.result?.content?.[0]?.text ?? '';
    if (body?.result?.isError) return { ok: false, reason: 'error', message: text || 'The tool reported an error.' };
    const parsed = JSON.parse(text) as { knowledge_bases?: unknown[] };
    return { ok: true, knowledgeBases: parsed.knowledge_bases?.length ?? 0 };
  } catch {
    return { ok: false, reason: 'error', message: 'The server answered, but not with a valid MCP response.' };
  }
}
