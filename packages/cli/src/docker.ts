import { spawn } from 'child_process';
import { posix, win32 } from 'path';
import { launch } from './launch.js';

export class DockerProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerProblem';
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

type RunOptions = { env?: Record<string, string>; timeoutMs?: number };

/** Runs programs. Real in production; scripted in tests so nothing touches the user's Docker. */
export interface Shell {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
  /** Runs with the output shown to the user (for long downloads). Returns the exit code. */
  runLive(cmd: string, args: string[], opts?: RunOptions): Promise<number>;
}

export const realShell: Shell = {
  run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const l = launch(cmd, args);
      if ('refused' in l) return resolve({ code: 126, stdout: '', stderr: l.refused });
      const child = spawn(l.file, l.args, { env: { ...process.env, ...opts.env }, windowsHide: true, windowsVerbatimArguments: l.verbatim });
      const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : undefined;
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err: any) => {
        if (timer) clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: err?.message ?? String(err) });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  },
  runLive(cmd, args, opts = {}) {
    return new Promise((resolve) => {
      const l = launch(cmd, args);
      if ('refused' in l) return resolve(126);
      const child = spawn(l.file, l.args, { env: { ...process.env, ...opts.env }, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: l.verbatim });
      child.on('error', () => resolve(127));
      child.on('close', (code) => resolve(code ?? 1));
    });
  },
};

export interface DockerCli {
  /** `docker` when it is on the PATH, otherwise the full path of the program. */
  path: string;
  onPath: boolean;
}

const KNOWN_PATHS: Record<string, (env: Record<string, string | undefined>) => string[]> = {
  win32: (env) => [
    ...(env.LOCALAPPDATA ? [`${env.LOCALAPPDATA}\\Programs\\DockerDesktop\\resources\\bin\\docker.exe`] : []),
    'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
  ],
  darwin: () => ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker'],
  linux: () => ['/usr/bin/docker', '/usr/local/bin/docker'],
};

/** Finds the Docker program. Docker Desktop often is not on the PATH of a terminal, so known places are tried too. */
export async function findDocker(shell: Shell, platform: string = process.platform, env: Record<string, string | undefined> = process.env): Promise<DockerCli | null> {
  if ((await shell.run('docker', ['--version'])).code === 0) return { path: 'docker', onPath: true };
  for (const candidate of KNOWN_PATHS[platform]?.(env) ?? []) {
    if ((await shell.run(candidate, ['--version'])).code === 0) return { path: candidate, onPath: false };
  }
  return null;
}

/** Docker's helper programs (such as the credential helper) live next to it; they must be on the PATH when it runs. */
export function dockerEnv(docker: DockerCli, platform: string = process.platform, env: Record<string, string | undefined> = process.env): Record<string, string> {
  if (docker.onPath) return {};
  const dir = (platform === 'win32' ? win32 : posix).dirname(docker.path);
  const sep = platform === 'win32' ? ';' : ':';
  return { PATH: `${dir}${sep}${env.PATH ?? ''}` };
}

export type DockerReadiness = { state: 'not-installed' } | { state: 'daemon-stopped'; docker: DockerCli } | { state: 'ready'; docker: DockerCli; version: string };

export async function dockerState(shell: Shell, platform: string = process.platform, env: Record<string, string | undefined> = process.env): Promise<DockerReadiness> {
  const docker = await findDocker(shell, platform, env);
  if (!docker) return { state: 'not-installed' };
  const info = await shell.run(docker.path, ['info', '--format', '{{.ServerVersion}}'], { env: dockerEnv(docker, platform, env), timeoutMs: 20_000 });
  if (info.code !== 0) return { state: 'daemon-stopped', docker };
  return { state: 'ready', docker, version: info.stdout.trim() };
}

export async function detectGpu(shell: Shell): Promise<boolean> {
  const r = await shell.run('nvidia-smi', ['-L'], { timeoutMs: 10_000 });
  return r.code === 0 && /GPU \d/.test(r.stdout);
}

export interface ModelPlan {
  embedding: string;
  chat: string;
  /** Rough download sizes, to tell the user before they agree. */
  approxGb: { embedding: number; chat: number };
}

