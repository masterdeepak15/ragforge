import { describe, it, expect, afterEach } from 'vitest';
import { access, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { DATA_MARKER, type CliConfig } from './config.js';
import { cmdUninstall } from './uninstall.js';
import { cmdStart } from './lifecycle.js';
import { pidFile } from './context.js';
import { daemonStatus } from './runtime.js';
import { healthUrl } from './context.js';
import { fail, ok, scriptedPrompter, testContext, type TestContext } from './testing.js';

let t: TestContext | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});
const text = (lines: string[]) => lines.join('\n');
const exists = (p: string) => access(p).then(() => true, () => false);

const DOCKER = { 'docker --version': ok('v'), 'docker info': ok('29'), 'docker rm': ok(), 'schtasks /Delete': ok(), 'systemctl': ok(), 'loginctl': ok('Linger=yes') };

/** An install with data on disk: marker, database, uploads, Ollama models, and a Docker-run Ollama. */
async function install(over: { replies?: Record<string, any>; prompter?: any; dataDir?: string; dbPath?: string; modelsDir?: string; marker?: boolean } = {}) {
  t = await testContext({ replies: { ...DOCKER, ...over.replies }, prompter: over.prompter });
  const dataDir = over.dataDir ?? join(t.root, 'data');
  const dbPath = over.dbPath ?? join(dataDir, 'ragforge.db');
  const modelsDir = over.modelsDir ?? join(dataDir, 'ollama');
  await mkdir(modelsDir, { recursive: true });
  await mkdir(join(dataDir, 'uploads'), { recursive: true });
  await mkdir(join(dbPath, '..'), { recursive: true });
  await writeFile(join(dataDir, 'uploads', 'doc.pdf'), 'x');
  await writeFile(join(modelsDir, 'model.bin'), 'x');
  await writeFile(dbPath, 'x');
  await writeFile(`${dbPath}-wal`, 'x');
  if (over.marker !== false) await writeFile(join(dataDir, DATA_MARKER), 'x');
  const config: CliConfig = await t.configure({ dataDir, dbPath, ollama: { mode: 'docker', baseUrl: 'http://127.0.0.1:11434', container: 'ragforge-ollama', port: 11434, modelsDir, llmModel: 'llama3.2:3b', embeddingModel: 'nomic-embed-text' } });
  return { t, config, dataDir, dbPath, modelsDir };
}

describe('uninstall (keeps your data)', () => {
  it('stops everything and removes the Ollama container and autostart, but keeps data and settings', async () => {
    const x = await install();
    await cmdStart(x.t.ctx, { quiet: true });
    expect(await cmdUninstall(x.t.ctx, {})).toBe(0);

    expect((await daemonStatus({ pidFile: pidFile(x.t.ctx.home), healthUrl: healthUrl(x.config) })).running).toBe(false);
    expect(x.t.shell.has('docker', 'rm -f ragforge-ollama')).toBe(true);
    expect(await exists(x.dataDir)).toBe(true);
    expect(await exists(x.dbPath)).toBe(true);
    expect(await exists(join(x.t.ctx.home, 'config.json'))).toBe(true); // holds the key to stored credentials
  });

  it('says what was kept and how to remove it, and how to remove the program itself', async () => {
    const x = await install();
    await cmdUninstall(x.t.ctx, {});
    const shown = text(x.t.out);
    expect(shown).toContain(x.dataDir);
    expect(shown).toMatch(/ragforge uninstall --data/);
    expect(shown).toMatch(/npm uninstall -g @masterdeepak15\/ragforge/);
  });

  it('works when nothing was set up', async () => {
    t = await testContext();
    expect(await cmdUninstall(t.ctx, {})).toBe(0);
    expect(text(t.out)).toMatch(/nothing is set up/i);
  });
});

