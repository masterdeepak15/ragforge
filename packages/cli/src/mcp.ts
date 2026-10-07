import { copyFile, mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { Shell } from './docker.js';

export class McpConfigProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConfigProblem';
  }
}

export type McpTarget = 'claude-code' | 'claude-desktop' | 'cursor';
export interface McpEntry {
  /** The name the server is registered under in the tool. */
  name: string;
  url: string;
  key: string;
}

/** Where to reach the server from this computer. Uses the address, not `localhost`, which can mean IPv6 and miss it. */
export function mcpUrl(c: { host: string; port: number }): string {
  const host = c.host === '0.0.0.0' || c.host === 'localhost' ? '127.0.0.1' : c.host;
  return `http://${host}:${c.port}/mcp`;
}

export function desktopConfigPath(platform: string, env: Record<string, string | undefined>, home: string): string {
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

export const cursorConfigPath = (home: string) => join(home, '.cursor', 'mcp.json');

/** The configuration entry for each tool. Same shapes as the snippets on the Connect page. */
export function entryFor(kind: 'claude-desktop' | 'cursor', e: McpEntry): Record<string, unknown> {
  const header = `Authorization: Bearer ${e.key}`;
  return kind === 'claude-desktop'
    ? // Claude Desktop only starts local programs, so mcp-remote bridges to the HTTP endpoint.
      { command: 'npx', args: ['-y', 'mcp-remote', e.url, '--header', header] }
    : { url: e.url, headers: { Authorization: `Bearer ${e.key}` } };
}

async function readJson(file: string): Promise<{ data: Record<string, any>; existed: boolean }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { data: {}, existed: false };
    throw err;
  }
  if (!text.trim()) return { data: {}, existed: true };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return { data: parsed, existed: true };
  } catch {
    throw new McpConfigProblem(`${file} is not valid JSON, so it was left as it is. Fix or remove that file and run this again.`);
  }
}

/** Writes through a temporary file, so an interruption never leaves a half-written configuration. */
async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n');
  await rename(temp, file);
}

async function backup(file: string): Promise<string> {
  const copy = `${file}.ragforge-backup-${Date.now()}`;
  await copyFile(file, copy);
  return copy;
}

/** Adds (or updates) the ragforge server in a tool's JSON configuration, keeping everything else in it. */
export async function addToJsonConfig(
  file: string,
  kind: 'claude-desktop' | 'cursor',
  entry: McpEntry,
  opts: { dryRun?: boolean } = {},
): Promise<{ file: string; created: boolean; backup: string | null; preview?: string }> {
  const { data, existed } = await readJson(file);
  if (data.mcpServers !== undefined && (typeof data.mcpServers !== 'object' || data.mcpServers === null || Array.isArray(data.mcpServers))) {
    throw new McpConfigProblem(`${file} has an "mcpServers" setting that is not an object, so it was left as it is.`);
  }
  const next = { ...data, mcpServers: { ...(data.mcpServers ?? {}), [entry.name]: entryFor(kind, entry) } };
  if (opts.dryRun) return { file, created: !existed, backup: null, preview: JSON.stringify(next, null, 2) };
  const saved = existed ? await backup(file) : null;
  await writeJson(file, next);
  return { file, created: !existed, backup: saved };
}

export async function removeFromJsonConfig(file: string, name = 'ragforge'): Promise<'removed' | 'not-present'> {
  const { data, existed } = await readJson(file);
  if (!existed || !data.mcpServers || !(name in data.mcpServers)) return 'not-present';
  await backup(file);
  const { [name]: _gone, ...rest } = data.mcpServers;
  await writeJson(file, { ...data, mcpServers: rest });
  return 'removed';
}

const shellQuote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/** The command to paste, for when Claude Code is not installed on this computer. */
export function claudeCodeCommand(e: McpEntry, scope: string): string {
  return `claude mcp add --transport http --scope ${scope} ${e.name} ${e.url} --header ${shellQuote(`Authorization: Bearer ${e.key}`)}`;
}

export async function addToClaudeCode(shell: Shell, e: McpEntry, opts: { scope: string }): Promise<{ done: true } | { done: false; manual: string }> {
  if ((await shell.run('claude', ['--version'], { timeoutMs: 20_000 })).code !== 0) return { done: false, manual: claudeCodeCommand(e, opts.scope) };
  await shell.run('claude', ['mcp', 'remove', '--scope', opts.scope, e.name]); // replace an earlier registration; fine if there is none
  const r = await shell.run('claude', ['mcp', 'add', '--transport', 'http', '--scope', opts.scope, e.name, e.url, '--header', `Authorization: Bearer ${e.key}`]);
  if (r.code !== 0) throw new McpConfigProblem(`Claude Code could not add the server: ${(r.stderr || r.stdout).trim()}`);
  return { done: true };
}

export async function removeFromClaudeCode(shell: Shell, name: string, scope: string): Promise<'removed' | 'not-present' | 'not-installed'> {
  if ((await shell.run('claude', ['--version'], { timeoutMs: 20_000 })).code !== 0) return 'not-installed';
  const r = await shell.run('claude', ['mcp', 'remove', '--scope', scope, name]);
  return r.code === 0 ? 'removed' : 'not-present';
}
