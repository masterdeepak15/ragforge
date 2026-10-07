import { access, rm, rmdir } from 'fs/promises';
import { join, parse, resolve, sep } from 'path';
import { ConfigProblem, DATA_MARKER, loadCliConfig, type CliConfig } from './config.js';
import { logFile, pidFile, type CliContext } from './context.js';
import { dockerState, removeOllama } from './docker.js';
import { serviceTarget } from './lifecycle.js';
import { stopDaemon } from './runtime.js';
import { uninstallService } from './service.js';

const exists = (p: string) => access(p).then(() => true, () => false);
const DB_SUFFIXES = ['', '-wal', '-shm', '-journal'];

/** Why the data folder must not be deleted, or null when it is safe. */
async function dataProblem(ctx: CliContext, config: CliConfig): Promise<string | null> {
  const dir = resolve(config.dataDir);
  const home = resolve(ctx.userHome);
  if (dir === parse(dir).root || dir === home || home.startsWith(dir + sep)) {
    return `The data folder ${config.dataDir} is your home folder or contains it, which is too broad to delete. Nothing was removed.`;
  }
  if (!(await exists(join(dir, DATA_MARKER)))) {
    return `The data folder ${config.dataDir} was not created by RAGForge (it has no ${DATA_MARKER} marker), so it was left untouched. Delete it yourself if you are sure.`;
  }
  return null;
}

/** Files outside the data folder that belong to RAGForge: the database, if it lives elsewhere. */
async function databaseFilesOutside(config: CliConfig): Promise<string[]> {
  const dataDir = resolve(config.dataDir);
  const db = resolve(config.dbPath);
  if (db.startsWith(dataDir + sep)) return [];
  const found: string[] = [];
  for (const suffix of DB_SUFFIXES) if (await exists(db + suffix)) found.push(db + suffix);
  return found;
}

export async function cmdUninstall(ctx: CliContext, flags: { data?: boolean; yes?: boolean }): Promise<number> {
  let config: CliConfig | null = null;
  try {
    config = await loadCliConfig(ctx.home);
  } catch (err) {
    if (!(err instanceof ConfigProblem)) throw err;
    ctx.err(err.message);
  }

  // Everything that could stop us from deleting data is checked, and the user is asked, before anything changes.
  let outsideFiles: string[] = [];
  if (flags.data && config) {
    const problem = await dataProblem(ctx, config);
    if (problem) {
      ctx.err(problem);
      return 1;
    }
    outsideFiles = await databaseFilesOutside(config);
    if (!flags.yes) {
      ctx.out('This permanently deletes:');
      ctx.out(`  - ${config.dataDir}   (uploaded files, Ollama models stored there)`);
      for (const f of outsideFiles) ctx.out(`  - ${f}`);
      ctx.out(`  - ${join(ctx.home, 'config.json')}   (settings and secrets)`);
      ctx.out('This cannot be undone.');
      const answer = await ctx.prompter.text('Type "delete" to confirm', '');
      if (answer.trim() !== 'delete') {
        ctx.out('Nothing was deleted.');
        return 1;
      }
    }
  }

  await stopDaemon({ pidFile: pidFile(ctx.home), graceMs: 10_000 });
  await uninstallService(ctx.shell, serviceTarget(ctx)).catch(() => 'not-installed'); // not supported or not installed: nothing to undo
  if (config?.ollama?.mode === 'docker') {
    const state = await dockerState(ctx.shell, ctx.platform, ctx.env);
    if (state.state === 'ready') await removeOllama(ctx.shell, state.docker, config.ollama.container ?? 'ragforge-ollama');
  }
  await rm(logFile(ctx.home), { force: true });
  await rm(join(ctx.home, 'autostart.log'), { force: true });

  if (!config) {
    ctx.out('Nothing is set up, so there is nothing to remove.');
    return 0;
  }

  if (!flags.data) {
    ctx.out('RAGForge was stopped and will no longer start by itself.');
    ctx.out('\nYour data was kept:');
    ctx.out(`  Data      ${config.dataDir}`);
    ctx.out(`  Database  ${config.dbPath}`);
    ctx.out(`  Settings  ${join(ctx.home, 'config.json')}`);
    ctx.out('\nDelete all of it too:  ragforge uninstall --data');
    ctx.out('Remove the program:   npm uninstall -g @masterdeepak15/ragforge');
    return 0;
  }

  await rm(config.dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  for (const f of outsideFiles) await rm(f, { force: true });
  await rm(join(ctx.home, 'config.json'), { force: true });
  await rmdir(ctx.home).catch(() => {
    /* not empty: something else lives there, so leave it */
  });

  ctx.out('Deleted your RAGForge data and settings.');
  const modelsDir = config.ollama?.modelsDir;
  if (modelsDir && !resolve(modelsDir).startsWith(resolve(config.dataDir) + sep)) {
    ctx.out(`Ollama models stored outside the data folder were left in place: ${modelsDir}`);
  }
  ctx.out('\nRemove the program:   npm uninstall -g @masterdeepak15/ragforge');
  return 0;
}
