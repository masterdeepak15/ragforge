import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { launch } from './launch.js';

describe('launch', () => {
  it('starts programs as they are on systems other than Windows', () => {
    expect(launch('claude', ['mcp', 'add'], 'linux')).toEqual({ file: 'claude', args: ['mcp', 'add'], verbatim: false });
  });

  it('starts a program given by full path as it is, also on Windows', () => {
    expect(launch('C:\\Docker\\docker.exe', ['info'], 'win32')).toEqual({ file: 'C:\\Docker\\docker.exe', args: ['info'], verbatim: false });
  });
});

describe.skipIf(process.platform !== 'win32')('launch on Windows', () => {
  let dir: string;
  let savedPath: string | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ragforge-launch-'));
    await writeFile(join(dir, 'prog.exe'), '');
    await writeFile(join(dir, 'script.cmd'), '@echo off');
    savedPath = process.env.PATH;
    process.env.PATH = `${dir};${savedPath}`;
  });
  afterEach(async () => {
    process.env.PATH = savedPath;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('starts an .exe directly, so its arguments arrive exactly as given', () => {
    expect(launch('prog', ['a b', '"q"', 'x|y'], 'win32')).toEqual({ file: join(dir, 'prog.exe'), args: ['a b', '"q"', 'x|y'], verbatim: false });
  });

  it('runs a .cmd script through cmd.exe, quoting arguments with spaces', () => {
    const l = launch('script', ['mcp', 'add', 'Authorization: Bearer rf_x'], 'win32') as any;
    expect(l.file).toBe('cmd.exe');
    expect(l.verbatim).toBe(true);
    expect(l.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(l.args[3]).toBe(`"${join(dir, 'script.cmd')} mcp add "Authorization: Bearer rf_x""`);
  });

  it('refuses arguments cmd.exe would interpret, instead of letting them run as commands', () => {
    const l = launch('script', ['safe', 'a & calc.exe'], 'win32');
    expect(l).toHaveProperty('refused');
    expect((l as any).refused).toMatch(/cmd\.exe would interpret/);
  });

  it('leaves a program it cannot find to fail in the normal way', () => {
    expect(launch('no-such-program-xyz', ['--version'], 'win32')).toEqual({ file: 'no-such-program-xyz', args: ['--version'], verbatim: false });
  });
});
