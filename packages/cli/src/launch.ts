import { existsSync } from 'fs';

/** Finds a program on the Windows PATH the way the shell does, trying the usual executable extensions. */
function findOnWindowsPath(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(';').filter(Boolean)) {
    const base = dir.replace(/[\\/]+$/, '');
    for (const ext of ['.exe', '.com', '.cmd', '.bat']) {
      const candidate = `${base}\\${cmd}${ext}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Characters cmd.exe treats specially even inside quotes. */
const UNSAFE_FOR_CMD = /[%^&|<>"\r\n]/;

export type Launch = { file: string; args: string[]; verbatim: boolean } | { refused: string };

/**
 * How to start a program. On Windows a real program (.exe) is started directly, so its arguments arrive
 * exactly as given. Scripts such as claude.cmd and npx.cmd cannot be started that way and go through
 * cmd.exe, where quoting is fragile, so arguments with characters cmd.exe treats specially are refused.
 */
export function launch(cmd: string, args: string[], platform: string = process.platform): Launch {
  if (platform !== 'win32' || /[\\/]/.test(cmd)) return { file: cmd, args, verbatim: false };
  const found = findOnWindowsPath(cmd);
  if (!found || /\.(exe|com)$/i.test(found)) return { file: found ?? cmd, args, verbatim: false };
  const bad = args.find((a) => UNSAFE_FOR_CMD.test(a));
  if (bad !== undefined) return { refused: `Refusing to pass ${JSON.stringify(bad)} to ${cmd}: it contains characters cmd.exe would interpret.` };
  const quote = (a: string) => (/[\s()]/.test(a) ? `"${a}"` : a);
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${[found, ...args].map(quote).join(' ')}"`], verbatim: true };
}
