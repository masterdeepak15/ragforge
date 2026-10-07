import { describe, it, expect } from 'vitest';
import { DockerProblem, realShell, dockerEnv, dockerState, ensureModels, ensureOllamaContainer, findDocker, recommendModels, removeOllama, waitForOllama, type RunResult, type Shell } from './docker.js';

type Reply = RunResult | ((args: string[]) => RunResult);
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'failed', code = 1): RunResult => ({ code, stdout: '', stderr });

/** A shell that answers from a table keyed by "command arg arg", and remembers what it was asked. */
function fakeShell(replies: Record<string, Reply>) {
  const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
  const lookup = (cmd: string, args: string[]): RunResult => {
    const key = [cmd, ...args].join(' ');
    const hit = Object.entries(replies).find(([k]) => key === k || key.startsWith(k + ' '));
    if (!hit) return fail(`not found: ${cmd}`, 127);
    return typeof hit[1] === 'function' ? hit[1](args) : hit[1];
  };
  const shell: Shell = {
    async run(cmd, args, opts) {
      calls.push({ cmd, args, env: opts?.env });
      return lookup(cmd, args);
    },
    async runLive(cmd, args, opts) {
      calls.push({ cmd, args, env: opts?.env });
      return lookup(cmd, args).code;
    },
  };
  return { shell, calls };
}

