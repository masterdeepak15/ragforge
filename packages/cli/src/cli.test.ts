import { describe, it, expect, afterEach } from 'vitest';
import { access, readFile } from 'fs/promises';
import { join } from 'path';
import { HELP, runCli } from './cli.js';
import { healthUrl, pidFile } from './context.js';
import { daemonStatus, stopDaemon } from './runtime.js';
import { loadCliConfig } from './config.js';
import { fail, freePort, ok, testContext, type TestContext } from './testing.js';

let t: TestContext | undefined;
afterEach(async () => {
  if (t) {
    await stopDaemon({ pidFile: pidFile(t.ctx.home), graceMs: 2000 }).catch(() => {});
    await t.cleanup();
    t = undefined;
  }
});
const text = (lines: string[]) => lines.join('\n');
const exists = (p: string) => access(p).then(() => true, () => false);

describe('help and version', () => {
  it('lists every command', async () => {
    t = await testContext();
    expect(await runCli([], t.ctx)).toBe(0);
    for (const word of ['setup', 'start', 'stop', 'restart', 'status', 'logs', 'doctor', 'mcp add', 'service install', 'uninstall --data']) expect(text(t.out)).toContain(word);
    expect(text(t.out)).toBe(HELP);
  });

  it.each([['--version'], ['version'], ['-v']])('prints the version for %s', async (flag) => {
    t = await testContext();
    expect(await runCli([flag], t.ctx)).toBe(0);
    expect(t.out).toEqual(['1.0.0']);
  });

  it('rejects an unknown command and shows the help', async () => {
    t = await testContext();
    expect(await runCli(['launch'], t.ctx)).toBe(2);
    expect(text(t.err)).toMatch(/Unknown command "launch"/);
    expect(text(t.err)).toContain('ragforge setup');
  });

  it('rejects an option it does not know', async () => {
    t = await testContext();
    expect(await runCli(['start', '--turbo'], t.ctx)).toBe(2);
    expect(text(t.err)).toMatch(/turbo/);
  });
});

describe('setup', () => {
  it('sets up without asking anything when given --yes, and starts RAGForge', async () => {
    t = await testContext();
    const port = await freePort();
    expect(await runCli(['setup', '--yes', '--ollama', 'none', '--port', String(port)], t.ctx)).toBe(0);

    const config = await loadCliConfig(t.ctx.home);
    expect(config).toMatchObject({ port, host: '127.0.0.1' });
    expect(await daemonStatus({ pidFile: pidFile(t.ctx.home), healthUrl: healthUrl(config!) })).toMatchObject({ running: true, healthy: true });
    const shown = text(t.out);
    expect(shown).toMatch(/Setup is complete/);
    expect(shown).toContain(`http://localhost:${port}`);
    expect(shown).toMatch(/ragforge mcp add claude-code/);
    expect(shown).toMatch(/ragforge service install/);
  });

  it('does not start with --no-start', async () => {
    t = await testContext();
    const port = await freePort();
    await runCli(['setup', '--yes', '--ollama', 'none', '--port', String(port), '--no-start'], t.ctx);
    expect((await daemonStatus({ pidFile: pidFile(t.ctx.home), healthUrl: healthUrl({ port }) })).running).toBe(false);
    expect(text(t.out)).toMatch(/Start RAGForge:\s+ragforge start/);
  });

  it('honours where to keep the data and the database', async () => {
    t = await testContext();
    const data = join(t.root, 'chosen');
    const db = join(t.root, 'dbs', 'rag.db');
    await runCli(['setup', '--yes', '--ollama', 'none', '--no-start', '--data-dir', data, '--db-path', db], t.ctx);
    expect(await loadCliConfig(t.ctx.home)).toMatchObject({ dataDir: data, dbPath: db });
    expect(await exists(db)).toBe(true);
  });

  it('shows what it could not set up, without failing', async () => {
    t = await testContext(); // no Docker
    expect(await runCli(['setup', '--yes', '--no-start', '--port', String(await freePort())], t.ctx)).toBe(0);
    expect(text(t.out)).toMatch(/Note: .*Settings/);
  });

  it.each([
    [['--port', '99999'], /--port must be a number from 1 to 65535/],
    [['--port', 'abc'], /--port must be/],
    [['--ollama', 'cloud'], /--ollama must be docker, external or none/],
    [['--ollama-port', '0'], /--ollama-port must be/],
  ])('rejects %j', async (extra, message) => {
    t = await testContext();
    expect(await runCli(['setup', '--yes', ...extra], t.ctx)).toBe(2);
    expect(text(t.err)).toMatch(message);
    expect(await loadCliConfig(t.ctx.home)).toBeNull();
  });

  it('documents its options', async () => {
    t = await testContext();
    expect(await runCli(['setup', '--help'], t.ctx)).toBe(0);
    expect(text(t.out)).toMatch(/--data-dir/);
    expect(text(t.out)).toMatch(/--ollama <mode>/);
  });

  it('lets the user choose Ollama in Docker, which then runs', async () => {
    t = await testContext({ replies: { 'docker --version': ok('v'), 'docker info': ok('29'), 'docker inspect': fail('none'), 'docker run': ok('x'), 'docker exec': ok(), 'nvidia-smi': fail('x', 127) } });
    await runCli(['setup', '--yes', '--ollama', 'docker', '--no-start', '--port', String(await freePort())], t.ctx);
    expect(t.shell.has('docker', 'run')).toBe(true);
    expect((await loadCliConfig(t.ctx.home))?.ollama?.mode).toBe('docker');
  });
});

