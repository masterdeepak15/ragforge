import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { ConfigProblem, DATA_MARKER, defaultLocations, generateSecrets, homeDir, loadCliConfig, saveCliConfig, serverEnv, sqliteUrl, type CliConfig } from './config.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ragforge-cfg-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
});

const sample = (over: Partial<CliConfig> = {}): CliConfig => ({
  version: 1,
  host: '127.0.0.1',
  port: 8080,
  dataDir: join(dir, 'data'),
  dbPath: join(dir, 'data', 'ragforge.db'),
  secrets: generateSecrets(),
  ...over,
});

describe('homeDir', () => {
  it('is a hidden folder in the user profile, like .claude', () => {
    expect(homeDir({})).toBe(join(homedir(), '.ragforge'));
  });
  it('can be moved with RAGFORGE_HOME', () => {
    expect(homeDir({ RAGFORGE_HOME: '/srv/rag' })).toBe('/srv/rag');
  });
});

describe('defaultLocations', () => {
  it('keeps the database, uploaded files and models together under one data folder', () => {
    const home = join(dir, '.ragforge');
    expect(defaultLocations(home)).toEqual({
      dataDir: join(home, 'data'),
      dbPath: join(home, 'data', 'ragforge.db'),
      ollamaModelsDir: join(home, 'data', 'ollama'),
    });
  });
});

describe('generateSecrets', () => {
  it('makes strong random secrets that the server accepts in production', () => {
    const s = generateSecrets();
    expect(s.jwtSecret.length).toBeGreaterThanOrEqual(48);
    expect(s.encryptionKey).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSecrets().jwtSecret).not.toBe(s.jwtSecret);
  });
});

describe('saving and loading the configuration', () => {
  it('returns null before setup has been run', async () => {
    expect(await loadCliConfig(dir)).toBeNull();
  });

  it('round-trips what was saved', async () => {
    const cfg = sample({ ollama: { mode: 'docker', baseUrl: 'http://127.0.0.1:11434', container: 'ragforge-ollama', port: 11434, modelsDir: join(dir, 'models'), llmModel: 'llama3.2:3b', embeddingModel: 'nomic-embed-text' } });
    await saveCliConfig(dir, cfg);
    expect(await loadCliConfig(dir)).toEqual(cfg);
  });

  it.skipIf(process.platform === 'win32')('keeps the secrets readable by the owner only', async () => {
    await saveCliConfig(dir, sample());
    expect((await stat(join(dir, 'config.json'))).mode & 0o777).toBe(0o600);
  });

  it('explains a damaged file instead of crashing', async () => {
    await writeFile(join(dir, 'config.json'), '{ not json');
    await expect(loadCliConfig(dir)).rejects.toThrow(ConfigProblem);
    await expect(loadCliConfig(dir)).rejects.toThrow(/ragforge setup/);
  });

  it.each([
    [{ port: 70000 }, /port/],
    [{ port: 0 }, /port/],
    [{ host: '' }, /host/],
    [{ dataDir: '' }, /dataDir/],
    [{ secrets: { jwtSecret: 'short', encryptionKey: 'x' } }, /secrets/],
  ])('rejects invalid settings %j', async (over, message) => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ ...sample(), ...over }));
    await expect(loadCliConfig(dir)).rejects.toThrow(message);
  });

  it('never leaves a half-written file behind', async () => {
    await saveCliConfig(dir, sample());
    await saveCliConfig(dir, sample({ port: 9000 }));
    expect((await loadCliConfig(dir))?.port).toBe(9000);
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).port).toBe(9000);
  });
});

describe('sqliteUrl', () => {
  it('turns a file path into a database URL, also on Windows', () => {
    expect(sqliteUrl('D:\\Data\\rag.db')).toBe('file:D:/Data/rag.db');
    expect(sqliteUrl('/home/me/.ragforge/data/rag.db')).toBe('file:/home/me/.ragforge/data/rag.db');
  });
});

describe('serverEnv', () => {
  it('hands the server everything it needs, in production mode with the generated secrets', () => {
    const cfg = sample();
    const env = serverEnv(cfg, { webDir: '/pkg/dist/web' });
    expect(env).toMatchObject({
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '8080',
      DATA_DIR: cfg.dataDir,
      SQLITE_URL: sqliteUrl(cfg.dbPath),
      JWT_SECRET: cfg.secrets.jwtSecret,
      ENCRYPTION_KEY: cfg.secrets.encryptionKey,
      WEB_DIR: '/pkg/dist/web',
      PUBLIC_URL: 'http://localhost:8080',
    });
  });

  it('names the address people use when the server listens on every interface', () => {
    expect(serverEnv(sample({ host: '0.0.0.0', port: 9000 }), { webDir: 'w' }).PUBLIC_URL).toBe('http://localhost:9000');
  });
});

describe('data marker', () => {
  it('is a stable file name used to recognise folders RAGForge created', () => {
    expect(DATA_MARKER).toBe('.ragforge-data');
  });
});
