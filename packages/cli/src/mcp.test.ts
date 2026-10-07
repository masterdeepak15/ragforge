import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { McpConfigProblem, addToClaudeCode, addToJsonConfig, cursorConfigPath, desktopConfigPath, entryFor, mcpUrl, removeFromJsonConfig, removeFromClaudeCode } from './mcp.js';
import { fail, fakeShell, ok } from './testing.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ragforge-mcp-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const entry = { name: 'ragforge', url: 'http://127.0.0.1:8080/mcp', key: 'rf_secretkey' };
const json = async (p: string) => JSON.parse(await readFile(p, 'utf8'));

describe('mcpUrl', () => {
  it('points at this computer, by address rather than by name, so it never resolves to the wrong one', () => {
    expect(mcpUrl({ host: '127.0.0.1', port: 8080 })).toBe('http://127.0.0.1:8080/mcp');
    expect(mcpUrl({ host: '0.0.0.0', port: 9000 })).toBe('http://127.0.0.1:9000/mcp');
  });
});

describe('where each tool keeps its configuration', () => {
  it('finds Claude Desktop on every system', () => {
    expect(desktopConfigPath('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me')).toBe(join('C:\\Users\\me\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
    expect(desktopConfigPath('darwin', {}, '/Users/me')).toBe(join('/Users/me', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    expect(desktopConfigPath('linux', {}, '/home/me')).toBe(join('/home/me', '.config', 'Claude', 'claude_desktop_config.json'));
    expect(desktopConfigPath('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/me')).toBe(join('/cfg', 'Claude', 'claude_desktop_config.json'));
  });
  it('finds Cursor', () => {
    expect(cursorConfigPath('/home/me')).toBe(join('/home/me', '.cursor', 'mcp.json'));
  });
});

describe('entryFor', () => {
  it('uses mcp-remote for Claude Desktop, which can only start local programs', () => {
    expect(entryFor('claude-desktop', entry)).toEqual({ command: 'npx', args: ['-y', 'mcp-remote', entry.url, '--header', 'Authorization: Bearer rf_secretkey'] });
  });
  it('uses the URL directly for Cursor', () => {
    expect(entryFor('cursor', entry)).toEqual({ url: entry.url, headers: { Authorization: 'Bearer rf_secretkey' } });
  });
});

describe('addToJsonConfig', () => {
  it('creates the file, and the folders above it, when the tool has none yet', async () => {
    const file = join(dir, 'Claude', 'claude_desktop_config.json');
    const result = await addToJsonConfig(file, 'claude-desktop', entry);
    expect(result).toEqual({ file, created: true, backup: null });
    expect((await json(file)).mcpServers.ragforge).toEqual(entryFor('claude-desktop', entry));
  });

  it('keeps everything else in the file, including other MCP servers', async () => {
    const file = join(dir, 'config.json');
    await writeFile(file, JSON.stringify({ theme: 'dark', mcpServers: { github: { command: 'gh-mcp' } } }));
    await addToJsonConfig(file, 'claude-desktop', entry);
    const after = await json(file);
    expect(after.theme).toBe('dark');
    expect(after.mcpServers.github).toEqual({ command: 'gh-mcp' });
    expect(after.mcpServers.ragforge).toBeDefined();
  });

  it('keeps a copy of the original before changing it', async () => {
    const file = join(dir, 'config.json');
    const original = JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } });
    await writeFile(file, original);
    const result = await addToJsonConfig(file, 'cursor', entry);
    expect(result.backup).toMatch(/config\.json\.ragforge-backup-/);
    expect(await readFile(result.backup!, 'utf8')).toBe(original);
  });

  it('updates an existing ragforge entry instead of adding a second one', async () => {
    const file = join(dir, 'config.json');
    await addToJsonConfig(file, 'cursor', entry);
    await addToJsonConfig(file, 'cursor', { ...entry, key: 'rf_newkey' });
    const after = await json(file);
    expect(Object.keys(after.mcpServers)).toEqual(['ragforge']);
    expect(after.mcpServers.ragforge.headers.Authorization).toBe('Bearer rf_newkey');
  });

  it('refuses to overwrite a file it cannot read, and leaves it untouched', async () => {
    const file = join(dir, 'config.json');
    await writeFile(file, '{ "mcpServers": { oops');
    await expect(addToJsonConfig(file, 'cursor', entry)).rejects.toThrow(McpConfigProblem);
    await expect(addToJsonConfig(file, 'cursor', entry)).rejects.toThrow(/not valid JSON/);
    expect(await readFile(file, 'utf8')).toBe('{ "mcpServers": { oops');
    expect((await readdir(dir)).filter((f) => f.includes('backup'))).toEqual([]);
  });

  it('shows what it would do without touching anything on a dry run', async () => {
    const file = join(dir, 'config.json');
    const result = await addToJsonConfig(file, 'cursor', entry, { dryRun: true });
    expect(result.preview).toContain('"ragforge"');
    expect(await readdir(dir)).toEqual([]);
  });

  it('writes a readable file', async () => {
    const file = join(dir, 'config.json');
    await addToJsonConfig(file, 'cursor', entry);
    expect(await readFile(file, 'utf8')).toMatch(/\n {2}"mcpServers"/);
  });
});

describe('removeFromJsonConfig', () => {
  it('removes only the ragforge entry', async () => {
    const file = join(dir, 'config.json');
    await writeFile(file, JSON.stringify({ mcpServers: { github: { command: 'x' }, ragforge: { url: 'u' } } }));
    expect(await removeFromJsonConfig(file)).toBe('removed');
    expect((await json(file)).mcpServers).toEqual({ github: { command: 'x' } });
  });
  it('says when there is nothing to remove', async () => {
    expect(await removeFromJsonConfig(join(dir, 'missing.json'))).toBe('not-present');
    const file = join(dir, 'other.json');
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify({ mcpServers: {} }));
    expect(await removeFromJsonConfig(file)).toBe('not-present');
  });
});

