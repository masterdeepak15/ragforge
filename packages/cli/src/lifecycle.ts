import { open, stat } from 'fs/promises';
import { join } from 'path';
import { loadCliConfig, serverEnv, type CliConfig } from './config.js';
import { appUrl, healthUrl, logFile, pidFile, requireConfig, type CliContext } from './context.js';
import { DockerProblem, detectGpu, dockerState, ensureOllamaContainer, stopOllama } from './docker.js';
import { StartFailed, daemonStatus, startDaemon, stopDaemon, tailLog } from './runtime.js';
import { serviceStatus, type ServiceTarget } from './service.js';

export function serviceTarget(ctx: CliContext): ServiceTarget {
  return { platform: ctx.platform, node: ctx.nodePath, script: ctx.bundlePath, home: ctx.home, userHome: ctx.userHome, uid: ctx.uid };
}

/** Makes sure the Ollama container runs, when RAGForge set it up. Never fatal: RAGForge itself can start without it. */
async function ensureOllamaRunning(ctx: CliContext, config: CliConfig, say: (line: string) => void): Promise<void> {
  const o = config.ollama;
  if (!o || o.mode !== 'docker') return;
  const state = await dockerState(ctx.shell, ctx.platform, ctx.env);
  if (state.state !== 'ready') {
    say('Docker is not running, so Ollama was not started. RAGForge starts anyway, but answers and indexing need Ollama (or another provider) to be available.');
    return;
  }
  const name = o.container ?? 'ragforge-ollama';
  try {
    const gpu = await detectGpu(ctx.shell);
    const action = await ensureOllamaContainer(ctx.shell, state.docker, { name, port: o.port ?? 11434, modelsDir: o.modelsDir ?? join(config.dataDir, 'ollama'), gpu }, ctx.platform, ctx.env);
    if (action !== 'already-running') say(`Started Ollama (${name}).`);
  } catch (err) {
    if (!(err instanceof DockerProblem)) throw err;
    say(`Ollama could not be started: ${err.message}`);
  }
}

export async function cmdStart(ctx: CliContext, flags: { quiet?: boolean; open?: boolean }): Promise<number> {
  const config = await requireConfig(ctx);
  if (!config) return 1;
  const say = flags.quiet ? () => {} : ctx.out;

  await ensureOllamaRunning(ctx, config, say);

  const command = ctx.serverCommand?.(config) ?? { exec: ctx.nodePath, args: [ctx.bundlePath, '__serve'], env: serverEnv(config, { webDir: ctx.webDir }), cwd: ctx.home };
  try {
    const { pid, alreadyRunning } = await startDaemon({ command, pidFile: pidFile(ctx.home), logFile: logFile(ctx.home), healthUrl: healthUrl(config), waitMs: ctx.waitMs });
    say(alreadyRunning ? `RAGForge is already running (pid ${pid}) at ${appUrl(config)}` : `RAGForge is running at ${appUrl(config)} (pid ${pid})`);
    if (flags.open) await ctx.openBrowser(appUrl(config));
    return 0;
  } catch (err) {
    if (!(err instanceof StartFailed)) throw err;
    ctx.err(err.message);
    ctx.err(`More detail: ragforge logs   (${logFile(ctx.home)})`);
    return 1;
  }
}

export async function cmdStop(ctx: CliContext, flags: { all?: boolean }): Promise<number> {
  const result = await stopDaemon({ pidFile: pidFile(ctx.home), graceMs: 10_000 });
  ctx.out(result === 'stopped' ? 'RAGForge stopped.' : 'RAGForge is not running.');

  const config = await loadCliConfig(ctx.home).catch(() => null);
  if (flags.all && config?.ollama?.mode === 'docker') {
    const state = await dockerState(ctx.shell, ctx.platform, ctx.env);
    if (state.state === 'ready') {
      await stopOllama(ctx.shell, state.docker, config.ollama.container ?? 'ragforge-ollama');
      ctx.out('Ollama stopped.');
    }
  }
  return 0;
}

