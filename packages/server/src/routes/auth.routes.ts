import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';

export async function authRoutes(app: FastifyInstance) {
  /** POST /api/auth/login */
  app.post<{ Body: { email: string; password: string } }>(
    '/api/auth/login',
    async (req, reply) => {
      const { email, password } = req.body;
      if (!email || !password) {
        return reply.status(400).send({ error: 'email and password required' });
      }

      const db = app.db.client;
      const rs = await db.execute({
        sql: `SELECT * FROM users WHERE email = ? LIMIT 1`,
        args: [email],
      });

      const user = rs.rows[0];
      if (!user) return reply.status(401).send({ error: 'Invalid credentials' });

      const valid = await bcrypt.compare(password, user.password_hash as string);
      if (!valid) return reply.status(401).send({ error: 'Invalid credentials' });

      const token = app.jwt.sign(
        { sub: user.id, role: user.role },
        { expiresIn: '7d' }
      );

      return reply.send({
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          role: user.role,
          avatarUrl: user.avatar_url ?? null,
          createdAt: user.created_at,
          updatedAt: user.updated_at,
        },
      });
    }
  );

  /** GET /api/auth/me — returns current user from JWT */
  app.get(
    '/api/auth/me',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const db = app.db.client;
      const rs = await db.execute({
        sql: `SELECT * FROM users WHERE id = ? LIMIT 1`,
        args: [(req.user as any).sub],
      });
      const user = rs.rows[0];
      if (!user) return reply.status(404).send({ error: 'User not found' });

      return reply.send({
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        avatarUrl: user.avatar_url ?? null,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      });
    }
  );

  /** POST /api/auth/logout — stateless JWT: client just drops the token */
  app.post('/api/auth/logout', { onRequest: [app.authenticate] }, async (_req, reply) => {
    return reply.send({ success: true });
  });
}
