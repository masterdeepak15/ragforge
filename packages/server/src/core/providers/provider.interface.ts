import type { LLMMessage, LLMStreamOptions, EmbeddingOptions, EmbeddingResult, AIProviderModel } from '@ragforge/shared';

export interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
}

export interface ILLMProvider {
  /**
   * Stream chat completion tokens via async generator
   */
  streamChat(options: LLMStreamOptions): AsyncGenerator<string, void, unknown>;

  /**
   * List available LLM models
   */
  listModels(): Promise<AIProviderModel[]>;
}

export interface IEmbeddingProvider {
  /**
   * Generate embeddings for given texts
   */
  generateEmbeddings(options: EmbeddingOptions): Promise<EmbeddingResult>;

  /**
   * List available embedding models
   */
  listEmbeddingModels(): Promise<AIProviderModel[]>;
}

export interface IOAuthProvider {
  /**
   * Get OAuth authorization URL (PKCE flow)
   */
  getAuthUrl(codeVerifier: string, redirectUri: string, state: string): string;

  /**
   * Exchange authorization code for access token
   */
  exchangeCodeForToken(code: string, codeVerifier: string, redirectUri: string): Promise<OAuthCredentials>;

  /**
   * Refresh access token using refresh token
   */
  refreshAccessToken(refreshToken: string): Promise<OAuthCredentials>;
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  oauthCredentials?: OAuthCredentials;
}
