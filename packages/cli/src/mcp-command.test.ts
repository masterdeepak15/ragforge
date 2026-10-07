import { describe, it, expect, afterEach } from 'vitest';
import { access, readFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createClient } from '@libsql/client';
import { ApiKeyService, openAdminDb } from '@ragforge/server/admin';
import { autoPrompter } from './prompter.js';
import { sqliteUrl, type CliConfig } from './config.js';
import { cmdMcp } from './mcp-command.js';
import { runSetup } from './setup.js';
import { fail, freePort, ok, testContext, type TestContext } from './testing.js';

let t: TestContext | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});
const text = (lines: string[]) => lines.join('\n');

/** A set-up install: configuration and a real database, without any local AI. */
async function installed(replies: Record<string, any> = {}): Promise<{ t: TestContext; config: CliConfig }> {
  const ctx = await testContext({ replies });
  const { config } = await runSetup({ home: ctx.ctx.home, prompter: autoPrompter(), shell: ctx.ctx.shell, out: () => {}, platform: 'linux', env: {}, flags: { yes: true, ollama: 'none', port: await freePort() } });
  return { t: ctx, config };
}

async function withDb<T>(config: CliConfig, fn: (db: Awaited<ReturnType<typeof openAdminDb>>) => Promise<T>): Promise<T> {
  const db = await openAdminDb({ sqliteUrl: sqliteUrl(config.dbPath) });
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}
const apiKeyRows = (config: CliConfig) => withDb(config, async (db) => (await db.client.execute('SELECT name, scope_kb_ids, revoked_at FROM api_keys')).rows as any[]);
const addKb = (config: CliConfig, name: string) =>
  withDb(config, async (db) => {
    const id = randomUUID();
    await db.client.execute({ sql: 'INSERT INTO knowledge_bases (id, name) VALUES (?, ?)', args: [id, name] });
    return id;
  });

const desktopFile = (ctx: TestContext) => join(ctx.ctx.userHome, '.config', 'Claude', 'claude_desktop_config.json');
const keyIn = (entry: any): string => entry.args.find((a: string) => a.startsWith('Authorization: Bearer ')).replace('Authorization: Bearer ', '');

describe('mcp add claude-desktop', () => {
  it('connects Claude Desktop with a key that works', async () => {
    const x = await installed();
    t = x.t;
    expect(await cmdMcp(t.ctx, ['add', 'claude-desktop'], {})).toBe(0);

    const entry = JSON.parse(await readFile(desktopFile(t), 'utf8')).mcpServers.ragforge;
    expect(entry.command).toBe('npx');
    expect(entry.args).toContain(`http://127.0.0.1:${x.config.port}/mcp`);
    const verified = await withDb(x.config, (db) => new ApiKeyService(db).verify(keyIn(entry)));
    expect(verified).toEqual({ id: expect.any(String), scopeKbIds: null });
    expect(text(t.out)).toMatch(/Restart Claude Desktop/);
  });

  it('keeps the tool\'s other settings and tells the user where the backup is', async () => {
    const x = await installed();
    t = x.t;
    const { mkdir, writeFile } = await import('fs/promises');
    await mkdir(join(t.ctx.userHome, '.config', 'Claude'), { recursive: true });
    await writeFile(desktopFile(t), JSON.stringify({ theme: 'dark', mcpServers: { github: { command: 'gh' } } }));
    await cmdMcp(t.ctx, ['add', 'claude-desktop'], {});
    const after = JSON.parse(await readFile(desktopFile(t), 'utf8'));
    expect(after.theme).toBe('dark');
    expect(after.mcpServers.github).toEqual({ command: 'gh' });
    expect(text(t.out)).toMatch(/backup/i);
  });

  it('refuses to touch a configuration it cannot read', async () => {
    const x = await installed();
    t = x.t;
    const { mkdir, writeFile } = await import('fs/promises');
    await mkdir(join(t.ctx.userHome, '.config', 'Claude'), { recursive: true });
    await writeFile(desktopFile(t), '{ broken');
    expect(await cmdMcp(t.ctx, ['add', 'claude-desktop'], {})).toBe(1);
    expect(text(t.err)).toMatch(/not valid JSON/);
    expect(await readFile(desktopFile(t), 'utf8')).toBe('{ broken');
  });
});

describe('mcp add claude-code', () => {
  it('registers the server through the claude command, for the whole user by default', async () => {
    const x = await installed({ 'claude --version': ok('2.1.0'), 'claude mcp remove': fail('none'), 'claude mcp add': ok('Added') });
    t = x.t;
    expect(await cmdMcp(t.ctx, ['add', 'claude-code'], {})).toBe(0);
    const add = t.shell.calls.find((c) => c.args[1] === 'add')!.args;
    expect(add.slice(0, 6)).toEqual(['mcp', 'add', '--transport', 'http', '--scope', 'user']);
    expect(add).toContain(`http://127.0.0.1:${x.config.port}/mcp`);
    expect(add[add.indexOf('--header') + 1]).toMatch(/^Authorization: Bearer rf_/);
  });

  it('can register it for one project only', async () => {
    const x = await installed({ 'claude --version': ok('2.1.0'), 'claude mcp remove': ok(), 'claude mcp add': ok() });
    t = x.t;
    await cmdMcp(t.ctx, ['add', 'claude-code'], { scope: 'project' });
    expect(t.shell.calls.find((c) => c.args[1] === 'add')!.args).toContain('project');
  });

  it('gives the exact command to run when Claude Code is not installed', async () => {
    const x = await installed();
    t = x.t;
    expect(await cmdMcp(t.ctx, ['add', 'claude-code'], {})).toBe(0);
    expect(text(t.out)).toMatch(/Claude Code was not found/);
    expect(text(t.out)).toMatch(/claude mcp add --transport http --scope user ragforge http:\/\/127\.0\.0\.1:\d+\/mcp --header/);
  });

  it('rejects a scope that Claude Code does not have', async () => {
    const x = await installed();
    t = x.t;
    expect(await cmdMcp(t.ctx, ['add', 'claude-code'], { scope: 'galaxy' })).toBe(2);
    expect(text(t.err)).toMatch(/--scope must be/);
  });
});

