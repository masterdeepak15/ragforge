import type { FastifyInstance } from 'fastify';
import { ProviderFactory } from '../core/providers/factory.js';
import { generateCodeVerifier, generateState } from '../core/providers/crypto.js';
import type { AIProviderType } from '@ragforge/shared';

// In-memory PKCE state store (keyed by state token, TTL 10 min)
const pendingOAuth = new Map<string, { verifier: string; provider: AIProviderType; expiresAt: number }>();

function cleanExpiredState() {
  const now = Date.now();
  for (const [k, v] of pendingOAuth) {
    if (v.expiresAt < now) pendingOAuth.delete(k);
  }
}

export async function oauthRoutes(app: FastifyInstance) {
  /**
   * GET /api/providers/oauth/start/:provider
   * Returns the authorization URL and starts the PKCE flow.
   * The frontend opens this URL in a popup or redirect.
   */
  app.get<{ Params: { provider: string } }>(
    '/api/providers/oauth/start/:provider',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const providerType = req.params.provider as AIProviderType;
      const instance = ProviderFactory.oauthInstance(providerType);
      if (!instance) {
        return reply.status(400).send({
          error: `Provider "${providerType}" does not support OAuth. Use API key instead.`,
        });
      }

      cleanExpiredState();
      const verifier = generateCodeVerifier();
      const state = generateState();
      const redirectUri = `${process.env.PUBLIC_URL || 'http://localhost:8080'}/api/providers/oauth/callback`;

      pendingOAuth.set(state, {
        verifier,
        provider: providerType,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      const authUrl = instance.getAuthUrl(verifier, redirectUri, state);
      return reply.send({ authUrl, state });
    }
  );

  /**
   * GET /api/providers/oauth/callback
   * Handles the redirect from the OAuth provider, exchanges code for tokens,
   * and redirects the popup window back to the settings page.
   */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/providers/oauth/callback',
    async (req, reply) => {
      const { code, state, error } = req.query;
      const frontendBase = process.env.PUBLIC_URL || 'http://localhost:8080';

      if (error || !code || !state) {
        const msg = encodeURIComponent(error || 'OAuth flow cancelled');
        return reply.redirect(`${frontendBase}/settings?oauth_error=${msg}`);
      }

      cleanExpiredState();
      const pending = pendingOAuth.get(state);
      if (!pending || pending.expiresAt < Date.now()) {
        return reply.redirect(`${frontendBase}/settings?oauth_error=invalid_or_expired_state`);
      }
      pendingOAuth.delete(state);

      try {
        const instance = ProviderFactory.oauthInstance(pending.provider);
        if (!instance) throw new Error('Provider not found');

        const redirectUri = `${frontendBase}/api/providers/oauth/callback`;
        const creds = await instance.exchangeCodeForToken(code, pending.verifier, redirectUri);
        const encrypted = ProviderFactory.encryptOAuthCredentials(creds);

        // Encode encrypted token into a URL fragment — the frontend reads it and
        // POSTs /api/providers to save the provider config (never sent to server logs).
        const tokenParam = encodeURIComponent(encrypted);
        const providerParam = encodeURIComponent(pending.provider);
        return reply.redirect(
          `${frontendBase}/settings?oauth_success=1&provider=${providerParam}&token=${tokenParam}`
        );
      } catch (err: any) {
        const msg = encodeURIComponent(err?.message || 'Token exchange failed');
        return reply.redirect(`${frontendBase}/settings?oauth_error=${msg}`);
      }
    }
  );

  /**
   * POST /api/providers/oauth/refresh
   * Refresh an existing OAuth token for a provider.
   */
  app.post<{ Body: { providerId: string } }>(
    '/api/providers/oauth/refresh',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { providerId } = req.body as { providerId: string };
      const db: any = req.server.db.client;

      const rs = await db.execute({
        sql: `SELECT * FROM ai_providers WHERE id = ? LIMIT 1`,
        args: [providerId],
      });
      const provider = rs.rows[0];

      if (!provider?.api_key_encrypted) {
        return reply.status(404).send({ error: 'Provider not found or no credentials stored' });
      }

      try {
        const creds = ProviderFactory.decryptOAuthCredentials(provider.api_key_encrypted as string);
        if (!creds.refreshToken) {
          return reply.status(400).send({ error: 'No refresh token — please re-authenticate' });
        }

        const instance = ProviderFactory.oauthInstance(provider.provider as AIProviderType);
        if (!instance) return reply.status(400).send({ error: 'Provider does not support OAuth' });

        const newCreds = await instance.refreshAccessToken(creds.refreshToken);
        const encrypted = ProviderFactory.encryptOAuthCredentials(newCreds);

        await db.execute({
          sql: `UPDATE ai_providers SET api_key_encrypted = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          args: [encrypted, providerId],
        });

        return reply.send({ success: true, expiresAt: newCreds.expiresAt });
      } catch (err: any) {
        return reply.status(500).send({ error: err?.message || 'Token refresh failed' });
      }
    }
  );
}