describe('Claude Code', () => {
  it('registers the server with the claude command', async () => {
    const { shell, calls } = fakeShell({ 'claude --version': ok('2.1.0'), 'claude mcp remove': fail('No MCP server found'), 'claude mcp add': ok('Added') });
    const result = await addToClaudeCode(shell, entry, { scope: 'user' });
    expect(result).toEqual({ done: true });
    const add = calls.find((c) => c.args[1] === 'add')!.args;
    expect(add).toEqual(['mcp', 'add', '--transport', 'http', '--scope', 'user', 'ragforge', 'http://127.0.0.1:8080/mcp', '--header', 'Authorization: Bearer rf_secretkey']);
  });

  it('replaces an earlier registration so running it again is safe', async () => {
    const { shell, calls } = fakeShell({ 'claude --version': ok('2.1.0'), 'claude mcp remove': ok('Removed'), 'claude mcp add': ok('Added') });
    await addToClaudeCode(shell, entry, { scope: 'user' });
    const order = calls.map((c) => c.args.slice(0, 2).join(' '));
    expect(order.indexOf('mcp remove')).toBeLessThan(order.indexOf('mcp add'));
  });

  it('hands over the exact command when Claude Code is not installed', async () => {
    const { shell } = fakeShell({});
    const result = await addToClaudeCode(shell, entry, { scope: 'user' });
    expect(result).toMatchObject({ done: false });
    expect((result as any).manual).toContain('claude mcp add --transport http --scope user ragforge http://127.0.0.1:8080/mcp');
  });

  it('reports what the claude command said when it fails', async () => {
    const { shell } = fakeShell({ 'claude --version': ok('2.1.0'), 'claude mcp remove': ok(), 'claude mcp add': fail('Invalid scope') });
    await expect(addToClaudeCode(shell, entry, { scope: 'user' })).rejects.toThrow(/Invalid scope/);
  });

  it('removes the registration', async () => {
    const { shell, calls } = fakeShell({ 'claude --version': ok('2.1.0'), 'claude mcp remove': ok('Removed') });
    expect(await removeFromClaudeCode(shell, 'ragforge', 'user')).toBe('removed');
    expect(calls.find((c) => c.args[1] === 'remove')!.args).toEqual(['mcp', 'remove', '--scope', 'user', 'ragforge']);
  });
});
