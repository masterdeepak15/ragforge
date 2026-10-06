import { mkdir, writeFile } from 'fs/promises';
import { totalmem } from 'os';
import { dirname, join } from 'path';
import { openAdminDb, seedOllamaProvider } from '@ragforge/server/admin';
import { DATA_MARKER, defaultLocations, generateSecrets, loadCliConfig, saveCliConfig, sqliteUrl, type CliConfig, type OllamaConfig } from './config.js';
import { DockerProblem, detectGpu, dockerState, ensureModels, ensureOllamaContainer, installedModels, recommendModels, waitForOllama, type Shell } from './docker.js';
import type { Prompter } from './prompter.js';

export interface SetupFlags {
  /** Accept every default and ask nothing. */
  yes?: boolean;
  port?: number;
  host?: string;
  dataDir?: string;
  dbPath?: string;
  modelsDir?: string;
  ollama?: 'docker' | 'external' | 'none';
  ollamaUrl?: string;
  ollamaPort?: number;
  chatModel?: string;
}

export interface SetupDeps {
  home: string;
  prompter: Prompter;
  shell: Shell;
  out: (line: string) => void;
  platform?: string;
  env?: Record<string, string | undefined>;
  ramGb?: number;
  flags?: SetupFlags;
  fetchImpl?: typeof fetch;
}

export interface SetupResult {
  config: CliConfig;
  /** Things that were skipped or failed but did not stop setup. Shown at the end. */
  warnings: string[];
  startNow: boolean;
  changed: boolean;
}

const portProblem = (v: string) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 65535 ? null : 'Enter a port number from 1 to 65535.');
const required = (what: string) => (v: string) => (v.trim() ? null : `${what} cannot be empty.`);
const DOCKER_HELP = 'https://docs.docker.com/get-docker/';
const NO_AI_WARNING = 'No AI provider was set up. Before uploading documents, open Settings in RAGForge and add Ollama, OpenAI or Google Gemini (documents are indexed with one of these).';
const stripLatest = (name: string) => name.replace(/:latest$/, '');

export async function runSetup(d: SetupDeps): Promise<SetupResult> {
  const flags = d.flags ?? {};
  const out = d.out;
  const platform = d.platform ?? process.platform;
  const env = d.env ?? process.env;
  const warnings: string[] = [];

  if (flags.port !== undefined) {
    const problem = portProblem(String(flags.port));
    if (problem) throw new Error(`Invalid --port: ${problem}`);
  }

  const existing = await loadCliConfig(d.home);
  if (existing && !flags.yes) {
    if (!(await d.prompter.confirm('RAGForge is already set up. Change the settings?', false))) {
      return { config: existing, warnings, startNow: false, changed: false };
    }
  }

  out('\nRAGForge setup\n');
  const defaults = defaultLocations(d.home);

  // Where things live.
  const dataDir = flags.dataDir ?? (await d.prompter.text('Where should RAGForge keep its data (uploaded files and models)?', existing?.dataDir ?? defaults.dataDir, required('The folder')));
  const dbDefault = existing && existing.dataDir === dataDir ? existing.dbPath : join(dataDir, 'ragforge.db');
  const dbPath = flags.dbPath ?? (await d.prompter.text('Where should the database file be?', dbDefault, required('The path')));
  const port = flags.port ?? Number(await d.prompter.text('Port for the web app', String(existing?.port ?? 8080), portProblem));
  const host =
    flags.host ??
    ((await d.prompter.select(
      'Who may open RAGForge?',
      [
        { value: 'local', label: 'Only this computer', hint: 'recommended' },
        { value: 'network', label: 'Other computers on my network too' },
      ],
      existing?.host === '0.0.0.0' ? 'network' : 'local',
    )) === 'network'
      ? '0.0.0.0'
      : '127.0.0.1');
  const secrets = existing?.secrets ?? generateSecrets();

  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, DATA_MARKER), 'Created by RAGForge. `ragforge uninstall --data` removes this folder.\n');
  await mkdir(dirname(dbPath), { recursive: true });
  if (existing && existing.dbPath !== dbPath) {
    warnings.push(`The database location changed. Your existing database at ${existing.dbPath} was not moved; copy it to ${dbPath} if you want to keep its contents.`);
  }

  // AI on this computer.
  const ollama = await chooseOllama({ d, flags, dataDir, existing: existing?.ollama, platform, env, warnings });
  if (!ollama) warnings.push(NO_AI_WARNING);

  const config: CliConfig = { version: 1, host, port, dataDir, dbPath, secrets, ...(ollama ? { ollama } : {}) };

  // Prepare the database so the first start already works.
  const db = await openAdminDb({ sqliteUrl: sqliteUrl(dbPath) });
  try {
    if (ollama) await seedOllamaProvider(db, { baseUrl: ollama.baseUrl, llmModel: ollama.llmModel, embeddingModel: ollama.embeddingModel });
  } finally {
    await db.close();
  }

  await saveCliConfig(d.home, config);
  out(`Settings saved in ${d.home}`);

  const startNow = flags.yes ? true : await d.prompter.confirm('Start RAGForge now?', true);
  return { config, warnings, startNow, changed: true };
}

