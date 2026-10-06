import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, access } from 'fs/promises';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { StartFailed, daemonStatus, isAlive, startDaemon, stopDaemon, tailLog, type DaemonCommand } from './runtime.js';

let dir: string;
let port: number;
let pidFile: string;
let logFile: string;
let started: number[] = [];

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as any).port;
      s.close(() => resolve(p));
    });
  });

/** A stand-in for the RAGForge server: answers /api/health and exits on SIGTERM. */
async function fakeServer(body: string): Promise<DaemonCommand> {
  const script = join(dir, 'fake-server.mjs');
  await writeFile(script, body);
  return { exec: process.execPath, args: [script], env: { PORT: String(port) } };
}
const healthyServer = () =>
  fakeServer(`
    import { createServer } from 'http';
    createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"status":"ok"}'); }).listen(Number(process.env.PORT), '127.0.0.1');
    console.log('fake server listening');
    process.on('SIGTERM', () => process.exit(0));
  `);

const opts = () => ({ pidFile, logFile, healthUrl: `http://127.0.0.1:${port}/api/health`, waitMs: 10_000 });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ragforge-rt-'));
  port = await freePort();
  pidFile = join(dir, 'ragforge.pid');
  logFile = join(dir, 'ragforge.log');
  started = [];
});
afterEach(async () => {
  await stopDaemon({ pidFile, graceMs: 2000 }).catch(() => {});
  for (const pid of started) if (isAlive(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
});

describe('starting and stopping the server in the background', () => {
  it('starts it, waits until it answers, and reports it as running', async () => {
    const { pid, alreadyRunning } = await startDaemon({ ...opts(), command: await healthyServer() });
    started.push(pid);
    expect(alreadyRunning).toBe(false);
    expect(isAlive(pid)).toBe(true);
    const status = await daemonStatus(opts());
    expect(status).toMatchObject({ running: true, pid, healthy: true });
    expect(await readFile(logFile, 'utf8')).toContain('fake server listening');
  });

  it('does not start a second copy', async () => {
    const command = await healthyServer();
    const first = await startDaemon({ ...opts(), command });
    started.push(first.pid);
    const second = await startDaemon({ ...opts(), command });
    expect(second).toEqual({ pid: first.pid, alreadyRunning: true });
  });

  it('stops it and cleans up', async () => {
    const { pid } = await startDaemon({ ...opts(), command: await healthyServer() });
    started.push(pid);
    expect(await stopDaemon({ pidFile, graceMs: 5000 })).toBe('stopped');
    expect(isAlive(pid)).toBe(false);
    await expect(access(pidFile)).rejects.toThrow();
    expect(await daemonStatus(opts())).toMatchObject({ running: false });
  });

  it('says so when there is nothing to stop', async () => {
    expect(await stopDaemon({ pidFile, graceMs: 500 })).toBe('not-running');
  });

  it('can be started again after being stopped', async () => {
    const command = await healthyServer();
    const a = await startDaemon({ ...opts(), command });
    started.push(a.pid);
    await stopDaemon({ pidFile, graceMs: 5000 });
    const b = await startDaemon({ ...opts(), command });
    started.push(b.pid);
    expect(b.alreadyRunning).toBe(false);
    expect(b.pid).not.toBe(a.pid);
  });
});

describe('when the server cannot start', () => {
  it('fails with what the server printed, instead of waiting forever', async () => {
    const command = await fakeServer(`console.error('Invalid configuration: JWT_SECRET is missing'); process.exit(1);`);
    const error = await startDaemon({ ...opts(), command, waitMs: 15_000 }).catch((e) => e);
    expect(error).toBeInstanceOf(StartFailed);
    expect(error.message).toMatch(/JWT_SECRET is missing/);
    await expect(access(pidFile)).rejects.toThrow(); // nothing is left claiming to be running
  });

  it('gives up with a clear message when it never answers', async () => {
    const command = await fakeServer(`setInterval(() => {}, 1000);`); // runs, but never listens
    const error = await startDaemon({ ...opts(), command, waitMs: 1500 }).catch((e) => e);
    expect(error).toBeInstanceOf(StartFailed);
    expect(error.message).toMatch(/did not become ready/i);
    expect(await daemonStatus(opts())).toMatchObject({ running: false }); // it was stopped again
  });
});

describe('stale state', () => {
  it('ignores a pid file whose process is gone', async () => {
    await writeFile(pidFile, JSON.stringify({ pid: 2_000_000_000, startedAt: Date.now() }));
    expect(await daemonStatus(opts())).toMatchObject({ running: false });
    expect(await stopDaemon({ pidFile, graceMs: 200 })).toBe('not-running');
  });

  it('never kills a process just because a pid file from before the last reboot names it', async () => {
    // Our own test process is alive, but the file claims it was started before the machine booted.
    await writeFile(pidFile, JSON.stringify({ pid: process.pid, startedAt: 1000 }));
    expect(await stopDaemon({ pidFile, graceMs: 200 })).toBe('not-running');
    expect(isAlive(process.pid)).toBe(true);
    await expect(access(pidFile)).rejects.toThrow(); // the stale file is removed
  });

  it('reads old plain-number pid files as stale rather than trusting them', async () => {
    await writeFile(pidFile, String(process.pid));
    expect(await stopDaemon({ pidFile, graceMs: 200 })).toBe('not-running');
    expect(isAlive(process.pid)).toBe(true);
  });
});

describe('tailLog', () => {
  it('returns the last lines of the log', async () => {
    await writeFile(logFile, Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'));
    expect(await tailLog(logFile, 3)).toBe('line 47\nline 48\nline 49');
  });
  it('is empty when there is no log yet', async () => {
    expect(await tailLog(join(dir, 'missing.log'), 5)).toBe('');
  });
});
