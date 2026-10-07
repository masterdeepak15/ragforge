import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ServiceProblem, installService, serviceStatus, uninstallService, type ServiceTarget } from './service.js';
import { fail, fakeShell, ok } from './testing.js';

let root: string;
let home: string;
let userHome: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ragforge-svc-'));
  home = join(root, '.ragforge');
  userHome = join(root, 'user');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
});

const target = (platform: string, over: Partial<ServiceTarget> = {}): ServiceTarget => ({
  platform,
  node: platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/bin/node',
  script: platform === 'win32' ? 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@masterdeepak15\\ragforge\\dist\\ragforge.mjs' : '/usr/lib/node_modules/@masterdeepak15/ragforge/dist/ragforge.mjs',
  home,
  userHome,
  uid: 501,
  ...over,
});
const exists = (p: string) => access(p).then(() => true, () => false);

describe('Windows: starts when you log in (per-user Run entry, no administrator needed)', () => {
  const RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;

  it('writes a hidden launcher and registers it for the current user only', async () => {
    const { shell, calls } = fakeShell({ 'reg add': ok('The operation completed successfully.') });
    const result = await installService(shell, target('win32'));

    const vbs = await readFile(join(home, 'autostart.vbs'), 'utf8');
    expect(vbs).toContain('C:\\Program Files\\nodejs\\node.exe');
    expect(vbs).toContain('ragforge.mjs');
    expect(vbs).toMatch(/start --quiet/);
    expect(vbs).toContain(home); // keeps a custom RAGFORGE_HOME working
    expect(vbs).toMatch(/, 0, /); // window style 0 = hidden

    const add = calls.find((c) => c.cmd === 'reg')!.args;
    expect(add.slice(0, 4)).toEqual(['add', RUN_KEY, '/v', 'RAGForge']);
    expect(add).toEqual(expect.arrayContaining(['/t', 'REG_SZ', '/f']));
    expect(add[add.indexOf('/d') + 1]).toBe(`wscript.exe "${join(home, 'autostart.vbs')}"`);
    expect(result.summary).toMatch(/log in/i);
  });

  it('explains a failure', async () => {
    const { shell } = fakeShell({ 'reg add': fail('ERROR: Access is denied.') });
    await expect(installService(shell, target('win32'))).rejects.toThrow(ServiceProblem);
    await expect(installService(shell, target('win32'))).rejects.toThrow(/Access is denied/);
  });

  it('removes the entry and the launcher', async () => {
    const { shell, calls } = fakeShell({ 'reg add': ok(), 'reg delete': ok() });
    await installService(shell, target('win32'));
    expect(await uninstallService(shell, target('win32'))).toBe('removed');
    expect(calls.some((c) => c.cmd === 'reg' && c.args[0] === 'delete' && c.args.includes('RAGForge') && c.args.includes('/f'))).toBe(true);
    expect(await exists(join(home, 'autostart.vbs'))).toBe(false);
  });

  it('reports whether it is installed', async () => {
    expect(await serviceStatus(fakeShell({ 'reg query': ok('RAGForge REG_SZ wscript.exe') }).shell, target('win32'))).toBe('installed');
    expect(await serviceStatus(fakeShell({ 'reg query': fail('ERROR: The system was unable to find the specified registry key or value.') }).shell, target('win32'))).toBe('not-installed');
  });

  it('says there was nothing to remove', async () => {
    const { shell } = fakeShell({ 'reg delete': fail('ERROR: The system was unable to find the specified registry key or value.') });
    expect(await uninstallService(shell, target('win32'))).toBe('not-installed');
  });
});

