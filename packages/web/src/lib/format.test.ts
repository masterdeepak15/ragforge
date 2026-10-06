import { describe, it, expect } from 'vitest';
import { formatBytes, formatCount, timeAgo } from './format';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1536, '1.5 KB'],
    [1048576, '1 MB'],
    [4.2 * 1024 ** 3, '4.2 GB'],
    [1024 ** 4 * 2, '2 TB'],
  ])('formats %d as %s', (n, out) => {
    expect(formatBytes(n)).toBe(out);
  });
  it('shows a dash for unknown sizes', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
  });
});

describe('formatCount', () => {
  it('adds thousands separators', () => {
    expect(formatCount(96410)).toBe('96,410');
    expect(formatCount(0)).toBe('0');
  });
});

describe('timeAgo', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  it('reads server timestamps (UTC, no zone suffix)', () => {
    expect(timeAgo('2026-10-06 11:58:00', now)).toBe('2 minutes ago');
    expect(timeAgo('2026-10-06 09:00:00', now)).toBe('3 hours ago');
    expect(timeAgo('2026-10-05 12:00:00', now)).toBe('yesterday');
    expect(timeAgo('2026-09-20 12:00:00', now)).toBe('2 weeks ago');
  });
  it('says "just now" for the last few seconds and never shows the future', () => {
    expect(timeAgo('2026-10-06 11:59:58', now)).toBe('just now');
    expect(timeAgo('2026-10-06 12:05:00', now)).toBe('just now');
  });
  it('tolerates missing or invalid input', () => {
    expect(timeAgo(null, now)).toBe('—');
    expect(timeAgo('garbage', now)).toBe('—');
  });
});
