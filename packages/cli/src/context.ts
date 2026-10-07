import { join } from 'path';
import { loadCliConfig, type CliConfig } from './config.js';
import type { Shell } from './docker.js';
import type { Prompter } from './prompter.js';
import type { DaemonCommand } from './runtime.js';

/** Everything a command needs from the outside world. Real values in production; fakes in tests. */
export interface CliContext {
  /** RAGForge's settings folder (default ~/.ragforge). */
  home: string;
  userHome: string;
  env: Record<string, string | undefined>;
  platform: string;
  out: (line: string) => void;
  err: (line: string) => void;
  shell: Shell;
  prompter: Prompter;
  /** The node program and the RAGForge program file used to run the server in the background. */
  nodePath: string;
  bundlePath: string;
  /** The built web app. */
  webDir: string;
  /** Replaces how the server process is launched (tests). */
  serverCommand?: (config: CliConfig) => DaemonCommand;
  ramGb?: number;
  fetchImpl?: typeof fetch;
  openBrowser: (url: string) => Promise<void>;
  /** How long `start` waits for the server to answer. */
  waitMs?: number;
  uid?: number;
  version: string;
}

export const pidFile = (home: string) => join(home, 'ragforge.pid');
export const logFile = (home: string) => join(home, 'ragforge.log');
export const appUrl = (c: Pick<CliConfig, 'port'>) => `http://localhost:${c.port}`;
export const healthUrl = (c: Pick<CliConfig, 'port'>) => `http://127.0.0.1:${c.port}/api/health`;

/** The saved configuration, or a message telling the user to run setup. */
export async function requireConfig(ctx: CliContext): Promise<CliConfig | null> {
  try {
    const config = await loadCliConfig(ctx.home);
    if (config) return config;
    ctx.err('RAGForge is not set up yet. Run `ragforge setup` first.');
  } catch (err) {
    ctx.err((err as Error).message);
  }
  return null;
}
