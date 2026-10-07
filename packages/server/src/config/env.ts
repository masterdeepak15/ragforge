/** Keep equal to "version" in package.json (a test checks). */
export const APP_VERSION = '1.0.1';

export const DEFAULT_JWT_SECRET = 'your-super-secret-jwt-key-change-in-production';
export const DEFAULT_ENCRYPTION_KEY = '0'.repeat(63) + '1';

export interface Config {
  production: boolean;
  port: number;
  /** Address to listen on. 0.0.0.0 = every interface (containers); 127.0.0.1 = this machine only. */
  host: string;
  publicUrl: string;
  storageMode: 'sqlite' | 'postgres';
  sqliteUrl: string;
  postgresUrl?: string;
  dataDir: string;
  jwtSecret: string;
  encryptionKey: string;
  ingestConcurrency: number;
  mcpRateLimit: number;
  /** Optional cap on a single uploaded file; unset = unlimited. */
  maxUploadBytes?: number;
  /** Non-fatal issues (insecure development defaults) to print at startup. */
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates environment variables once, at startup. Throws a single ConfigError listing every
 * problem. In production, insecure or placeholder secrets are errors; in development they are
 * allowed and reported as warnings.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];
  const warnings: string[] = [];
  const production = env.NODE_ENV === 'production';

  const integer = (name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
      return fallback;
    }
    return n;
  };

  const port = integer('PORT', 8080, 1, 65535);
  const ingestConcurrency = integer('INGEST_CONCURRENCY', 2, 1, 64);
  const mcpRateLimit = integer('MCP_RATE_LIMIT', 60, 1);
  const maxUploadBytes = env.MAX_UPLOAD_BYTES ? integer('MAX_UPLOAD_BYTES', 0, 1) : undefined;

  const storageRaw = env.STORAGE_MODE || 'sqlite';
  if (storageRaw !== 'sqlite' && storageRaw !== 'postgres') {
    problems.push(`STORAGE_MODE must be "sqlite" or "postgres" (got "${storageRaw}")`);
  }
  const storageMode = storageRaw === 'postgres' ? 'postgres' : 'sqlite';
  if (storageMode === 'postgres' && !env.POSTGRES_URL) problems.push('POSTGRES_URL is required when STORAGE_MODE=postgres');

  const jwtSecret = env.JWT_SECRET || '';
  const jwtWeak = !jwtSecret || jwtSecret.length < 32 || /change[-_ ]?me|your-super-secret/i.test(jwtSecret);
  if (jwtWeak) {
    if (production) {
      problems.push('JWT_SECRET must be set to a random string of at least 32 characters (and not a placeholder) in production');
    } else {
      warnings.push('JWT_SECRET is not set to a strong value; using an insecure development secret. Set a random 32+ character secret before deploying.');
    }
  }

  const encryptionKey = env.ENCRYPTION_KEY || '';
  const keyValid = /^[0-9a-fA-F]{64}$/.test(encryptionKey) && encryptionKey !== DEFAULT_ENCRYPTION_KEY;
  if (!keyValid) {
    if (production) {
      problems.push('ENCRYPTION_KEY must be 64 hexadecimal characters (e.g. `openssl rand -hex 32`) and not the development default in production');
    } else {
      warnings.push('ENCRYPTION_KEY is not set to a valid 64-character hex key; stored provider credentials use an insecure development key.');
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    production,
    port,
    host: env.HOST || '0.0.0.0',
    publicUrl: env.PUBLIC_URL || `http://localhost:${port}`,
    storageMode,
    sqliteUrl: env.SQLITE_URL || 'file:./ragforge.db',
    postgresUrl: env.POSTGRES_URL,
    dataDir: env.DATA_DIR || 'data',
    jwtSecret: jwtWeak ? jwtSecret || DEFAULT_JWT_SECRET : jwtSecret,
    encryptionKey: keyValid ? encryptionKey : DEFAULT_ENCRYPTION_KEY,
    ingestConcurrency,
    mcpRateLimit,
    maxUploadBytes,
    warnings,
  };
}