describe('macOS: starts when you log in (launchd)', () => {
  const plistPath = () => join(userHome, 'Library', 'LaunchAgents', 'com.ragforge.plist');

  it('writes a launch agent that runs `ragforge start` at login', async () => {
    const { shell, calls } = fakeShell({ launchctl: ok() });
    await installService(shell, target('darwin', { script: '/Users/me/My Apps/ragforge & co/ragforge.mjs' }));
    const plist = await readFile(plistPath(), 'utf8');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<string>/usr/bin/node</string>');
    expect(plist).toContain('<string>/Users/me/My Apps/ragforge &amp; co/ragforge.mjs</string>'); // escaped
    expect(plist).toContain('<string>start</string>');
    expect(plist).toContain(`<key>RAGFORGE_HOME</key>\n    <string>${home}</string>`);
    expect(calls.some((c) => c.cmd === 'launchctl' && c.args.includes('bootstrap') && c.args.includes('gui/501'))).toBe(true);
  });

  it('unloads and deletes it', async () => {
    const { shell, calls } = fakeShell({ launchctl: ok() });
    await installService(shell, target('darwin'));
    expect(await uninstallService(shell, target('darwin'))).toBe('removed');
    expect(calls.some((c) => c.args.includes('bootout'))).toBe(true);
    expect(await exists(plistPath())).toBe(false);
  });

  it('is not installed before it is installed', async () => {
    expect(await serviceStatus(fakeShell({}).shell, target('darwin'))).toBe('not-installed');
    expect(await uninstallService(fakeShell({}).shell, target('darwin'))).toBe('not-installed');
  });
});

describe('Linux: starts when you log in (systemd user service)', () => {
  const unitPath = () => join(userHome, '.config', 'systemd', 'user', 'ragforge.service');

  it('writes a user unit and enables it', async () => {
    const { shell, calls } = fakeShell({ systemctl: ok(), loginctl: ok('Linger=no') });
    const linuxHome = '/home/me/.ragforge';
    const result = await installService(shell, target('linux', { script: '/opt/my apps/ragforge.mjs', home: linuxHome }));
    const unit = await readFile(unitPath(), 'utf8');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('RemainAfterExit=yes');
    expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/my apps/ragforge.mjs" start --quiet');
    expect(unit).toContain('ExecStop="/usr/bin/node" "/opt/my apps/ragforge.mjs" stop');
    expect(unit).toContain(`Environment="RAGFORGE_HOME=${linuxHome}"`);
    expect(unit).toContain('WantedBy=default.target');
    expect(calls.map((c) => `${c.cmd} ${c.args.join(' ')}`)).toEqual(expect.arrayContaining(['systemctl --user daemon-reload', 'systemctl --user enable ragforge.service']));
    expect(result.note).toMatch(/loginctl enable-linger/);
  });

  it('does not suggest lingering when it is already on', async () => {
    const { shell } = fakeShell({ systemctl: ok(), loginctl: ok('Linger=yes') });
    expect((await installService(shell, target('linux'))).note).toBeUndefined();
  });

  it('disables and deletes it', async () => {
    const { shell, calls } = fakeShell({ systemctl: ok(), loginctl: ok('Linger=yes') });
    await installService(shell, target('linux'));
    expect(await uninstallService(shell, target('linux'))).toBe('removed');
    expect(calls.some((c) => c.args.join(' ') === '--user disable ragforge.service')).toBe(true);
    expect(await exists(unitPath())).toBe(false);
  });

  it('reads the status from systemd', async () => {
    expect(await serviceStatus(fakeShell({ 'systemctl --user is-enabled': ok('enabled') }).shell, target('linux'))).toBe('installed');
    expect(await serviceStatus(fakeShell({ 'systemctl --user is-enabled': fail('disabled', 1) }).shell, target('linux'))).toBe('not-installed');
  });
});

describe('other systems', () => {
  it('says plainly that autostart is not supported', async () => {
    await expect(installService(fakeShell({}).shell, target('freebsd'))).rejects.toThrow(/not supported on freebsd/i);
    expect(await serviceStatus(fakeShell({}).shell, target('freebsd'))).toBe('unsupported');
  });
});
