import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import type { SetupStatus } from '@ragforge/shared';

export async function setupRoutes(app: FastifyInstance) {
  /** GET /api/setup/status — check if system is initialized */
  app.get('/api/setup/status', async (_req, reply) => {
    const db: any = app.db.client;

    const userRow = await db.execute({ sql: `SELECT COUNT(*) as cnt FROM users WHERE role = 'admin'`, args: [] });
    const providerRow = await db.execute({ sql: `SELECT COUNT(*) as cnt FROM ai_providers WHERE is_default_llm = 1`, args: [] });
    const kbRow = await db.execute({ sql: `SELECT COUNT(*) as cnt FROM knowledge_bases`, args: [] });
    const settingRow = await db.execute({ sql: `SELECT value FROM app_settings WHERE key = 'initialized'`, args: [] });

    const hasAdmin = Number(userRow.rows[0]?.cnt ?? 0) > 0;
    const hasProvider = Number(providerRow.rows[0]?.cnt ?? 0) > 0;
    const hasKb = Number(kbRow.rows[0]?.cnt ?? 0) > 0;
    const initialized = settingRow.rows[0]?.value === 'true';

    const status: SetupStatus = {
      isInitialized: initialized,
      hasAdminUser: hasAdmin,
      hasDefaultProvider: hasProvider,
      hasKnowledgeBase: hasKb,
      version: '1.0.0',
      storageMode: app.db.mode,
    };
    return reply.send(status);
  });

  /** POST /api/setup/init — first-run wizard: create admin account */
  app.post<{
    Body: { username: string; email: string; password: string }
  }>('/api/setup/init', async (req, reply) => {
    const db = app.db.client;

    // Only allow if not yet initialized
    const existing = await db.execute({ sql: `SELECT COUNT(*) as cnt FROM users`, args: [] });
    if (Number(existing.rows[0]?.cnt) > 0) {
      return reply.status(409).send({ error: 'System already initialized' });
    }

    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return reply.status(400).send({ error: 'username, email, and password are required' });
    }
    if (password.length < 8) {
      return reply.status(400).send({ error: 'Password must be at least 8 characters' });
    }

    const id = randomUUID();
    const hash = await bcrypt.hash(password, 12);

    await db.execute({
      sql: `INSERT INTO users (id, email, username, password_hash, role) VALUES (?, ?, ?, ?, 'admin')`,
      args: [id, email, username, hash],
    });

    await db.execute({
      sql: `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('initialized', 'true')`,
      args: [],
    });

    const token = app.jwt.sign({ sub: id, role: 'admin' }, { expiresIn: '7d' });
    return reply.send({ success: true, token, userId: id });
  });
}