describe('findDocker', () => {
  it('uses docker from the PATH when it works', async () => {
    const { shell } = fakeShell({ 'docker --version': ok('Docker version 29') });
    expect(await findDocker(shell, 'linux', {})).toEqual({ path: 'docker', onPath: true });
  });

  it('finds Docker Desktop on Windows even when it is not on the PATH', async () => {
    const desktop = 'C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe';
    const { shell } = fakeShell({ [`${desktop} --version`]: ok('Docker version 29') });
    expect(await findDocker(shell, 'win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })).toEqual({ path: desktop, onPath: false });
  });

  it('returns null when Docker is not installed', async () => {
    const { shell } = fakeShell({});
    expect(await findDocker(shell, 'darwin', {})).toBeNull();
  });
});

describe('dockerEnv', () => {
  it('adds the folder of a Docker found by path, so its helper programs are found too', () => {
    const env = dockerEnv({ path: 'C:\\Docker\\bin\\docker.exe', onPath: false }, 'win32', { PATH: 'C:\\Windows' });
    expect(env.PATH).toBe('C:\\Docker\\bin;C:\\Windows');
  });
  it('leaves the environment alone when docker is already on the PATH', () => {
    expect(dockerEnv({ path: 'docker', onPath: true }, 'linux', { PATH: '/usr/bin' })).toEqual({});
  });
});

describe('dockerState', () => {
  it('is not-installed without Docker', async () => {
    expect((await dockerState(fakeShell({}).shell, 'linux', {})).state).toBe('not-installed');
  });
  it('is daemon-stopped when Docker is installed but not running', async () => {
    const { shell } = fakeShell({ 'docker --version': ok('v'), 'docker info': fail('Cannot connect to the Docker daemon') });
    expect((await dockerState(shell, 'linux', {})).state).toBe('daemon-stopped');
  });
  it('is ready when Docker answers', async () => {
    const { shell } = fakeShell({ 'docker --version': ok('v'), 'docker info': ok('29.8.2') });
    expect(await dockerState(shell, 'linux', {})).toMatchObject({ state: 'ready', version: '29.8.2' });
  });
});

describe('recommendModels', () => {
  it.each([
    [4, 'llama3.2:1b'],
    [16, 'llama3.2:3b'],
    [23.6, 'llama3.2:3b'],
    [32, 'llama3.1:8b'],
    [64, 'llama3.1:8b'],
  ])('suggests a chat model that fits %s GB of memory', (ram, chat) => {
    expect(recommendModels(ram)).toMatchObject({ chat, embedding: 'nomic-embed-text' });
  });
});

const docker = { path: 'docker', onPath: true };
const opts = { name: 'ragforge-ollama', port: 11434, modelsDir: '/data/ollama' };

describe('ensureOllamaContainer', () => {
  it('creates the container: local only, keeps models in the chosen folder, restarts with Docker', async () => {
    const { shell, calls } = fakeShell({ 'docker inspect': fail('No such object'), 'docker run': ok('abc123') });
    expect(await ensureOllamaContainer(shell, docker, { ...opts, gpu: false })).toBe('created');
    const run = calls.find((c) => c.args[0] === 'run')!.args;
    expect(run).toEqual(expect.arrayContaining(['-d', '--name', 'ragforge-ollama', '--restart', 'unless-stopped', '-p', '127.0.0.1:11434:11434', '-v', '/data/ollama:/root/.ollama']));
    expect(run[run.length - 1]).toBe('ollama/ollama');
    expect(run).not.toContain('--gpus');
  });

  it('uses the GPU when asked and falls back to the CPU if Docker cannot', async () => {
    const { shell, calls } = fakeShell({
      'docker inspect': fail('No such object'),
      'docker run': (args) => (args.includes('--gpus') ? fail('could not select device driver "" with capabilities: [[gpu]]') : ok('abc')),
    });
    expect(await ensureOllamaContainer(shell, docker, { ...opts, gpu: true })).toBe('created');
    const runs = calls.filter((c) => c.args[0] === 'run');
    expect(runs).toHaveLength(2);
    expect(runs[0].args).toContain('--gpus');
    expect(runs[1].args).not.toContain('--gpus');
  });

  it('starts a stopped container instead of making a new one', async () => {
    const { shell, calls } = fakeShell({ 'docker inspect': ok('exited'), 'docker start': ok() });
    expect(await ensureOllamaContainer(shell, docker, { ...opts, gpu: false })).toBe('started');
    expect(calls.some((c) => c.args[0] === 'run')).toBe(false);
  });

  it('leaves a running container alone', async () => {
    const { shell, calls } = fakeShell({ 'docker inspect': ok('running') });
    expect(await ensureOllamaContainer(shell, docker, { ...opts, gpu: false })).toBe('already-running');
    expect(calls.filter((c) => c.args[0] !== 'inspect')).toHaveLength(0);
  });

  it('explains a port that is already taken, and what to do', async () => {
    const { shell } = fakeShell({ 'docker inspect': fail('No such object'), 'docker run': fail('Bind for 127.0.0.1:11434 failed: port is already allocated') });
    const error = await ensureOllamaContainer(shell, docker, { ...opts, gpu: false }).catch((e) => e);
    expect(error).toBeInstanceOf(DockerProblem);
    expect(error.message).toMatch(/11434.*already in use/);
    expect(error.message).toMatch(/another port|Ollama you already run/i);
  });

  it('passes the Docker folder through so credential helpers are found', async () => {
    const found = { path: 'C:\\Docker\\bin\\docker.exe', onPath: false };
    const { shell, calls } = fakeShell({ 'C:\\Docker\\bin\\docker.exe inspect': ok('running') });
    await ensureOllamaContainer(shell, found, { ...opts, gpu: false }, 'win32', { PATH: 'C:\\Windows' });
    expect(calls[0].env?.PATH).toBe('C:\\Docker\\bin;C:\\Windows');
  });
});

describe('waitForOllama', () => {
  it('returns once Ollama answers', async () => {
    let tries = 0;
    const fetchImpl = (async () => (++tries < 3 ? Promise.reject(new Error('refused')) : new Response('{"models":[]}'))) as unknown as typeof fetch;
    await expect(waitForOllama('http://127.0.0.1:11434', { timeoutMs: 5000, intervalMs: 5, fetchImpl })).resolves.toBeUndefined();
    expect(tries).toBe(3);
  });

  it('gives up with a clear message', async () => {
    const fetchImpl = (async () => Promise.reject(new Error('refused'))) as unknown as typeof fetch;
    await expect(waitForOllama('http://127.0.0.1:11434', { timeoutMs: 60, intervalMs: 10, fetchImpl })).rejects.toThrow(/did not answer/i);
  });
});

describe('ensureModels', () => {
  const tags = (names: string[]) => (async () => new Response(JSON.stringify({ models: names.map((name) => ({ name })) }))) as unknown as typeof fetch;

  it('downloads only the models that are missing', async () => {
    const { shell, calls } = fakeShell({ 'docker exec ragforge-ollama ollama pull': ok() });
    const pulled = await ensureModels(shell, docker, { container: 'ragforge-ollama', baseUrl: 'http://127.0.0.1:11434', models: ['nomic-embed-text', 'llama3.2:3b'], fetchImpl: tags(['nomic-embed-text:latest']) });
    expect(pulled).toEqual(['llama3.2:3b']);
    expect(calls.map((c) => c.args.join(' '))).toEqual(['exec ragforge-ollama ollama pull llama3.2:3b']);
  });

  it('reports a failed download instead of pretending it worked', async () => {
    const { shell } = fakeShell({ 'docker exec ragforge-ollama ollama pull': fail('network error') });
    await expect(ensureModels(shell, docker, { container: 'ragforge-ollama', baseUrl: 'http://x', models: ['llama3.2:3b'], fetchImpl: tags([]) })).rejects.toThrow(/llama3\.2:3b/);
  });
});

describe('removeOllama', () => {
  it('removes the container but never touches the downloaded models', async () => {
    const { shell, calls } = fakeShell({ 'docker rm': ok() });
    await removeOllama(shell, docker, 'ragforge-ollama');
    expect(calls[0].args).toEqual(['rm', '-f', 'ragforge-ollama']);
  });
});

describe('realShell', () => {
  it('passes arguments with spaces and quotes through unchanged', async () => {
    const r = await realShell.run('node', ['-e', 'console.log(process.argv[1] + "|" + process.argv[2])', 'a b "c"', 'Authorization: Bearer rf_x']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('a b "c"|Authorization: Bearer rf_x');
  });

  it('reports a program that does not exist as a failure instead of throwing', async () => {
    const r = await realShell.run('definitely-not-a-real-program-xyz', ['--version']);
    expect(r.code).not.toBe(0);
  });
});
