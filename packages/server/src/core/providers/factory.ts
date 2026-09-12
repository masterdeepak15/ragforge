import { OllamaProvider } from './ollama.provider.js';
import { OpenAIProvider } from './openai.provider.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { GeminiProvider } from './gemini.provider.js';
import { GroqProvider } from './groq.provider.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import type { ILLMProvider, IEmbeddingProvider, IOAuthProvider, ProviderConfig, OAuthCredentials } from './provider.interface.js';
import type { AIProviderType } from '@ragforge/shared';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || (() => {
  console.warn('[RAGForge] ENCRYPTION_KEY not set — using insecure dev key. Set a 64-char hex key in production.');
  return '0000000000000000000000000000000000000000000000000000000000000001';
})();

export type ProviderInstance = Partial<ILLMProvider> & Partial<IEmbeddingProvider> & Partial<IOAuthProvider>;

export class ProviderFactory {
  static create(type: AIProviderType, config: ProviderConfig): ProviderInstance {
    switch (type) {
      case 'ollama':    return new OllamaProvider(config);
      case 'openai':    return new OpenAIProvider(config);
      case 'anthropic': return new AnthropicProvider(config);
      case 'gemini':    return new GeminiProvider(config);
      case 'groq':      return new GroqProvider(config);
      default:          throw new Error(`Unknown provider type: ${type}`);
    }
  }

  static encryptApiKey(plaintext: string): string {
    return encryptSecret(plaintext, ENCRYPTION_KEY);
  }

  static decryptApiKey(ciphertext: string): string {
    return decryptSecret(ciphertext, ENCRYPTION_KEY);
  }

  static encryptOAuthCredentials(creds: OAuthCredentials): string {
    return encryptSecret(JSON.stringify(creds), ENCRYPTION_KEY);
  }

  static decryptOAuthCredentials(ciphertext: string): OAuthCredentials {
    return JSON.parse(decryptSecret(ciphertext, ENCRYPTION_KEY));
  }

  /** Check if an OAuth credential set is expired or about to expire (within 60s) */
  static isTokenExpired(creds: OAuthCredentials): boolean {
    if (!creds.expiresAt) return false;
    return Date.now() >= creds.expiresAt - 60_000;
  }

  /**
   * Returns an IOAuthProvider instance for the provider type, used during OAuth flows
   * before credentials are stored (base URL only, no api key).
   */
  static oauthInstance(type: AIProviderType): IOAuthProvider | null {
    switch (type) {
      case 'gemini': return new GeminiProvider({}) as IOAuthProvider;
      case 'groq':   return new GroqProvider({}) as IOAuthProvider;
      default:       return null;
    }
  }
}
