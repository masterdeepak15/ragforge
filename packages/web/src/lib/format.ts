const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Number(value.toFixed(1))} ${UNITS[unit]}`;
}

const COUNT = new Intl.NumberFormat('en-US');
export function formatCount(n: number): string {
  return COUNT.format(n);
}

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** Server timestamps look like "2026-10-06 11:58:00" and are UTC. */
function parseServerTime(value: string): number {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  return Date.parse(iso);
}

export function timeAgo(value: string | null | undefined, now: number = Date.now()): string {
  if (!value) return '—';
  const then = parseServerTime(value);
  if (Number.isNaN(then)) return '—';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 10) return 'just now';
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86400],
    ['week', 604800],
    ['month', 2_592_000],
    ['year', 31_536_000],
  ];
  if (seconds < 60) return RTF.format(-seconds, 'second');
  for (let i = steps.length - 1; i >= 0; i--) {
    const [unit, size] = steps[i];
    if (seconds >= size) return RTF.format(-Math.floor(seconds / size), unit);
  }
  return 'just now';
}
