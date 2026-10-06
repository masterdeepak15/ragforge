import type { FastifyInstance } from 'fastify';
import { APP_VERSION } from '../config/env.js';

export async function healthRoutes(app: FastifyInstance) {
  /** Liveness: the process is up. No dependencies, no auth. */
  app.get('/api/health', async () => ({ status: 'ok', version: APP_VERSION }));

  /** Readiness: dependencies work, so a load balancer / orchestrator can route traffic. */
  app.get('/api/ready', async (_req, reply) => {
    const checks: Record<string, string> = {};

    try {
      if (app.db.mode === 'postgres') await (app.db.client as any).unsafe('SELECT 1');
      else await app.db.client.execute('SELECT 1');
      checks.database = 'ok';
    } catch (err: any) {
      checks.database = `error: ${err?.message ?? err}`;
    }

    checks.worker = !app.workerEnabled ? 'disabled' : app.worker.isRunning ? 'ok' : 'error: ingestion worker is not running';

    const ready = Object.values(checks).every((v) => v === 'ok' || v === 'disabled');
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'unavailable', checks });
  });
}
