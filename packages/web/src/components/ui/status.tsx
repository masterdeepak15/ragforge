import { cn } from '../../lib/cn';

export type StatusKind = 'ready' | 'processing' | 'queued' | 'failed' | 'cancelled';

const STYLE: Record<StatusKind, { label: string; color: string; pulse?: boolean }> = {
  ready: { label: 'Ready', color: 'text-success' },
  processing: { label: 'Processing', color: 'text-primary', pulse: true },
  queued: { label: 'Queued', color: 'text-muted-foreground' },
  failed: { label: 'Failed', color: 'text-destructive' },
  cancelled: { label: 'Cancelled', color: 'text-muted-foreground' },
};

/** Maps a document or job status string from the API onto a display kind. */
export function toStatusKind(status: string): StatusKind {
  switch (status) {
    case 'ready':
    case 'done':
      return 'ready';
    case 'processing':
    case 'running':
      return 'processing';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'queued'; // pending, queued
  }
}

/** A coloured dot plus a word: colour is never the only carrier of meaning. */
export function Status({ kind, label, className }: { kind: StatusKind; label?: string; className?: string }) {
  const s = STYLE[kind];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', s.color, className)}>
      <span aria-hidden className={cn('size-1.5 rounded-full bg-current', s.pulse && 'animate-pulse-slow')} />
      {label ?? s.label}
    </span>
  );
}
