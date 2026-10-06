import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createClient } from '@libsql/client';
import { autoPrompter } from './prompter.js';
import { DATA_MARKER, loadCliConfig, saveCliConfig, generateSecrets, sqliteUrl } from './config.js';
import { runSetup, type SetupFlags } from './setup.js';
import { fail, fakeShell, ok, scriptedPrompter } from './testing.js';

let root: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ragforge-setup-'));
  home = join(root, '.ragforge');
});
afterEach(async () => {
  // Windows holds the just-closed database file for a moment; waiting for it only slows the tests down.
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

/** Docker installed and running, Ollama answering, models already present unless told otherwise. */
const dockerReady = (extra: Record<string, any> = {}) =>
  fakeShell({
    'docker --version': ok('Docker version 29'),
    'docker info': ok('29.8.2'),
    'docker inspect': fail('No such object'),
    'docker run': ok('abc'),
    'docker exec': ok(),
    'nvidia-smi': fail('not found', 127),
    ...extra,
  });

const ollamaFetch = (models: string[] = []) =>
  (async (url: any) => {
    if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: models.map((name) => ({ name })) }));
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

const deps = (over: Record<string, any> = {}) => {
  const out: string[] = [];
  return {
    out,
    d: {
      home,
      shell: dockerReady().shell,
      prompter: scriptedPrompter().prompter,
      out: (line: string) => out.push(line),
      platform: 'linux',
      env: {},
      ramGb: 16,
      fetchImpl: ollamaFetch(),
      ...over,
    },
  };
};

async function providersIn(dbPath: string) {
  const client = createClient({ url: sqliteUrl(dbPath) });
  try {
    return (await client.execute('SELECT provider, base_url, default_llm_model, default_embedding_model, is_default_llm, is_default_embedding FROM ai_providers')).rows as any[];
  } finally {
    client.close();
  }
}

describe('first-time setup with Docker', () => {
  it('sets everything up with the defaults', async () => {
    const { d } = deps();
    const result = await runSetup(d as any);
    const cfg = result.config;

    expect(cfg).toMatchObject({ host: '127.0.0.1', port: 8080, dataDir: join(home, 'data'), dbPath: join(home, 'data', 'ragforge.db') });
    expect(cfg.secrets.jwtSecret.length).toBeGreaterThanOrEqual(48);
    expect(await loadCliConfig(home)).toEqual(cfg);
    await expect(access(join(cfg.dataDir, DATA_MARKER))).resolves.toBeUndefined();
    expect(result.startNow).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('runs Ollama in Docker with models stored in the data folder, then downloads what is missing', async () => {
    const { shell, calls, has } = dockerReady();
    const { d } = deps({ shell });
    const { config } = await runSetup(d as any);

    expect(config.ollama).toMatchObject({ mode: 'docker', baseUrl: 'http://127.0.0.1:11434', container: 'ragforge-ollama', port: 11434, modelsDir: join(home, 'data', 'ollama'), llmModel: 'llama3.2:3b', embeddingModel: 'nomic-embed-text' });
    const run = calls.find((c) => c.args[0] === 'run')!.args;
    expect(run).toContain(`${join(home, 'data', 'ollama')}:/root/.ollama`);
    expect(has('exec ragforge-ollama ollama pull llama3.2:3b')).toBe(true);
    expect(has('exec ragforge-ollama ollama pull nomic-embed-text')).toBe(true);
  });

  it('does not download models that are already there', async () => {
    const { shell, has } = dockerReady();
    const { d } = deps({ shell, fetchImpl: ollamaFetch(['llama3.2:3b', 'nomic-embed-text:latest']) });
    await runSetup(d as any);
    expect(has('ollama pull')).toBe(false);
  });

  it('prepares the database so Ollama already answers and indexes on the first start', async () => {
    const { d } = deps();
    const { config } = await runSetup(d as any);
    expect(await providersIn(config.dbPath)).toEqual([
      { provider: 'ollama', base_url: 'http://127.0.0.1:11434', default_llm_model: 'llama3.2:3b', default_embedding_model: 'nomic-embed-text', is_default_llm: 1, is_default_embedding: 1 },
    ]);
  });

  it('suggests a smaller chat model on a small computer, and a larger one on a big one', async () => {
    expect((await runSetup(deps({ ramGb: 6 }).d as any)).config.ollama?.llmModel).toBe('llama3.2:1b');
    expect((await runSetup(deps({ ramGb: 64, home: join(root, 'second', '.ragforge') }).d as any)).config.ollama?.llmModel).toBe('llama3.1:8b');
  });

  it('lets the user choose where the data and the database live', async () => {
    const data = join(root, 'my-data');
    const db = join(root, 'elsewhere', 'rag.db');
    const { prompter } = scriptedPrompter([[/keep its data/i, data], [/database file/i, db]]);
    const { config } = await runSetup(deps({ prompter }).d as any);
    expect(config).toMatchObject({ dataDir: data, dbPath: db });
    expect(config.ollama?.modelsDir).toBe(join(data, 'ollama'));
    await expect(access(db)).resolves.toBeUndefined();
    await expect(access(join(data, DATA_MARKER))).resolves.toBeUndefined();
  });

  it('can listen on the network when the user chooses it', async () => {
    const { prompter } = scriptedPrompter([[/who may open/i, 'network']]);
    expect((await runSetup(deps({ prompter }).d as any)).config.host).toBe('0.0.0.0');
  });

  it('uses the GPU for Ollama when there is one', async () => {
    const { shell, calls } = dockerReady({ 'nvidia-smi -L': ok('GPU 0: NVIDIA GeForce RTX 4070') });
    await runSetup(deps({ shell }).d as any);
    expect(calls.find((c) => c.args[0] === 'run')!.args).toContain('--gpus');
  });
});

describe('when Docker is not available', () => {
  it('explains how to get it and still lets setup finish without a local model', async () => {
    const { shell, calls } = fakeShell({});
    const { out, d } = deps({ shell, prompter: scriptedPrompter([[/which ai/i, 'none']]).prompter });
    const { config, warnings } = await runSetup(d as any);

    expect(config.ollama).toBeUndefined();
    expect(out.join('\n')).toMatch(/Docker is not installed/);
    expect(out.join('\n')).toMatch(/docs\.docker\.com\/get-docker/);
    expect(warnings.join(' ')).toMatch(/Settings/);
    expect(calls.some((c) => c.args[0] === 'run')).toBe(false);
    expect(await providersIn(config.dbPath)).toEqual([]);
  });

  it('says when Docker is installed but not running', async () => {
    const { shell } = fakeShell({ 'docker --version': ok('v'), 'docker info': fail('Cannot connect to the Docker daemon') });
    const { out, d } = deps({ shell, prompter: scriptedPrompter([[/which ai/i, 'none']]).prompter });
    await runSetup(d as any);
    expect(out.join('\n')).toMatch(/Docker is installed but not running.*Start Docker Desktop/is);
  });

  it('checks again after the user starts Docker', async () => {
    let running = false;
    const { shell } = fakeShell({
      'docker --version': ok('v'),
      'docker info': () => (running ? ok('29') : fail('Cannot connect')),
      'docker inspect': fail('No such object'),
      'docker run': ok('abc'),
      'docker exec': ok(),
      'nvidia-smi': fail('x', 127),
    });
    const asked: string[] = [];
    const prompter = {
      select: async (q: string, _c: any, dflt: string) => {
        asked.push(q);
        if (/which ai/i.test(q) && !running) {
          running = true; // the user starts Docker, then asks to check again
          return 'retry';
        }
        return dflt;
      },
      confirm: async (_q: string, dflt: boolean) => dflt,
      text: async (_q: string, dflt: string) => dflt,
    };
    const { config } = await runSetup(deps({ shell, prompter }).d as any);
    expect(config.ollama?.mode).toBe('docker');
    expect(asked.filter((q) => /which ai/i.test(q))).toHaveLength(2);
  });
});

describe('an Ollama that already runs', () => {
  it('uses it and its installed models', async () => {
    const { prompter } = scriptedPrompter([[/which ai/i, 'external'], [/Ollama address/i, 'http://127.0.0.1:11434'], [/model for answers/i, 'qwen2.5:7b']]);
    const { shell, calls } = fakeShell({});
    const { config } = await runSetup(deps({ shell, prompter, fetchImpl: ollamaFetch(['qwen2.5:7b', 'nomic-embed-text:latest']) }).d as any);

    expect(config.ollama).toMatchObject({ mode: 'external', baseUrl: 'http://127.0.0.1:11434', llmModel: 'qwen2.5:7b', embeddingModel: 'nomic-embed-text' });
    expect(calls.some((c) => c.args[0] === 'run')).toBe(false);
    expect((await providersIn(config.dbPath))[0]).toMatchObject({ default_llm_model: 'qwen2.5:7b' });
  });

  it('warns when the server cannot be reached, and sets nothing up for it', async () => {
    const { prompter } = scriptedPrompter([[/which ai/i, 'external']]);
    const failing = (async () => Promise.reject(new Error('refused'))) as unknown as typeof fetch;
    const { shell } = fakeShell({});
    const { config, warnings } = await runSetup(deps({ shell, prompter, fetchImpl: failing }).d as any);
    expect(config.ollama).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/could not reach/i);
  });
});

describe('when Docker fails', () => {
  it('reports the problem and finishes setup without Ollama', async () => {
    const { shell } = dockerReady({ 'docker run': fail('Bind for 127.0.0.1:11434 failed: port is already allocated') });
    const { config, warnings } = await runSetup(deps({ shell }).d as any);
    expect(config.ollama).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/11434.*already in use/);
  });

  it('keeps the container when a model download fails, and says how to retry', async () => {
    const { shell } = dockerReady({ 'docker exec': fail('network error') });
    const { config, warnings } = await runSetup(deps({ shell }).d as any);
    expect(config.ollama?.mode).toBe('docker');
    expect(warnings.join(' ')).toMatch(/Could not download/);
  });
});

describe('running setup again', () => {
  it('keeps the secrets and the data location unless the user changes the settings', async () => {
    const first = (await runSetup(deps().d as any)).config;
    const again = await runSetup(deps({ prompter: scriptedPrompter([[/already set up/i, false]]).prompter }).d as any);
    expect(again.changed).toBe(false);
    expect(again.config).toEqual(first);
    expect(again.startNow).toBe(false);
  });

  it('changes settings but reuses the secrets, so stored credentials keep working', async () => {
    const first = (await runSetup(deps().d as any)).config;
    const { prompter } = scriptedPrompter([[/already set up/i, true], [/port/i, '9100']]);
    const again = await runSetup(deps({ prompter }).d as any);
    expect(again.changed).toBe(true);
    expect(again.config.port).toBe(9100);
    expect(again.config.secrets).toEqual(first.secrets);
  });

  it('warns that an existing database is not moved when its location changes', async () => {
    await runSetup(deps().d as any);
    const moved = join(root, 'new-place', 'rag.db');
    const { prompter } = scriptedPrompter([[/already set up/i, true], [/database file/i, moved]]);
    const { warnings } = await runSetup(deps({ prompter }).d as any);
    expect(warnings.join(' ')).toMatch(/not moved/i);
  });
});

describe('non-interactive setup (--yes and flags)', () => {
  it('needs no answers and honours the flags', async () => {
    const flags: SetupFlags = { yes: true, port: 9200, host: '127.0.0.1', dataDir: join(root, 'flag-data'), ollama: 'docker' };
    const { config } = await runSetup(deps({ prompter: autoPrompter(), flags }).d as any);
    expect(config).toMatchObject({ port: 9200, dataDir: join(root, 'flag-data'), dbPath: join(root, 'flag-data', 'ragforge.db') });
    expect(config.ollama?.mode).toBe('docker');
  });

  it('skips Ollama when asked to', async () => {
    const { shell, calls } = dockerReady();
    const { config } = await runSetup(deps({ shell, prompter: autoPrompter(), flags: { yes: true, ollama: 'none' } }).d as any);
    expect(config.ollama).toBeUndefined();
    expect(calls.some((c) => c.args[0] === 'run')).toBe(false);
  });

  it('chooses no local model when Docker is missing instead of failing', async () => {
    const { config, warnings } = await runSetup(deps({ shell: fakeShell({}).shell, prompter: autoPrompter(), flags: { yes: true } }).d as any);
    expect(config.ollama).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('rejects a port that is not a port', async () => {
    await expect(runSetup(deps({ flags: { yes: true, port: 99999 } }).d as any)).rejects.toThrow(/port/i);
  });

  it('writes a valid, readable config file', async () => {
    await runSetup(deps({ prompter: autoPrompter(), flags: { yes: true } }).d as any);
    expect(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).version).toBe(1);
    void saveCliConfig; void generateSecrets;
  });
});
