import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'net';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { DATA_MARKER } from './config.js';
import { cmdDoctor } from './doctor.js';
import { cmdStart } from './lifecycle.js';
import { pidFile } from './context.js';
import { stopDaemon } from './runtime.js';
import { fail, ok, testContext, type TestContext } from './testing.js';

let t: TestContext | undefined;
let blocker: Server | undefined;
afterEach(async () => {
  blocker?.close();
  blocker = undefined;
  if (t) {
    await stopDaemon({ pidFile: pidFile(t.ctx.home), graceMs: 2000 }).catch(() => {});
    await t.cleanup();
    t = undefined;
  }
});
const text = (lines: string[]) => lines.join('\n');
const tags = (names: string[]) => (async () => new Response(JSON.stringify({ models: names.map((name) => ({ name })) }))) as unknown as typeof fetch;
const DOCKER_READY = { 'docker --version': ok('v'), 'docker info': ok('29'), 'docker inspect': ok('running'), 'systemctl': fail('x') };
const docker = (t: TestContext, over: Partial<NonNullable<import('./config.js').CliConfig['ollama']>> = {}) => ({
  mode: 'docker' as const, baseUrl: 'http://127.0.0.1:11434', container: 'ragforge-ollama', port: 11434, modelsDir: join(t.root, 'models'), llmModel: 'llama3.2:3b', embeddingModel: 'nomic-embed-text', ...over,
});

async function withData(x: TestContext, marker = true) {
  await mkdir(join(x.root, 'data'), { recursive: true });
  await writeFile(join(x.root, 'data', 'ragforge.db'), 'x');
  if (marker) await writeFile(join(x.root, 'data', DATA_MARKER), 'x');
}

describe('doctor', () => {
  it('says setup is missing and fails', async () => {
    t = await testContext();
    expect(await cmdDoctor(t.ctx)).toBe(1);
    expect(text(t.out)).toMatch(/\[x\] Settings.*ragforge setup/);
  });

  it('passes a healthy install and says what is fine', async () => {
    t = await testContext({ replies: DOCKER_READY, ctx: { fetchImpl: tags(['llama3.2:3b', 'nomic-embed-text:latest']) } });
    await t.configure({ ollama: docker(t) });
    await withData(t);
    await cmdStart(t.ctx, { quiet: true });
    expect(await cmdDoctor(t.ctx)).toBe(0);
    const shown = text(t.out);
    expect(shown).toMatch(/\[ok\] Node\.js/);
    expect(shown).toMatch(/\[ok\] Settings/);
    expect(shown).toMatch(/\[ok\] Data folder/);
    expect(shown).toMatch(/\[ok\] RAGForge is running/);
    expect(shown).toMatch(/\[ok\] Docker/);
    expect(shown).toMatch(/\[ok\] Ollama.*llama3\.2:3b.*nomic-embed-text/s);
    expect(shown).not.toMatch(/\[x\]/);
  });

  it('warns, but does not fail, when RAGForge is simply stopped', async () => {
    t = await testContext();
    await t.configure();
    await withData(t);
    expect(await cmdDoctor(t.ctx)).toBe(0);
    expect(text(t.out)).toMatch(/\[!!\] RAGForge is not running.*ragforge start/s);
  });

  it('fails when another program is using the port', async () => {
    t = await testContext();
    const config = await t.configure();
    await withData(t);
    blocker = createServer().listen(config.port, '127.0.0.1');
    await new Promise((r) => blocker!.once('listening', r));
    expect(await cmdDoctor(t.ctx)).toBe(1);
    expect(text(t.out)).toMatch(new RegExp(`\\[x\\] Port ${config.port} is used by another program`));
  });

  it('fails when Ollama runs in Docker but Docker is missing, and says how to fix it', async () => {
    t = await testContext();
    await t.configure({ ollama: docker(t) });
    await withData(t);
    expect(await cmdDoctor(t.ctx)).toBe(1);
    expect(text(t.out)).toMatch(/\[x\] Docker is not installed.*docs\.docker\.com/s);
  });

  it('fails when Docker is installed but not running', async () => {
    t = await testContext({ replies: { 'docker --version': ok('v'), 'docker info': fail('Cannot connect') } });
    await t.configure({ ollama: docker(t) });
    await withData(t);
    expect(await cmdDoctor(t.ctx)).toBe(1);
    expect(text(t.out)).toMatch(/\[x\] Docker is not running.*Start Docker Desktop/s);
  });

  it('fails when a model that RAGForge needs is not downloaded, and names it', async () => {
    t = await testContext({ replies: DOCKER_READY, ctx: { fetchImpl: tags(['llama3.2:3b']) } });
    await t.configure({ ollama: docker(t) });
    await withData(t);
    expect(await cmdDoctor(t.ctx)).toBe(1);
    expect(text(t.out)).toMatch(/\[x\] Ollama.*missing model.*nomic-embed-text.*ollama pull nomic-embed-text/s);
  });

  it('fails when Ollama does not answer', async () => {
    t = await testContext({ replies: DOCKER_READY, ctx: { fetchImpl: (async () => Promise.reject(new Error('refused'))) as unknown as typeof fetch } });
    await t.configure({ ollama: docker(t) });
    await withData(t);
    expect(await cmdDoctor(t.ctx)).toBe(1);
    expect(text(t.out)).toMatch(/\[x\] Ollama does not answer/);
  });

  it('warns about a data folder without the RAGForge marker', async () => {
    t = await testContext();
    await t.configure();
    await withData(t, false);
    await cmdDoctor(t.ctx);
    expect(text(t.out)).toMatch(/\[!!\] Data folder.*not created by RAGForge/);
  });

  it('says plainly when no local AI was set up', async () => {
    t = await testContext();
    await t.configure();
    await withData(t);
    await cmdDoctor(t.ctx);
    expect(text(t.out)).toMatch(/\[!!\] No local AI.*Settings/);
  });
});