describe('uninstall --data (deletes your data)', () => {
  it('deletes the data folder, the database and the settings once confirmed', async () => {
    const x = await install();
    expect(await cmdUninstall(x.t.ctx, { data: true, yes: true })).toBe(0);
    expect(await exists(x.dataDir)).toBe(false);
    expect(await exists(x.dbPath)).toBe(false);
    expect(await exists(join(x.t.ctx.home, 'config.json'))).toBe(false);
    expect(text(x.t.out)).toMatch(/deleted/i);
  });

  it('shows exactly what it will delete and asks for the word "delete"', async () => {
    const { prompter, asked } = scriptedPrompter([[/type "delete"/i, 'delete']]);
    const x = await install({ prompter });
    expect(await cmdUninstall(x.t.ctx, { data: true })).toBe(0);
    expect(asked.some((q) => /type "delete"/i.test(q))).toBe(true);
    expect(text(x.t.out)).toContain(x.dataDir);
    expect(await exists(x.dataDir)).toBe(false);
  });

  it('deletes nothing when the answer is anything else', async () => {
    const { prompter } = scriptedPrompter([[/type "delete"/i, 'yes please']]);
    const x = await install({ prompter });
    expect(await cmdUninstall(x.t.ctx, { data: true })).toBe(1);
    expect(await exists(x.dataDir)).toBe(true);
    expect(await exists(x.dbPath)).toBe(true);
    expect(text(x.t.out)).toMatch(/nothing was deleted/i);
  });

  it('deletes nothing when it cannot ask (no terminal, no --yes)', async () => {
    const x = await install(); // the default prompter answers with the default, which is empty
    expect(await cmdUninstall(x.t.ctx, { data: true })).toBe(1);
    expect(await exists(x.dataDir)).toBe(true);
  });

  it('refuses a data folder that RAGForge did not create', async () => {
    const x = await install({ marker: false });
    expect(await cmdUninstall(x.t.ctx, { data: true, yes: true })).toBe(1);
    expect(text(x.t.err)).toMatch(/not created by RAGForge/i);
    expect(await exists(join(x.dataDir, 'uploads', 'doc.pdf'))).toBe(true);
  });

  it('refuses to delete the home folder, even if it carries the marker', async () => {
    t = await testContext({ replies: DOCKER });
    await writeFile(join(t.ctx.userHome + '-marker'), '');
    await mkdir(t.ctx.userHome, { recursive: true });
    await writeFile(join(t.ctx.userHome, DATA_MARKER), 'x');
    await writeFile(join(t.ctx.userHome, 'important.txt'), 'x');
    await t.configure({ dataDir: t.ctx.userHome, dbPath: join(t.ctx.userHome, 'ragforge.db') });
    expect(await cmdUninstall(t.ctx, { data: true, yes: true })).toBe(1);
    expect(text(t.err)).toMatch(/home folder|too broad/i);
    expect(await exists(join(t.ctx.userHome, 'important.txt'))).toBe(true);
  });

  it('removes only the database files when the database lives outside the data folder', async () => {
    t = undefined;
    const x = await install();
    const outside = join(x.t.root, 'elsewhere');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'notes.txt'), 'mine');
    await writeFile(join(outside, 'rag.db'), 'x');
    await writeFile(join(outside, 'rag.db-wal'), 'x');
    await x.t.configure({ dataDir: x.dataDir, dbPath: join(outside, 'rag.db'), ollama: x.config.ollama });
    await cmdUninstall(x.t.ctx, { data: true, yes: true });
    expect(await exists(join(outside, 'rag.db'))).toBe(false);
    expect(await exists(join(outside, 'rag.db-wal'))).toBe(false);
    expect(await exists(join(outside, 'notes.txt'))).toBe(true); // not ours to delete
  });

  it('leaves Ollama models stored outside the data folder, and says where they are', async () => {
    const x = await install();
    const models = join(x.t.root, 'big-models');
    await mkdir(models, { recursive: true });
    await writeFile(join(models, 'm.bin'), 'x');
    await x.t.configure({ dataDir: x.dataDir, dbPath: x.dbPath, ollama: { ...x.config.ollama!, modelsDir: models } });
    await cmdUninstall(x.t.ctx, { data: true, yes: true });
    expect(await exists(join(models, 'm.bin'))).toBe(true);
    expect(text(x.t.out)).toContain(models);
  });

  it('still removes the Docker container and the autostart entry', async () => {
    const x = await install({ replies: { 'docker rm': ok(), 'schtasks /Delete': fail('none') } });
    await cmdUninstall(x.t.ctx, { data: true, yes: true });
    expect(x.t.shell.has('docker', 'rm -f ragforge-ollama')).toBe(true);
  });
});
