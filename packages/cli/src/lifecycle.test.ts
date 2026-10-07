import { describe, it, expect, afterEach } from 'vitest';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { cmdLogs, cmdOpen, cmdRestart, cmdStart, cmdStatus, cmdStop } from './lifecycle.js';
import { logFile, pidFile } from './context.js';
import { daemonStatus, stopDaemon } from './runtime.js';
import { healthUrl } from './context.js';
import { fail, ok, testContext, type TestContext } from './testing.js';

let t: TestContext | undefined;
afterEach(async () => {
  if (t) {
    await stopDaemon({ pidFile: pidFile(t.ctx.home), graceMs: 2000 }).catch(() => {});
    await t.cleanup();
    t = undefined;
  }
});

const text = (lines: string[]) => lines.join('\n');
const DOCKER_READY = { 'docker --version': ok('v'), 'docker info': ok('29.8.2'), 'nvidia-smi': fail('x', 127) };

describe('start', () => {
  it('tells the user to run setup first', async () => {
    t = await testContext();
    expect(await cmdStart(t.ctx, {})).toBe(1);
    expect(text(t.err)).toMatch(/ragforge setup/);
  });

  it('starts RAGForge in the background and says where to open it', async () => {
    t = await testContext();
    const config = await t.configure();
    expect(await cmdStart(t.ctx, {})).toBe(0);
    expect(text(t.out)).toContain(`http://localhost:${config.port}`);
    expect(await daemonStatus({ pidFile: pidFile(t.ctx.home), healthUrl: healthUrl(config) })).toMatchObject({ running: true, healthy: true });
  });

  it('says so when it is already running, and does not start another', async () => {
    t = await testContext();
    await t.configure();
    await cmdStart(t.ctx, {});
    t.out.length = 0;
    expect(await cmdStart(t.ctx, {})).toBe(0);
    expect(text(t.out)).toMatch(/already running/i);
  });

  it('prints nothing when it succeeds quietly (for starting at login)', async () => {
    t = await testContext();
    await t.configure();
    expect(await cmdStart(t.ctx, { quiet: true })).toBe(0);
    expect(t.out).toEqual([]);
  });

  it('can open the browser', async () => {
    t = await testContext();
    const config = await t.configure();
    await cmdStart(t.ctx, { open: true });
    expect(t.opened).toEqual([`http://localhost:${config.port}`]);
  });

  it('reports why the server could not start', async () => {
    t = await testContext({
      ctx: {
        serverCommand: () => ({ exec: process.execPath, args: ['-e', "console.error('Invalid configuration: JWT_SECRET is missing'); process.exit(1)"] }),
      },
    });
    await t.configure();
    expect(await cmdStart(t.ctx, {})).toBe(1);
    expect(text(t.err)).toMatch(/JWT_SECRET is missing/);
  });

  it('starts the Ollama container too when it runs in Docker', async () => {
    t = await testContext({ replies: { ...DOCKER_READY, 'docker inspect': ok('exited'), 'docker start': ok() } });
    await t.configure({ ollama: { mode: 'docker', baseUrl: 'http://127.0.0.1:11434', container: 'ragforge-ollama', port: 11434, modelsDir: join(t.root, 'models'), llmModel: 'llama3.2:3b', embeddingModel: 'nomic-embed-text' } });
    expect(await cmdStart(t.ctx, {})).toBe(0);
    expect(t.shell.has('docker', 'start ragforge-ollama')).toBe(true);
  });

  it('still starts RAGForge when Docker is not running, and says what is affected', async () => {
    t = await testContext({ replies: { 'docker --version': ok('v'), 'docker info': fail('Cannot connect') } });
    await t.configure({ ollama: { mode: 'docker', baseUrl: 'http://127.0.0.1:11434', container: 'ragforge-ollama', port: 11434, modelsDir: join(t.root, 'models'), llmModel: 'a', embeddingModel: 'b' } });
    expect(await cmdStart(t.ctx, {})).toBe(0);
    expect(text(t.out)).toMatch(/Docker is not running.*Ollama was not started/is);
  });
});

