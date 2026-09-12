import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { ChatService } from '../services/chat.service.js';

export async function chatRoutes(app: FastifyInstance) {
  const db = () => app.db.client;

  /** GET /api/chat/sessions */
  app.get('/api/chat/sessions', { onRequest: [app.authenticate] }, async (_req, reply) => {
    const rs = await db().execute({
      sql: `SELECT s.*, kb.name as knowledge_base_name
            FROM chat_sessions s
            LEFT JOIN knowledge_bases kb ON kb.id = s.knowledge_base_id
            ORDER BY s.updated_at DESC
            LIMIT 50`,
      args: [],
    });
    return reply.send(rs.rows);
  });

  /** POST /api/chat/sessions */
  app.post<{
    Body: { title?: string; knowledgeBaseId?: string; systemPrompt?: string }
  }>('/api/chat/sessions', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { title = 'New Chat', knowledgeBaseId, systemPrompt } = req.body;
    const id = randomUUID();

    await db().execute({
      sql: `INSERT INTO chat_sessions (id, title, knowledge_base_id, system_prompt) VALUES (?, ?, ?, ?)`,
      args: [id, title, knowledgeBaseId ?? null, systemPrompt ?? null],
    });

    const rs = await db().execute({ sql: `SELECT * FROM chat_sessions WHERE id = ?`, args: [id] });
    return reply.status(201).send(rs.rows[0]);
  });

  /** GET /api/chat/sessions/:id */
  app.get<{ Params: { id: string } }>('/api/chat/sessions/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const rs = await db().execute({
      sql: `SELECT s.*, kb.name as knowledge_base_name
            FROM chat_sessions s
            LEFT JOIN knowledge_bases kb ON kb.id = s.knowledge_base_id
            WHERE s.id = ?`,
      args: [req.params.id],
    });
    const session = rs.rows[0];
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    return reply.send(session);
  });

  /** GET /api/chat/sessions/:id/messages */
  app.get<{ Params: { id: string } }>('/api/chat/sessions/:id/messages', { onRequest: [app.authenticate] }, async (req, reply) => {
    const rs = await db().execute({
      sql: `SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC`,
      args: [req.params.id],
    });
    return reply.send(rs.rows.map((msg: any) => ({
      ...msg,
      citations: msg.citations_json ? JSON.parse(msg.citations_json as string) : undefined,
      tokenUsage: msg.token_usage_json ? JSON.parse(msg.token_usage_json as string) : undefined,
    })));
  });

  /** POST /api/chat/sessions/:id/stream */
  app.post<{
    Params: { id: string };
    Body: {
      message: string;
      providerId?: string;
      model?: string;
      temperature?: number;
      topK?: number;
      similarityThreshold?: number;
      useHybridSearch?: boolean;
    }
  }>('/api/chat/sessions/:id/stream', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id: sessionId } = req.params;
    const { message, providerId, model, temperature, topK, similarityThreshold, useHybridSearch } = req.body;

    // Get session info
    const sessionRs = await db().execute({
      sql: `SELECT * FROM chat_sessions WHERE id = ?`,
      args: [sessionId],
    });
    const session = sessionRs.rows[0];
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    // Get message history
    const historyRs = await db().execute({
      sql: `SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC`,
      args: [sessionId],
    });
    const history = historyRs.rows.map((m: any) => ({ role: m.role, content: m.content }));

    // Save user message
    const userMessageId = randomUUID();
    await db().execute({
      sql: `INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, 'user', ?)`,
      args: [userMessageId, sessionId, message],
    });

    // Setup SSE stream
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const writeSSE = (data: any) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const chatService = new ChatService({
        async getProvider(id?: string) {
          const rs = await db().execute({
            sql: id
              ? `SELECT * FROM ai_providers WHERE id = ?`
              : `SELECT * FROM ai_providers WHERE is_default_llm = 1 LIMIT 1`,
            args: id ? [id] : [],
          });
          return rs.rows[0] ?? null;
        },
        async saveMessage(params) {
          await db().execute({
            sql: `INSERT INTO chat_messages (id, session_id, role, content, citations_json, token_usage_json, latency_ms)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [params.id, params.sessionId, params.role, params.content, params.citationsJson ?? null, params.tokenUsageJson ?? null, params.latencyMs ?? null],
          });
        },
        retriever: app.retriever,
      });

      for await (const event of chatService.stream({
        sessionId,
        knowledgeBaseId: session.knowledge_base_id as string | undefined,
        userMessage: message,
        history,
        systemPrompt: session.system_prompt as string | undefined,
        providerId: providerId ?? session.provider_id as string | undefined,
        model: model ?? session.model_override as string | undefined,
        temperature,
        topK,
        similarityThreshold,
        useHybridSearch,
      })) {
        writeSSE(event);
        if (event.type === 'done' || event.type === 'error') break;
      }
    } catch (err: any) {
      writeSSE({ type: 'error', error: err?.message || 'Chat error' });
    }

    reply.raw.end();
  });

  /** DELETE /api/chat/sessions/:id */
  app.delete<{ Params: { id: string } }>('/api/chat/sessions/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    await db().execute({ sql: `DELETE FROM chat_sessions WHERE id = ?`, args: [req.params.id] });
    return reply.status(204).send();
  });
}