describe('mcp add cursor', () => {
  it('writes Cursor\'s configuration', async () => {
    const x = await installed();
    t = x.t;
    await cmdMcp(t.ctx, ['add', 'cursor'], {});
    const entry = JSON.parse(await readFile(join(t.ctx.userHome, '.cursor', 'mcp.json'), 'utf8')).mcpServers.ragforge;
    expect(entry.url).toBe(`http://127.0.0.1:${x.config.port}/mcp`);
    expect(entry.headers.Authorization).toMatch(/^Bearer rf_/);
  });
});

describe('limiting a key to some knowledge bases', () => {
  it('scopes the key to the named knowledge base', async () => {
    const x = await installed();
    t = x.t;
    const id = await addKb(x.config, 'Handbook');
    await addKb(x.config, 'Secrets');
    expect(await cmdMcp(t.ctx, ['add', 'cursor'], { kb: 'handbook' })).toBe(0); // names are not case sensitive
    expect(JSON.parse((await apiKeyRows(x.config))[0].scope_kb_ids)).toEqual([id]);
  });

  it('refuses an unknown knowledge base, lists the real ones, and creates no key', async () => {
    const x = await installed();
    t = x.t;
    await addKb(x.config, 'Handbook');
    expect(await cmdMcp(t.ctx, ['add', 'cursor'], { kb: 'Nope' })).toBe(1);
    expect(text(t.err)).toMatch(/No knowledge base named "Nope".*Handbook/s);
    expect(await apiKeyRows(x.config)).toEqual([]);
  });
});

describe('re-running and previewing', () => {
  it('replaces the old key when run again', async () => {
    const x = await installed();
    t = x.t;
    await cmdMcp(t.ctx, ['add', 'claude-desktop'], {});
    const first = keyIn(JSON.parse(await readFile(desktopFile(t), 'utf8')).mcpServers.ragforge);
    await cmdMcp(t.ctx, ['add', 'claude-desktop'], {});
    const second = keyIn(JSON.parse(await readFile(desktopFile(t), 'utf8')).mcpServers.ragforge);
    expect(second).not.toBe(first);
    await withDb(x.config, async (db) => {
      expect(await new ApiKeyService(db).verify(first)).toBeNull();
      expect(await new ApiKeyService(db).verify(second)).not.toBeNull();
    });
  });

  it('changes nothing on a dry run, and shows a placeholder instead of a real key', async () => {
    const x = await installed();
    t = x.t;
    expect(await cmdMcp(t.ctx, ['add', 'claude-desktop'], { dryRun: true })).toBe(0);
    expect(await apiKeyRows(x.config)).toEqual([]);
    await expect(access(desktopFile(t))).rejects.toThrow();
    expect(text(t.out)).toContain('<your-api-key>');
    expect(text(t.out)).not.toMatch(/rf_[A-Za-z0-9_-]{20}/);
  });

  it('mentions how to start RAGForge when it is not running', async () => {
    const x = await installed();
    t = x.t;
    await cmdMcp(t.ctx, ['add', 'cursor'], {});
    expect(text(t.out)).toMatch(/RAGForge is not running.*ragforge start/s);
  });
});

describe('mcp snippet', () => {
  it('prints what to paste, without creating a key', async () => {
    const x = await installed();
    t = x.t;
    expect(await cmdMcp(t.ctx, ['snippet', 'cursor'], {})).toBe(0);
    expect(text(t.out)).toContain('<your-api-key>');
    expect(await apiKeyRows(x.config)).toEqual([]);
  });
});

describe('mcp remove', () => {
  it('removes the entry from Claude Desktop and revokes nothing else', async () => {
    const x = await installed();
    t = x.t;
    await cmdMcp(t.ctx, ['add', 'claude-desktop'], {});
    expect(await cmdMcp(t.ctx, ['remove', 'claude-desktop'], {})).toBe(0);
    expect(JSON.parse(await readFile(desktopFile(t), 'utf8')).mcpServers).toEqual({});
  });

  it('removes the registration from Claude Code', async () => {
    const x = await installed({ 'claude --version': ok('2.1.0'), 'claude mcp remove': ok('Removed') });
    t = x.t;
    expect(await cmdMcp(t.ctx, ['remove', 'claude-code'], {})).toBe(0);
    expect(t.shell.calls.some((c) => c.args.join(' ') === 'mcp remove --scope user ragforge')).toBe(true);
  });
});

describe('usage', () => {
  it('explains the command for an unknown action or tool', async () => {
    const x = await installed();
    t = x.t;
    expect(await cmdMcp(t.ctx, ['add', 'notepad'], {})).toBe(2);
    expect(text(t.err)).toMatch(/claude-code.*claude-desktop.*cursor/s);
    expect(await cmdMcp(t.ctx, [], {})).toBe(2);
  });

  it('needs setup first', async () => {
    t = await testContext();
    expect(await cmdMcp(t.ctx, ['add', 'cursor'], {})).toBe(1);
    expect(text(t.err)).toMatch(/ragforge setup/);
  });
});

void createClient;