describe('stop', () => {
  it('stops it', async () => {
    t = await testContext();
    const config = await t.configure();
    await cmdStart(t.ctx, {});
    t.out.length = 0;
    expect(await cmdStop(t.ctx, {})).toBe(0);
    expect(text(t.out)).toMatch(/stopped/i);
    expect((await daemonStatus({ pidFile: pidFile(t.ctx.home), healthUrl: healthUrl(config) })).running).toBe(false);
  });

  it('says there was nothing to stop', async () => {
    t = await testContext();
    await t.configure();
    expect(await cmdStop(t.ctx, {})).toBe(0);
    expect(text(t.out)).toMatch(/not running/i);
  });

  it('also stops the Ollama container with --all', async () => {
    t = await testContext({ replies: { ...DOCKER_READY, 'docker stop': ok() } });
    await t.configure({ ollama: { mode: 'docker', baseUrl: 'http://127.0.0.1:11434', container: 'ragforge-ollama', port: 11434, modelsDir: 'm', llmModel: 'a', embeddingModel: 'b' } });
    await cmdStop(t.ctx, { all: true });
    expect(t.shell.has('docker', 'stop ragforge-ollama')).toBe(true);
  });

  it('leaves Ollama running by default, since other programs may use it', async () => {
    t = await testContext({ replies: { ...DOCKER_READY, 'docker stop': ok() } });
    await t.configure({ ollama: { mode: 'docker', baseUrl: 'http://127.0.0.1:11434', container: 'ragforge-ollama', port: 11434, modelsDir: 'm', llmModel: 'a', embeddingModel: 'b' } });
    await cmdStop(t.ctx, {});
    expect(t.shell.has('docker', 'stop')).toBe(false);
  });
});

describe('restart', () => {
  it('stops and starts again with a new process', async () => {
    t = await testContext();
    const config = await t.configure();
    await cmdStart(t.ctx, {});
    const before = (await daemonStatus({ pidFile: pidFile(t.ctx.home), healthUrl: healthUrl(config) })).pid;
    expect(await cmdRestart(t.ctx, {})).toBe(0);
    const after = await daemonStatus({ pidFile: pidFile(t.ctx.home), healthUrl: healthUrl(config) });
    expect(after).toMatchObject({ running: true, healthy: true });
    expect(after.pid).not.toBe(before);
  });
});

describe('status', () => {
  it('shows a running server with its address and where its data lives', async () => {
    t = await testContext();
    const config = await t.configure();
    await cmdStart(t.ctx, {});
    t.out.length = 0;
    expect(await cmdStatus(t.ctx)).toBe(0);
    const shown = text(t.out);
    expect(shown).toMatch(/RAGForge\s+running/);
    expect(shown).toContain(`http://localhost:${config.port}`);
    expect(shown).toContain(config.dataDir);
    expect(shown).toContain(config.dbPath);
  });

  it('exits with 1 when it is not running, so scripts can tell', async () => {
    t = await testContext();
    await t.configure();
    expect(await cmdStatus(t.ctx)).toBe(1);
    expect(text(t.out)).toMatch(/RAGForge\s+stopped/);
  });

  it('shows the state of the Ollama container', async () => {
    t = await testContext({ replies: { ...DOCKER_READY, 'docker inspect': ok('running') } });
    await t.configure({ ollama: { mode: 'docker', baseUrl: 'http://127.0.0.1:11434', container: 'ragforge-ollama', port: 11434, modelsDir: 'm', llmModel: 'llama3.2:3b', embeddingModel: 'nomic-embed-text' } });
    await cmdStatus(t.ctx);
    expect(text(t.out)).toMatch(/Ollama\s+running in Docker \(ragforge-ollama\)/);
    expect(text(t.out)).toContain('llama3.2:3b');
  });

  it('says when no local AI was set up', async () => {
    t = await testContext();
    await t.configure();
    await cmdStatus(t.ctx);
    expect(text(t.out)).toMatch(/Ollama\s+not set up/);
  });
});

describe('logs', () => {
  it('shows the end of the log', async () => {
    t = await testContext();
    await t.configure();
    await writeFile(logFile(t.ctx.home), Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'));
    expect(await cmdLogs(t.ctx, { lines: 3 })).toBe(0);
    expect(text(t.out)).toBe('line 27\nline 28\nline 29');
  });

  it('says when there is no log yet', async () => {
    t = await testContext();
    await t.configure();
    expect(await cmdLogs(t.ctx, {})).toBe(0);
    expect(text(t.out)).toMatch(/no log yet/i);
  });
});

describe('open', () => {
  it('opens RAGForge in the browser', async () => {
    t = await testContext();
    const config = await t.configure();
    expect(await cmdOpen(t.ctx)).toBe(0);
    expect(t.opened).toEqual([`http://localhost:${config.port}`]);
  });
});