/** A chat model that runs acceptably in the memory available. The embedding model is small and the same for everyone. */
export function recommendModels(ramGb: number): ModelPlan {
  const [chat, gb] = ramGb < 8 ? ['llama3.2:1b', 1.3] : ramGb < 32 ? ['llama3.2:3b', 2] : ['llama3.1:8b', 4.9];
  return { embedding: 'nomic-embed-text', chat: chat as string, approxGb: { embedding: 0.3, chat: gb as number } };
}

export interface OllamaContainerOptions {
  name: string;
  port: number;
  modelsDir: string;
  gpu: boolean;
}

/** Makes sure the Ollama container exists and runs. It listens on this computer only and keeps its models in `modelsDir`. */
export async function ensureOllamaContainer(
  shell: Shell,
  docker: DockerCli,
  o: OllamaContainerOptions,
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): Promise<'created' | 'started' | 'already-running'> {
  const runEnv = dockerEnv(docker, platform, env);
  const state = await shell.run(docker.path, ['inspect', '-f', '{{.State.Status}}', o.name], { env: runEnv });
  if (state.code === 0) {
    if (state.stdout.trim() === 'running') return 'already-running';
    const start = await shell.run(docker.path, ['start', o.name], { env: runEnv });
    if (start.code !== 0) throw new DockerProblem(`Could not start the Ollama container "${o.name}": ${firstLine(start.stderr)}`);
    return 'started';
  }

  const create = (gpu: boolean) =>
    shell.run(docker.path, ['run', '-d', '--name', o.name, '--restart', 'unless-stopped', '-p', `127.0.0.1:${o.port}:11434`, '-v', `${o.modelsDir}:/root/.ollama`, ...(gpu ? ['--gpus', 'all'] : []), 'ollama/ollama'], { env: runEnv });

  let result = await create(o.gpu);
  if (result.code !== 0 && o.gpu && /gpu|device driver|nvidia/i.test(result.stderr)) {
    await shell.run(docker.path, ['rm', '-f', o.name], { env: runEnv }); // a failed run leaves a created container behind
    result = await create(false);
  }
  if (result.code !== 0) {
    await shell.run(docker.path, ['rm', '-f', o.name], { env: runEnv });
    if (/port is already allocated|address already in use/i.test(result.stderr)) {
      throw new DockerProblem(`Port ${o.port} is already in use on this computer, so Ollama cannot start there. Choose another port during setup, or use the Ollama you already run.`);
    }
    throw new DockerProblem(`Could not start Ollama in Docker: ${firstLine(result.stderr)}`);
  }
  return 'created';
}

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0] || 'unknown error';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until Ollama answers, which takes a few seconds after the container starts. */
export async function waitForOllama(baseUrl: string, o: { timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch } = {}): Promise<void> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const deadline = Date.now() + (o.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(o.intervalMs ?? 500);
  }
  throw new DockerProblem(`Ollama did not answer at ${baseUrl}. Check that its container is running (docker ps).`);
}

export async function installedModels(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
  const body: any = await res.json();
  return (body?.models ?? []).map((m: any) => String(m.name));
}

/** Downloads the models that are not installed yet. Returns the ones it downloaded. */
export async function ensureModels(
  shell: Shell,
  docker: DockerCli,
  o: { container: string; baseUrl: string; models: string[]; fetchImpl?: typeof fetch; platform?: string; env?: Record<string, string | undefined> },
): Promise<string[]> {
  const have = await installedModels(o.baseUrl, o.fetchImpl);
  const has = (model: string) => have.includes(model) || (!model.includes(':') && have.includes(`${model}:latest`));
  const pulled: string[] = [];
  for (const model of o.models) {
    if (has(model)) continue;
    const code = await shell.runLive(docker.path, ['exec', o.container, 'ollama', 'pull', model], { env: dockerEnv(docker, o.platform, o.env) });
    if (code !== 0) throw new DockerProblem(`Could not download the model "${model}". Check your internet connection and run setup again; models already downloaded are kept.`);
    pulled.push(model);
  }
  return pulled;
}

export async function stopOllama(shell: Shell, docker: DockerCli, name: string): Promise<void> {
  await shell.run(docker.path, ['stop', name], { env: dockerEnv(docker) });
}

/** Removes the container. The downloaded models live in a folder on the host and are not touched. */
export async function removeOllama(shell: Shell, docker: DockerCli, name: string): Promise<void> {
  await shell.run(docker.path, ['rm', '-f', name], { env: dockerEnv(docker) });
}
