import { spawn } from 'child_process';
import { mkdir, open, readFile, rm, stat, writeFile } from 'fs/promises';
import { uptime } from 'os';
import { dirname } from 'path';

export class StartFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartFailed';
  }
}

export interface DaemonCommand {
  exec: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM'; // exists, but belongs to someone else
  }
}

/**
 * The running server's pid, or null. A pid file is trusted only if it was written after the machine
 * booted and its process still exists; after a reboot the number may belong to an unrelated program,
 * so a stale file is deleted and never acted on.
 */
async function readLive(pidFile: string): Promise<{ pid: number; startedAt: number } | null> {
  let parsed: any;
  try {
    parsed = JSON.parse(await readFile(pidFile, 'utf8'));
  } catch {
    await rm(pidFile, { force: true });
    return null;
  }
  const bootedAt = Date.now() - uptime() * 1000 - 5000;
  const valid = parsed && Number.isInteger(parsed.pid) && typeof parsed.startedAt === 'number' && parsed.startedAt >= bootedAt;
  if (!valid || !isAlive(parsed.pid)) {
    await rm(pidFile, { force: true });
    return null;
  }
  return { pid: parsed.pid, startedAt: parsed.startedAt };
}

async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The end of a log file (at most the last 64 KB), as text. */
export async function tailLog(file: string, lines: number): Promise<string> {
  let text: string;
  try {
    const size = (await stat(file)).size;
    const fh = await open(file, 'r');
    try {
      const length = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, size - length);
      text = buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
  return text.split(/\r?\n/).filter((l, i, all) => !(i === all.length - 1 && l === '')).slice(-lines).join('\n');
}

async function logSince(file: string, offset: number): Promise<string> {
  try {
    return (await readFile(file)).subarray(offset).toString('utf8').trim().split(/\r?\n/).slice(-15).join('\n');
  } catch {
    return '';
  }
}

export async function startDaemon(options: {
  command: DaemonCommand;
  pidFile: string;
  logFile: string;
  healthUrl: string;
  /** How long to wait for the server to answer. */
  waitMs?: number;
}): Promise<{ pid: number; alreadyRunning: boolean }> {
  const live = await readLive(options.pidFile);
  if (live) return { pid: live.pid, alreadyRunning: true };

  await mkdir(dirname(options.logFile), { recursive: true });
  await mkdir(dirname(options.pidFile), { recursive: true });
  const logStart = await stat(options.logFile).then((s) => s.size).catch(() => 0);
  const log = await open(options.logFile, 'a');
  let pid: number;
  try {
    const child = spawn(options.command.exec, options.command.args, {
      cwd: options.command.cwd,
      env: { ...process.env, ...options.command.env },
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      windowsHide: true,
    });
    child.unref();
    if (!child.pid) throw new StartFailed(`Could not start ${options.command.exec}.`);
    pid = child.pid;
  } finally {
    await log.close();
  }
  await writeFile(options.pidFile, JSON.stringify({ pid, startedAt: Date.now() }));

  const deadline = Date.now() + (options.waitMs ?? 30_000);
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      await rm(options.pidFile, { force: true });
      throw new StartFailed(`RAGForge stopped right after starting.\n${await logSince(options.logFile, logStart)}`.trim());
    }
    if (await healthy(options.healthUrl)) return { pid, alreadyRunning: false };
    await sleep(150);
  }
  const output = await logSince(options.logFile, logStart);
  await stopDaemon({ pidFile: options.pidFile, graceMs: 2000 });
  throw new StartFailed(`RAGForge did not become ready in time. It was stopped again.\n${output}`.trim());
}

export async function stopDaemon(options: { pidFile: string; graceMs?: number }): Promise<'stopped' | 'not-running'> {
  const live = await readLive(options.pidFile);
  if (!live) return 'not-running';
  try {
    process.kill(live.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + (options.graceMs ?? 10_000);
  while (isAlive(live.pid) && Date.now() < deadline) await sleep(100);
  if (isAlive(live.pid)) {
    try {
      process.kill(live.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
    for (let i = 0; i < 10 && isAlive(live.pid); i++) await sleep(100);
  }
  await rm(options.pidFile, { force: true });
  return 'stopped';
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  startedAt?: number;
  healthy?: boolean;
}

export async function daemonStatus(options: { pidFile: string; healthUrl: string }): Promise<DaemonStatus> {
  const live = await readLive(options.pidFile);
  if (!live) return { running: false };
  return { running: true, pid: live.pid, startedAt: live.startedAt, healthy: await healthy(options.healthUrl) };
}
