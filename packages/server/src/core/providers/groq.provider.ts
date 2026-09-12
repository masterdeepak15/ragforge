import Groq from 'groq-sdk';
import type { ILLMProvider, IOAuthProvider, ProviderConfig, OAuthCredentials } from './provider.interface.js';
import type { LLMStreamOptions, AIProviderModel } from '@ragforge/shared';
import { generateCodeChallenge } from './crypto.js';

// Groq has a developer OAuth2 flow via their console
export class GroqProvider implements ILLMProvider, IOAuthProvider {
  private client: Groq;
  private static readonly OAUTH_CLIENT_ID = process.env.GROQ_OAUTH_CLIENT_ID || '';
  private static readonly OAUTH_CLIENT_SECRET = process.env.GROQ_OAUTH_CLIENT_SECRET || '';

  constructor(config: ProviderConfig) {
    const apiKey = config.apiKey || config.oauthCredentials?.accessToken || '';
    this.client = new Groq({ apiKey });
  }

  getAuthUrl(codeVerifier: string, redirectUri: string, state: string): string {
    const challenge = generateCodeChallenge(codeVerifier);
    const params = new URLSearchParams({
      client_id: GroqProvider.OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'read write',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    return `https://console.groq.com/oauth/authorize?${params}`;
  }

  async exchangeCodeForToken(code: string, codeVerifier: string, redirectUri: string): Promise<OAuthCredentials> {
    const res = await fetch('https://console.groq.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: GroqProvider.OAUTH_CLIENT_ID,
        client_secret: GroqProvider.OAUTH_CLIENT_SECRET,
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw new Error(`Groq token exchange failed: ${await res.text()}`);
    const data = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthCredentials> {
    const res = await fetch('https://console.groq.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: GroqProvider.OAUTH_CLIENT_ID,
        client_secret: GroqProvider.OAUTH_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`Groq token refresh failed: ${await res.text()}`);
    const data = await res.json() as { access_token: string; expires_in?: number };
    return {
      accessToken: data.access_token,
      refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    };
  }

  async *streamChat(options: LLMStreamOptions): AsyncGenerator<string, void, unknown> {
    const stream = await this.client.chat.completions.create({
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) yield content;
    }
  }

  async listModels(): Promise<AIProviderModel[]> {
    try {
      const { data } = await this.client.models.list();
      return data.map(m => ({
        id: m.id,
        name: m.id,
        type: 'llm' as const,
        contextWindow: (m as any).context_window,
      }));
    } catch {
      return GROQ_STATIC_MODELS;
    }
  }
}

const GROQ_STATIC_MODELS: AIProviderModel[] = [
  { id: 'llama-3.3-70b-versatile', name: 'LLaMA 3.3 70B', type: 'llm', contextWindow: 128000 },
  { id: 'llama-3.1-8b-instant', name: 'LLaMA 3.1 8B Instant', type: 'llm', contextWindow: 128000 },
  { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', type: 'llm', contextWindow: 32768 },
  { id: 'gemma2-9b-it', name: 'Gemma 2 9B', type: 'llm', contextWindow: 8192 },
];
