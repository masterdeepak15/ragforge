import { access, mkdir, rm, writeFile } from 'fs/promises';
import { createServer } from 'net';
import { join } from 'path';
import { ConfigProblem, DATA_MARKER, loadCliConfig, type CliConfig } from './config.js';
import { healthUrl, pidFile, type CliContext } from './context.js';
import { dockerState, installedModels } from './docker.js';
import { serviceTarget } from './lifecycle.js';
import { daemonStatus } from './runtime.js';
import { serviceStatus } from './service.js';

const exists = (p: string) => access(p).then(() => true, () => false);
const OK = '[ok]';
const WARN = '[!!]';
const BAD = '[x]';

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** Checks everything RAGForge depends on and says what to do about each problem. Returns 1 if anything is broken. */
export async function cmdDoctor(ctx: CliContext): Promise<number> {
  let failures = 0;
  const line = (mark: string, text: string) => {
    if (mark === BAD) failures++;
    ctx.out(`${mark} ${text}`);
  };

  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 20 ? OK : BAD, major >= 20 ? `Node.js ${process.versions.node}` : `Node.js ${process.versions.node} is too old; RAGForge needs 20 or newer (https://nodejs.org)`);

  let config: CliConfig | null = null;
  try {
    config = await loadCliConfig(ctx.home);
  } catch (err) {
    if (!(err instanceof ConfigProblem)) throw err;
    line(BAD, `Settings: ${err.message}`);
    return 1;
  }
  if (!config) {
    line(BAD, 'Settings: RAGForge is not set up yet. Run `ragforge setup`.');
    return 1;
  }
  line(OK, `Settings (${join(ctx.home, 'config.json')})`);

  // Data and database
  if (!(await exists(config.dataDir))) line(BAD, `Data folder ${config.dataDir} does not exist. Run \`ragforge setup\` again.`);
  else {
    try {
      const probe = join(config.dataDir, `.write-test-${process.pid}`);
      await writeFile(probe, '');
      await rm(probe, { force: true });
      line((await exists(join(config.dataDir, DATA_MARKER))) ? OK : WARN, (await exists(join(config.dataDir, DATA_MARKER))) ? `Data folder ${config.dataDir}` : `Data folder ${config.dataDir} was not created by RAGForge (no ${DATA_MARKER} marker), so \`uninstall --data\` will refuse to delete it`);
    } catch {
      line(BAD, `Data folder ${config.dataDir} is not writable`);
    }
  }
  line((await exists(config.dbPath)) ? OK : WARN, (await exists(config.dbPath)) ? `Database ${config.dbPath}` : `Database ${config.dbPath} does not exist yet (it is created when RAGForge first starts)`);

  // The server and its port
  const daemon = await daemonStatus({ pidFile: pidFile(ctx.home), healthUrl: healthUrl(config) });
  if (daemon.running) {
    line(daemon.healthy ? OK : WARN, daemon.healthy ? `RAGForge is running (pid ${daemon.pid}) on port ${config.port}` : `RAGForge is running (pid ${daemon.pid}) but not answering yet. Check: ragforge logs`);
  } else {
    if (await portFree(config.port)) line(OK, `Port ${config.port} is free`);
    else line(BAD, `Port ${config.port} is used by another program. Choose another with \`ragforge setup\`.`);
    line(WARN, 'RAGForge is not running. Start it with: ragforge start');
  }

  // Local AI
  const o = config.ollama;
  if (!o) {
    line(WARN, 'No local AI was set up. Add an AI provider in RAGForge under Settings before uploading documents.');
  } else {
    if (o.mode === 'docker') {
      const state = await dockerState(ctx.shell, ctx.platform, ctx.env);
      if (state.state === 'not-installed') line(BAD, 'Docker is not installed, but Ollama is set up to run in it. Get Docker at https://docs.docker.com/get-docker/');
      else if (state.state === 'daemon-stopped') line(BAD, 'Docker is not running, but Ollama is set up to run in it. Start Docker Desktop (or the Docker service).');
      else line(OK, `Docker ${state.version}`);
    }
    try {
      const have = await installedModels(o.baseUrl, ctx.fetchImpl);
      const hasModel = (m: string) => have.includes(m) || (!m.includes(':') && have.includes(`${m}:latest`));
      const missing = [o.embeddingModel, o.llmModel].filter((m) => !hasModel(m));
      if (missing.length === 0) line(OK, `Ollama answers at ${o.baseUrl} with ${o.llmModel} and ${o.embeddingModel}`);
      else line(BAD, `Ollama answers at ${o.baseUrl} but is missing model(s): ${missing.join(', ')}. Download with: ${missing.map((m) => `ollama pull ${m}`).join(' ; ')}${o.mode === 'docker' ? `  (inside Docker: docker exec ${o.container} ollama pull ...)` : ''}`);
    } catch {
      line(BAD, `Ollama does not answer at ${o.baseUrl}. ${o.mode === 'docker' ? 'Start it with: ragforge start' : 'Start your Ollama.'}`);
    }
  }

  const auto = await serviceStatus(ctx.shell, serviceTarget(ctx)).catch(() => 'unsupported' as const);
  if (auto === 'installed') line(OK, 'Starts automatically when you log in');
  else if (auto === 'not-installed') line(OK, 'Autostart is off (turn on with: ragforge service install)');

  ctx.out(failures === 0 ? '\nNo problems found.' : `\n${failures} problem${failures === 1 ? '' : 's'} found.`);
  void mkdir;
  return failures === 0 ? 0 : 1;
}
