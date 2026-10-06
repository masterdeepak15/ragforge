import { mkdir, rm, writeFile, access } from 'fs/promises';
import { userInfo } from 'os';
import { dirname, join } from 'path';
import type { Shell } from './docker.js';

export class ServiceProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceProblem';
  }
}

export interface ServiceTarget {
  platform: string;
  /** The node program that runs RAGForge. */
  node: string;
  /** The RAGForge program file (dist/ragforge.mjs). */
  script: string;
  /** RAGForge's settings folder, passed along so a custom location keeps working. */
  home: string;
  userHome: string;
  uid?: number;
}

export type ServiceState = 'installed' | 'not-installed' | 'unsupported';

const TASK = 'RAGForge';
const LABEL = 'com.ragforge';
const exists = (p: string) => access(p).then(() => true, () => false);

const unsupported = (t: ServiceTarget) => new ServiceProblem(`Starting at login is not supported on ${t.platform}. Run \`ragforge start\` yourself.`);

/*
 * RAGForge runs as an ordinary background process that `ragforge start` and `ragforge stop` control. The
 * "service" is only the instruction to run `ragforge start` when the user logs in, so start, stop and
 * status behave the same whether or not it was started automatically.
 */

// ---- Windows: Task Scheduler (no administrator rights needed) ----
const vbs = (s: string) => s.replace(/"/g, '""');
const vbsPath = (t: ServiceTarget) => join(t.home, 'autostart.vbs');

function launcherScript(t: ServiceTarget): string {
  return [
    "' Starts RAGForge at login without showing a window. Created by `ragforge service install`.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Environment("PROCESS")("RAGFORGE_HOME") = "${vbs(t.home)}"`,
    `shell.Run """${vbs(t.node)}"" ""${vbs(t.script)}"" start --quiet", 0, True`,
    '',
  ].join('\r\n');
}

// ---- macOS: launchd ----
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const plistPath = (t: ServiceTarget) => join(t.userHome, 'Library', 'LaunchAgents', `${LABEL}.plist`);

function plist(t: ServiceTarget): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(t.node)}</string>
    <string>${xml(t.script)}</string>
    <string>start</string>
    <string>--quiet</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RAGFORGE_HOME</key>
    <string>${xml(t.home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(join(t.home, 'autostart.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(t.home, 'autostart.log'))}</string>
</dict>
</plist>
`;
}

// ---- Linux: systemd user unit ----
const unitPath = (t: ServiceTarget) => join(t.userHome, '.config', 'systemd', 'user', 'ragforge.service');
const sd = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

function unit(t: ServiceTarget): string {
  return `[Unit]
Description=RAGForge knowledge base
After=network-online.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=${sd(`RAGFORGE_HOME=${t.home}`)}
ExecStart=${sd(t.node)} ${sd(t.script)} start --quiet
ExecStop=${sd(t.node)} ${sd(t.script)} stop

[Install]
WantedBy=default.target
`;
}

export async function installService(shell: Shell, t: ServiceTarget): Promise<{ summary: string; note?: string }> {
  if (t.platform === 'win32') {
    await mkdir(t.home, { recursive: true });
    await writeFile(vbsPath(t), launcherScript(t));
    const r = await shell.run('schtasks', ['/Create', '/TN', TASK, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F', '/TR', `wscript.exe "${vbsPath(t)}"`]);
    if (r.code !== 0) throw new ServiceProblem(`Could not register the startup task: ${(r.stderr || r.stdout).trim()}`);
    return { summary: 'RAGForge will start automatically when you log in to Windows (Task Scheduler task "RAGForge").' };
  }

  if (t.platform === 'darwin') {
    await mkdir(dirname(plistPath(t)), { recursive: true });
    await mkdir(t.home, { recursive: true });
    await writeFile(plistPath(t), plist(t));
    const domain = `gui/${t.uid ?? 501}`;
    await shell.run('launchctl', ['bootout', `${domain}/${LABEL}`]); // replace an older copy; fine if there is none
    const r = await shell.run('launchctl', ['bootstrap', domain, plistPath(t)]);
    if (r.code !== 0) throw new ServiceProblem(`Could not load the launch agent: ${(r.stderr || r.stdout).trim()}`);
    return { summary: 'RAGForge will start automatically when you log in (launch agent com.ragforge).' };
  }

  if (t.platform === 'linux') {
    await mkdir(dirname(unitPath(t)), { recursive: true });
    await writeFile(unitPath(t), unit(t));
    await shell.run('systemctl', ['--user', 'daemon-reload']);
    const r = await shell.run('systemctl', ['--user', 'enable', 'ragforge.service']);
    if (r.code !== 0) throw new ServiceProblem(`Could not enable the systemd user service: ${(r.stderr || r.stdout).trim()}`);
    const linger = await shell.run('loginctl', ['show-user', userInfo().username, '-p', 'Linger']);
    const note = /Linger=yes/.test(linger.stdout) ? undefined : 'It starts when you log in. To also start at boot, before anyone logs in, run once: loginctl enable-linger $USER';
    return { summary: 'RAGForge will start automatically when you log in (systemd user service ragforge).', note };
  }

  throw unsupported(t);
}

export async function uninstallService(shell: Shell, t: ServiceTarget): Promise<'removed' | 'not-installed'> {
  if (t.platform === 'win32') {
    const r = await shell.run('schtasks', ['/Delete', '/TN', TASK, '/F']);
    await rm(vbsPath(t), { force: true });
    return r.code === 0 ? 'removed' : 'not-installed';
  }
  if (t.platform === 'darwin') {
    if (!(await exists(plistPath(t)))) return 'not-installed';
    await shell.run('launchctl', ['bootout', `gui/${t.uid ?? 501}/${LABEL}`]);
    await rm(plistPath(t), { force: true });
    return 'removed';
  }
  if (t.platform === 'linux') {
    if (!(await exists(unitPath(t)))) return 'not-installed';
    await shell.run('systemctl', ['--user', 'disable', 'ragforge.service']);
    await rm(unitPath(t), { force: true });
    await shell.run('systemctl', ['--user', 'daemon-reload']);
    return 'removed';
  }
  throw unsupported(t);
}

export async function serviceStatus(shell: Shell, t: ServiceTarget): Promise<ServiceState> {
  if (t.platform === 'win32') return (await shell.run('schtasks', ['/Query', '/TN', TASK])).code === 0 ? 'installed' : 'not-installed';
  if (t.platform === 'darwin') return (await exists(plistPath(t))) ? 'installed' : 'not-installed';
  if (t.platform === 'linux') return (await shell.run('systemctl', ['--user', 'is-enabled', 'ragforge.service'])).code === 0 ? 'installed' : 'not-installed';
  return 'unsupported';
}
