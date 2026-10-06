import { randomBytes } from 'crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

/** Written into every data folder RAGForge creates, so `uninstall --data` never deletes a folder it does not own. */
export const DATA_MARKER = '.ragforge-data';

export interface OllamaConfig {
  /** `docker`: RAGForge runs the container. `external`: an Ollama the user already runs. */
  mode: 'docker' | 'external';
  baseUrl: string;
  container?: string;
  port?: number;
  modelsDir?: string;
  llmModel: string;
  embeddingModel: string;
}

export interface CliConfig {
  version: 1;
  host: string;
  port: number;
  /** Uploaded files and everything else RAGForge keeps by default. */
  dataDir: string;
  /** SQLite database file. */
  dbPath: string;
  secrets: { jwtSecret: string; encryptionKey: string };
  ollama?: OllamaConfig;
}

export class ConfigProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigProblem';
  }
}

/** Where RAGForge keeps its settings: a hidden folder in the user profile (like .claude). */
export function homeDir(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
  return env.RAGFORGE_HOME || join(homedir(), '.ragforge');
}

/** Default places for the database, uploaded files and Ollama models. Each can be changed during setup. */
export function defaultLocations(home: string): { dataDir: string; dbPath: string; ollamaModelsDir: string } {
  const dataDir = join(home, 'data');
  return { dataDir, dbPath: join(dataDir, 'ragforge.db'), ollamaModelsDir: join(dataDir, 'ollama') };
}

export function generateSecrets(): CliConfig['secrets'] {
  return { jwtSecret: randomBytes(48).toString('base64url'), encryptionKey: randomBytes(32).toString('hex') };
}

const configFile = (home: string) => join(home, 'config.json');
const AGAIN = 'Run `ragforge setup` to create it again.';

function validate(raw: any): CliConfig {
  const bad = (what: string): never => {
    throw new ConfigProblem(`The RAGForge configuration is invalid (${what}). ${AGAIN}`);
  };
  if (!raw || typeof raw !== 'object') bad('not an object');
  if (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) bad('port');
  if (typeof raw.host !== 'string' || !raw.host) bad('host');
  if (typeof raw.dataDir !== 'string' || !raw.dataDir) bad('dataDir');
  if (typeof raw.dbPath !== 'string' || !raw.dbPath) bad('dbPath');
  const s = raw.secrets;
  if (!s || typeof s.jwtSecret !== 'string' || s.jwtSecret.length < 32 || !/^[0-9a-fA-F]{64}$/.test(String(s.encryptionKey))) bad('secrets');
  return raw as CliConfig;
}

/** Reads the saved configuration, or null when setup has not been run. */
export async function loadCliConfig(home: string): Promise<CliConfig | null> {
  let text: string;
  try {
    text = await readFile(configFile(home), 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigProblem(`The RAGForge configuration file is damaged (${configFile(home)}). ${AGAIN}`);
  }
  return validate(parsed);
}

/** Writes the configuration atomically. It holds the secrets, so it is readable by the owner only. */
export async function saveCliConfig(home: string, config: CliConfig): Promise<void> {
  await mkdir(home, { recursive: true });
  const target = configFile(home);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, target);
  await chmod(target, 0o600).catch(() => {
    /* not supported on every file system (Windows) */
  });
}

/** `file:` URL for a SQLite path, using forward slashes so it also works on Windows. */
export function sqliteUrl(path: string): string {
  return `file:${path.replace(/\\/g, '/')}`;
}

/** The environment the server process runs with. Production mode, so weak secrets are refused. */
export function serverEnv(config: CliConfig, opts: { webDir: string }): Record<string, string> {
  return {
    NODE_ENV: 'production',
    HOST: config.host,
    PORT: String(config.port),
    DATA_DIR: config.dataDir,
    SQLITE_URL: sqliteUrl(config.dbPath),
    JWT_SECRET: config.secrets.jwtSecret,
    ENCRYPTION_KEY: config.secrets.encryptionKey,
    WEB_DIR: opts.webDir,
    PUBLIC_URL: `http://localhost:${config.port}`,
  };
}