async function chooseOllama(o: { d: SetupDeps; flags: SetupFlags; dataDir: string; existing?: OllamaConfig; platform: string; env: Record<string, string | undefined>; warnings: string[] }): Promise<OllamaConfig | null> {
  const { d, flags, platform, env, warnings } = o;
  const QUESTION = 'Which AI should RAGForge use on this computer?';
  let mode = flags.ollama;

  while (!mode) {
    const docker = await dockerState(d.shell, platform, env);
    const dockerChoices = [
      { value: 'docker' as const, label: 'Run Ollama in Docker', hint: 'recommended: free, private, nothing to configure' },
      { value: 'external' as const, label: 'Use an Ollama I already run' },
      { value: 'none' as const, label: 'Skip for now', hint: 'use OpenAI or Gemini later, in Settings' },
    ];
    if (docker.state === 'ready') {
      mode = await d.prompter.select(QUESTION, dockerChoices, 'docker');
      break;
    }
    d.out(
      docker.state === 'not-installed'
        ? `Docker is not installed, so RAGForge cannot run Ollama for you. Get Docker at ${DOCKER_HELP}, or choose another option.`
        : 'Docker is installed but not running. Start Docker Desktop (or the Docker service), then choose "Check Docker again".',
    );
    const choice = await d.prompter.select(QUESTION, [{ value: 'retry' as const, label: 'Check Docker again' }, ...dockerChoices.slice(1)], 'none');
    if (choice !== 'retry') mode = choice;
  }

  if (mode === 'none') return null;
  return mode === 'external' ? useExistingOllama(o) : runOllamaInDocker(o);
}

