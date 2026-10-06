import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from './env.js';

const GOOD_JWT = 'j'.repeat(48);
const GOOD_KEY = 'a1'.repeat(32); // 64 hex chars
const prod = (over: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'production',
  JWT_SECRET: GOOD_JWT,
  ENCRYPTION_KEY: GOOD_KEY,
  ...over,
});

function problems(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env as NodeJS.ProcessEnv);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig (production)', () => {
  it('accepts a complete, strong configuration without warnings', () => {
    const cfg = loadConfig(prod() as NodeJS.ProcessEnv);
    expect(cfg.production).toBe(true);
    expect(cfg.warnings).toEqual([]);
    expect(cfg.port).toBe(8080);
  });

  it.each([
    ['unset', undefined],
    ['the shipped default', 'your-super-secret-jwt-key-change-in-production'],
    ['the compose placeholder', 'change-me-in-production'],
    ['too short', 'short-secret'],
  ])('refuses a JWT_SECRET that is %s', (_name, value) => {
    expect(problems(prod({ JWT_SECRET: value }))).toMatch(/JWT_SECRET/);
  });

  it.each([
    ['unset', undefined],
    ['not hex', 'change-me-to-64-char-hex-key'],
    ['wrong length', 'ab'.repeat(16)],
    ['the insecure dev key', '0'.repeat(63) + '1'],
  ])('refuses an ENCRYPTION_KEY that is %s', (_name, value) => {
    expect(problems(prod({ ENCRYPTION_KEY: value }))).toMatch(/ENCRYPTION_KEY/);
  });

  it('reports every problem at once instead of one per restart', () => {
    const msg = problems(prod({ JWT_SECRET: 'x', ENCRYPTION_KEY: 'y', PORT: 'abc' }));
    expect(msg).toMatch(/JWT_SECRET/);
    expect(msg).toMatch(/ENCRYPTION_KEY/);
    expect(msg).toMatch(/PORT/);
  });
});

describe('loadConfig (development)', () => {
  it('allows the insecure defaults but warns about them', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.production).toBe(false);
    expect(cfg.warnings.join(' ')).toMatch(/JWT_SECRET/);
    expect(cfg.warnings.join(' ')).toMatch(/ENCRYPTION_KEY/);
    expect(cfg.storageMode).toBe('sqlite');
  });
});

describe('loadConfig (shared rules)', () => {
  it('requires POSTGRES_URL in postgres mode', () => {
    expect(problems({ STORAGE_MODE: 'postgres' })).toMatch(/POSTGRES_URL/);
    expect(loadConfig({ STORAGE_MODE: 'postgres', POSTGRES_URL: 'postgres://u:p@db/rag' } as NodeJS.ProcessEnv).storageMode).toBe('postgres');
  });

  it('rejects unknown storage modes', () => {
    expect(problems({ STORAGE_MODE: 'mysql' })).toMatch(/STORAGE_MODE/);
  });

  it.each([['PORT', 'abc'], ['PORT', '0'], ['PORT', '70000'], ['INGEST_CONCURRENCY', '0'], ['INGEST_CONCURRENCY', 'many'], ['MCP_RATE_LIMIT', '-5'], ['MAX_UPLOAD_BYTES', 'lots']])(
    'rejects %s=%s',
    (name, value) => {
      expect(problems({ [name]: value })).toMatch(new RegExp(name));
    },
  );

  it('parses optional numeric settings', () => {
    const cfg = loadConfig({ PORT: '3000', INGEST_CONCURRENCY: '4', MCP_RATE_LIMIT: '120', MAX_UPLOAD_BYTES: '1048576' } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ port: 3000, ingestConcurrency: 4, mcpRateLimit: 120, maxUploadBytes: 1048576 });
    expect(loadConfig({} as NodeJS.ProcessEnv)).toMatchObject({ ingestConcurrency: 2, mcpRateLimit: 60, maxUploadBytes: undefined });
  });
});

describe('loadConfig: listen address', () => {
  it('listens on every interface unless told otherwise, so containers keep working', () => {
    expect(loadConfig(prod() as NodeJS.ProcessEnv).host).toBe('0.0.0.0');
  });

  it('can be limited to this machine with HOST', () => {
    expect(loadConfig(prod({ HOST: '127.0.0.1' }) as NodeJS.ProcessEnv).host).toBe('127.0.0.1');
  });

  it('treats an empty HOST as unset', () => {
    expect(loadConfig(prod({ HOST: '' }) as NodeJS.ProcessEnv).host).toBe('0.0.0.0');
  });
});