export async function cmdRestart(ctx: CliContext, flags: { quiet?: boolean; open?: boolean }): Promise<number> {
  await stopDaemon({ pidFile: pidFile(ctx.home), graceMs: 10_000 });
  return cmdStart(ctx, flags);
}

const row = (label: string, value: string) => `${label.padEnd(10)} ${value}`;

export async function cmdStatus(ctx: CliContext): Promise<number> {
  const config = await requireConfig(ctx);
  if (!config) return 1;

  const daemon = await daemonStatus({ pidFile: pidFile(ctx.home), healthUrl: healthUrl(config) });
  ctx.out(row('RAGForge', daemon.running ? `running (pid ${daemon.pid}) at ${appUrl(config)}${daemon.healthy ? '' : '  (not answering yet)'}` : 'stopped'));

  const o = config.ollama;
  if (!o) {
    ctx.out(row('Ollama', 'not set up (add a provider in Settings)'));
  } else if (o.mode === 'docker') {
    const state = await dockerState(ctx.shell, ctx.platform, ctx.env);
    if (state.state !== 'ready') {
      ctx.out(row('Ollama', `in Docker (${o.container}), but Docker is not running`));
    } else {
      const inspect = await ctx.shell.run(state.docker.path, ['inspect', '-f', '{{.State.Status}}', o.container ?? 'ragforge-ollama']);
      const status = inspect.code === 0 ? inspect.stdout.trim() : 'missing';
      ctx.out(row('Ollama', `${status} in Docker (${o.container}); models: ${o.llmModel}, ${o.embeddingModel}`));
    }
  } else {
    let reachable = false;
    try {
      reachable = (await (ctx.fetchImpl ?? fetch)(`${o.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) })).ok;
    } catch {
      /* not reachable */
    }
    ctx.out(row('Ollama', `${o.baseUrl} (${reachable ? 'reachable' : 'not reachable'}); models: ${o.llmModel}, ${o.embeddingModel}`));
  }

  const auto = await serviceStatus(ctx.shell, serviceTarget(ctx)).catch(() => 'unsupported' as const);
  ctx.out(row('Autostart', auto === 'installed' ? 'on (starts when you log in)' : auto === 'unsupported' ? 'not supported on this system' : 'off (ragforge service install)'));
  ctx.out(row('Data', config.dataDir));
  ctx.out(row('Database', config.dbPath));
  return daemon.running ? 0 : 1;
}

export async function cmdLogs(ctx: CliContext, flags: { lines?: number; follow?: boolean }): Promise<number> {
  const file = logFile(ctx.home);
  const text = await tailLog(file, flags.lines ?? 50);
  if (!text && !flags.follow) {
    ctx.out('No log yet. Start RAGForge first: ragforge start');
    return 0;
  }
  if (text) ctx.out(text);
  if (!flags.follow) return 0;

  // Follow: print what is appended until the user presses Ctrl+C.
  let position = await stat(file).then((s) => s.size).catch(() => 0);
  await new Promise<void>((resolve) => {
    const timer = setInterval(async () => {
      const size = await stat(file).then((s) => s.size).catch(() => position);
      if (size < position) position = 0; // the log was replaced
      if (size > position) {
        const fh = await open(file, 'r');
        try {
          const buf = Buffer.alloc(size - position);
          await fh.read(buf, 0, buf.length, position);
          ctx.out(buf.toString('utf8').replace(/\r?\n$/, ''));
        } finally {
          await fh.close();
        }
        position = size;
      }
    }, 500);
    process.once('SIGINT', () => {
      clearInterval(timer);
      resolve();
    });
  });
  return 0;
}

export async function cmdOpen(ctx: CliContext): Promise<number> {
  const config = await requireConfig(ctx);
  if (!config) return 1;
  await ctx.openBrowser(appUrl(config));
  ctx.out(`Opening ${appUrl(config)}`);
  return 0;
}