describe('start, status and stop', () => {
  it('runs through the whole life of the server', async () => {
    t = await testContext();
    await t.configure();
    expect(await runCli(['status'], t.ctx)).toBe(1);
    expect(await runCli(['start'], t.ctx)).toBe(0);
    expect(await runCli(['status'], t.ctx)).toBe(0);
    expect(await runCli(['restart', '--quiet'], t.ctx)).toBe(0);
    expect(await runCli(['stop'], t.ctx)).toBe(0);
    expect(await runCli(['status'], t.ctx)).toBe(1);
  });

  it('reads -n for the number of log lines', async () => {
    t = await testContext();
    await t.configure();
    const { writeFile } = await import('fs/promises');
    await writeFile(join(t.ctx.home, 'ragforge.log'), 'a\nb\nc\nd');
    expect(await runCli(['logs', '-n', '2'], t.ctx)).toBe(0);
    expect(text(t.out)).toBe('c\nd');
    expect(await runCli(['logs', '-n', 'x'], t.ctx)).toBe(2);
  });

  it('opens the browser', async () => {
    t = await testContext();
    const config = await t.configure();
    expect(await runCli(['open'], t.ctx)).toBe(0);
    expect(t.opened).toEqual([`http://localhost:${config.port}`]);
  });
});

describe('service', () => {
  it('turns autostart on and off', async () => {
    t = await testContext({ replies: { systemctl: ok(), loginctl: ok('Linger=yes') } });
    await t.configure();
    expect(await runCli(['service', 'status'], t.ctx)).toBe(0);
    expect(await runCli(['service', 'install'], t.ctx)).toBe(0);
    expect(text(t.out)).toMatch(/start automatically when you log in/i);
    expect(await exists(join(t.ctx.userHome, '.config', 'systemd', 'user', 'ragforge.service'))).toBe(true);
    expect(await runCli(['service', 'uninstall'], t.ctx)).toBe(0);
    expect(await exists(join(t.ctx.userHome, '.config', 'systemd', 'user', 'ragforge.service'))).toBe(false);
  });

  it('needs setup first, and a valid action', async () => {
    t = await testContext();
    expect(await runCli(['service', 'install'], t.ctx)).toBe(1);
    expect(await runCli(['service', 'dance'], t.ctx)).toBe(2);
    expect(text(t.err)).toMatch(/Usage: ragforge service/);
  });

  it('reports a failure to register', async () => {
    t = await testContext({ platform: 'win32', replies: { 'reg add': fail('ERROR: Access is denied.') } });
    await t.configure();
    expect(await runCli(['service', 'install'], t.ctx)).toBe(1);
    expect(text(t.err)).toMatch(/Access is denied/);
  });
});

describe('mcp and uninstall are routed with their options', () => {
  it('passes --kb, --scope and --dry-run to mcp', async () => {
    t = await testContext();
    await t.configure();
    expect(await runCli(['mcp', 'add', 'cursor', '--dry-run'], t.ctx)).toBe(0);
    expect(text(t.out)).toMatch(/Dry run/);
    expect(await runCli(['mcp', 'add', 'claude-code', '--scope', 'galaxy'], t.ctx)).toBe(2);
  });

  it('passes --data and --yes to uninstall', async () => {
    t = await testContext();
    expect(await runCli(['uninstall', '--data', '--yes'], t.ctx)).toBe(0);
    expect(text(t.out)).toMatch(/Nothing is set up/);
  });
});

void readFile;
