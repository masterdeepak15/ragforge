import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ILLMProvider, IEmbeddingProvider, IOAuthProvider, ProviderConfig, OAuthCredentials } from './provider.interface.js';
import type { LLMStreamOptions, EmbeddingOptions, EmbeddingResult, AIProviderModel } from '@ragforge/shared';
import { generateCodeChallenge } from './crypto.js';

// Google OAuth2 for Gemini API access (uses Google Identity Services)
export class GeminiProvider implements ILLMProvider, IEmbeddingProvider, IOAuthProvider {
  private genAI: GoogleGenerativeAI;
  private static readonly OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
  private static readonly SCOPES = 'https://www.googleapis.com/auth/generative-language';

  constructor(config: ProviderConfig) {
    const apiKey = config.apiKey || config.oauthCredentials?.accessToken || '';
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  getAuthUrl(codeVerifier: string, redirectUri: string, state: string): string {
    const challenge = generateCodeChallenge(codeVerifier);
    const params = new URLSearchParams({
      client_id: GeminiProvider.OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GeminiProvider.SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async exchangeCodeForToken(code: string, codeVerifier: string, redirectUri: string): Promise<OAuthCredentials> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GeminiProvider.OAUTH_CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw new Error(`Google token exchange failed: ${await res.text()}`);
    const data = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      tokenType: data.token_type,
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthCredentials> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GeminiProvider.OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`Google token refresh failed: ${await res.text()}`);
    const data = await res.json() as { access_token: string; expires_in?: number; token_type?: string };
    return {
      accessToken: data.access_token,
      refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      tokenType: data.token_type,
    };
  }

  async *streamChat(options: LLMStreamOptions): AsyncGenerator<string, void, unknown> {
    const model = this.genAI.getGenerativeModel({ model: options.model });
    const systemMsg = options.messages.find(m => m.role === 'system');
    const history = options.messages
      .filter(m => m.role !== 'system')
      .slice(0, -1)
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const lastMsg = options.messages.at(-1)!;
    const chat = model.startChat({
      history,
      systemInstruction: systemMsg?.content,
      generationConfig: { temperature: options.temperature, maxOutputTokens: options.maxTokens },
    });

    const result = await chat.sendMessageStream(lastMsg.content);
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) yield text;
    }
  }

  async listModels(): Promise<AIProviderModel[]> {
    return GEMINI_MODELS;
  }

  async generateEmbeddings(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const model = this.genAI.getGenerativeModel({ model: options.model });
    const embeddings: number[][] = [];
    for (const text of options.texts) {
      const result = await model.embedContent(text);
      embeddings.push(result.embedding.values);
    }
    return { embeddings };
  }

  async listEmbeddingModels(): Promise<AIProviderModel[]> {
    return [
      { id: 'text-embedding-004', name: 'text-embedding-004', type: 'embedding', dimension: 768 },
    ];
  }
}

const GEMINI_MODELS: AIProviderModel[] = [
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', type: 'llm', contextWindow: 1048576 },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', type: 'llm', contextWindow: 2097152 },
  { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', type: 'llm', contextWindow: 1048576 },
];
