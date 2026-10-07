import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { homedir, totalmem } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { runCli } from './cli.js';
import { homeDir } from './config.js';
import type { CliContext } from './context.js';
import { realShell } from './docker.js';
import { readlinePrompter, type Prompter } from './prompter.js';

const bundlePath = fileURLToPath(import.meta.url);

function version(): string {
  try {
    return JSON.parse(readFileSync(join(dirname(bundlePath), '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

/** Creates the terminal reader only when a question is actually asked, so commands without questions exit at once. */
function lazyPrompter(): Prompter {
  let real: Prompter | undefined;
  const get = () => (real ??= readlinePrompter());
  return {
    select: (q, c, d) => get().select(q, c, d),
    confirm: (q, d) => get().confirm(q, d),
    text: (q, d, v) => get().text(q, d, v),
    close: () => real?.close?.(),
  };
}

async function openBrowser(url: string): Promise<void> {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  } catch {
    /* printing the address is enough */
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // The server itself: started in the background by `ragforge start`.
  if (argv[0] === '__serve') {
    const { startServer } = await import('@ragforge/server');
    await startServer();
    return;
  }

  const ctx: CliContext = {
    home: homeDir(process.env),
    userHome: homedir(),
    env: process.env,
    platform: process.platform,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    shell: realShell,
    prompter: lazyPrompter(),
    nodePath: process.execPath,
    bundlePath,
    webDir: process.env.RAGFORGE_WEB_DIR || join(dirname(bundlePath), 'web'),
    ramGb: totalmem() / 1024 ** 3,
    openBrowser,
    uid: process.getuid?.(),
    version: version(),
  };
  process.exitCode = await runCli(argv, ctx);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
