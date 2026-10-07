/** Helpers for tests only. Nothing in the shipped program imports this file. */
import type { Choice, Prompter } from './prompter.js';
import type { RunResult, Shell } from './docker.js';

/** Answers questions by matching their text; anything unmatched gets its default. Remembers every question asked. */
export function scriptedPrompter(rules: Array<[RegExp, string | boolean]> = []) {
  const asked: string[] = [];
  const answer = (question: string): string | boolean | undefined => rules.find(([re]) => re.test(question))?.[1];
  const prompter: Prompter = {
    async select<T extends string>(question: string, choices: Choice<T>[], defaultValue: T) {
      asked.push(question);
      const a = answer(question);
      if (a === undefined) return defaultValue;
      if (!choices.some((c) => c.value === a)) throw new Error(`Test script answered "${a}" to "${question}", which is not a choice`);
      return a as T;
    },
    async confirm(question, defaultValue) {
      asked.push(question);
      const a = answer(question);
      return typeof a === 'boolean' ? a : defaultValue;
    },
    async text(question, defaultValue) {
      asked.push(question);
      const a = answer(question);
      return typeof a === 'string' ? a : defaultValue;
    },
  };
  return { prompter, asked };
}

export type ShellReply = RunResult | ((args: string[]) => RunResult);
export const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
export const fail = (stderr = 'failed', code = 1): RunResult => ({ code, stdout: '', stderr });

/** A shell that answers from a table keyed by "command arg arg" (longest match wins) and records every call. */
export function fakeShell(replies: Record<string, ShellReply>) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const lookup = (cmd: string, args: string[]): RunResult => {
    const key = [cmd, ...args].join(' ');
    const hits = Object.entries(replies).filter(([k]) => key === k || key.startsWith(k + ' '));
    if (hits.length === 0) return fail(`not found: ${cmd}`, 127);
    const reply = hits.sort((a, b) => b[0].length - a[0].length)[0][1];
    return typeof reply === 'function' ? reply(args) : reply;
  };
  const shell: Shell = {
    async run(cmd, args) {
      calls.push({ cmd, args });
      return lookup(cmd, args);
    },
    async runLive(cmd, args) {
      calls.push({ cmd, args });
      return lookup(cmd, args).code;
    },
  };
  return { shell, calls, has: (...words: string[]) => calls.some((c) => words.every((w) => [c.cmd, ...c.args].join(' ').includes(w))) };
}

// ---- a complete fake CliContext for command tests ----
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateSecrets, saveCliConfig, type CliConfig } from './config.js';
import type { CliContext } from './context.js';

export const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as any).port;
      s.close(() => resolve(p));
    });
  });

const FAKE_SERVER = `
  import { createServer } from 'http';
  createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"status":"ok"}'); }).listen(Number(process.env.PORT), '127.0.0.1');
  console.log('fake server listening on ' + process.env.PORT);
  process.on('SIGTERM', () => process.exit(0));
`;

export interface TestContext {
  ctx: CliContext;
  root: string;
  out: string[];
  err: string[];
  opened: string[];
  shell: ReturnType<typeof fakeShell>;
  /** Writes a valid configuration (and returns it). */
  configure(over?: Partial<CliConfig>): Promise<CliConfig>;
  cleanup(): Promise<void>;
}

export async function testContext(opts: { replies?: Record<string, ShellReply>; platform?: string; prompter?: Prompter; ctx?: Partial<CliContext> } = {}): Promise<TestContext> {
  const root = await mkdtemp(join(tmpdir(), 'ragforge-cli-'));
  const home = join(root, '.ragforge');
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const shell = fakeShell(opts.replies ?? {});
  const script = join(root, 'fake-server.mjs');
  await writeFile(script, FAKE_SERVER);

  const ctx: CliContext = {
    home,
    userHome: join(root, 'user'),
    env: { APPDATA: join(root, 'appdata') },
    platform: opts.platform ?? 'linux',
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    shell: shell.shell,
    prompter: opts.prompter ?? scriptedPrompter().prompter,
    nodePath: process.execPath,
    bundlePath: join(root, 'ragforge.mjs'),
    webDir: join(root, 'web'),
    serverCommand: (config) => ({ exec: process.execPath, args: [script], env: { PORT: String(config.port) } }),
    ramGb: 16,
    fetchImpl: (async () => new Response(JSON.stringify({ models: [] }))) as unknown as typeof fetch,
    openBrowser: async (url) => void opened.push(url),
    waitMs: 10_000,
    uid: 501,
    version: '1.0.0',
    ...opts.ctx,
  };

  return {
    ctx,
    root,
    out,
    err,
    opened,
    shell,
    async configure(over = {}) {
      const port = await freePort();
      const config: CliConfig = {
        version: 1,
        host: '127.0.0.1',
        port,
        dataDir: join(root, 'data'),
        dbPath: join(root, 'data', 'ragforge.db'),
        secrets: generateSecrets(),
        ...over,
      };
      await saveCliConfig(home, config);
      return config;
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}