async function useExistingOllama(o: { d: SetupDeps; flags: SetupFlags; warnings: string[] }): Promise<OllamaConfig | null> {
  const { d, flags, warnings } = o;
  const urlProblem = (v: string) => (/^https?:\/\//i.test(v) ? null : 'The address must start with http:// or https://.');
  const baseUrl = (flags.ollamaUrl ?? (await d.prompter.text('Ollama address', 'http://127.0.0.1:11434', urlProblem))).replace(/\/+$/, '');

  let models: string[];
  try {
    models = await installedModels(baseUrl, d.fetchImpl);
  } catch {
    warnings.push(`Could not reach Ollama at ${baseUrl}. Start it, then run \`ragforge setup\` again (or add it later in Settings).`);
    return null;
  }

  const chatModels = models.filter((m) => !/embed/i.test(m));
  const embedModel = models.find((m) => /nomic-embed-text/i.test(m)) ?? models.find((m) => /embed/i.test(m));
  const llmModel =
    flags.chatModel ??
    (chatModels.length ? await d.prompter.select('Model for answers', chatModels.map((m) => ({ value: m, label: m })), chatModels[0]) : recommendModels(16).chat);
  if (!chatModels.length) warnings.push(`Ollama has no chat model yet. Download one, for example: ollama pull ${llmModel}`);
  if (!embedModel) warnings.push('Ollama has no embedding model, which indexing needs. Download one: ollama pull nomic-embed-text');
  return { mode: 'external', baseUrl, llmModel, embeddingModel: stripLatest(embedModel ?? 'nomic-embed-text') };
}

async function runOllamaInDocker(o: { d: SetupDeps; flags: SetupFlags; dataDir: string; existing?: OllamaConfig; platform: string; env: Record<string, string | undefined>; warnings: string[] }): Promise<OllamaConfig | null> {
  const { d, flags, platform, env, warnings } = o;
  const docker = await dockerState(d.shell, platform, env);
  if (docker.state !== 'ready') {
    warnings.push(docker.state === 'not-installed' ? `Docker is not installed, so Ollama was not set up. Get Docker at ${DOCKER_HELP} and run \`ragforge setup\` again.` : 'Docker is not running, so Ollama was not set up. Start Docker and run `ragforge setup` again.');
    return null;
  }

  const plan = recommendModels(d.ramGb ?? totalmem() / 1024 ** 3);
  const options = [
    { value: plan.chat, label: `${plan.chat}`, hint: `recommended for this computer, about ${plan.approxGb.chat} GB` },
    ...[
      ['llama3.2:1b', 'smallest and fastest, about 1.3 GB'],
      ['llama3.1:8b', 'better answers, needs a strong computer, about 4.9 GB'],
    ]
      .filter(([m]) => m !== plan.chat)
      .map(([m, hint]) => ({ value: m, label: m, hint })),
  ];
  const chat = flags.chatModel ?? (await d.prompter.select('Which chat model should Ollama use?', options, plan.chat));
  const gb = chat === plan.chat ? plan.approxGb.chat : chat === 'llama3.2:1b' ? 1.3 : 4.9;
  const download = await d.prompter.confirm(`Download ${chat} (about ${gb} GB) and ${plan.embedding} (about ${plan.approxGb.embedding} GB) now?`, true);

  const port = flags.ollamaPort ?? o.existing?.port ?? 11434;
  const modelsDir = flags.modelsDir ?? o.existing?.modelsDir ?? join(o.dataDir, 'ollama');
  const container = o.existing?.container ?? 'ragforge-ollama';
  const baseUrl = `http://127.0.0.1:${port}`;
  const config: OllamaConfig = { mode: 'docker', baseUrl, container, port, modelsDir, llmModel: chat, embeddingModel: plan.embedding };

  try {
    await mkdir(modelsDir, { recursive: true });
    const gpu = await detectGpu(d.shell);
    const action = await ensureOllamaContainer(d.shell, docker.docker, { name: container, port, modelsDir, gpu }, platform, env);
    d.out(action === 'created' ? `Started Ollama in Docker (${container})${gpu ? ' with your GPU' : ''}.` : `Ollama is ${action === 'started' ? 'started' : 'already running'} (${container}).`);
    await waitForOllama(baseUrl, { fetchImpl: d.fetchImpl });
  } catch (err) {
    if (err instanceof DockerProblem) {
      warnings.push(err.message);
      return null;
    }
    throw err;
  }

  if (!download) {
    warnings.push(`Models were not downloaded. Indexing needs ${plan.embedding}: docker exec ${container} ollama pull ${plan.embedding}`);
    return config;
  }
  try {
    d.out('Downloading models (this can take a few minutes the first time)...');
    await ensureModels(d.shell, docker.docker, { container, baseUrl, models: [plan.embedding, chat], fetchImpl: d.fetchImpl, platform, env });
  } catch (err) {
    if (!(err instanceof DockerProblem)) throw err;
    warnings.push(`${err.message} Run \`ragforge setup\` again to retry.`);
  }
  return config;
}
