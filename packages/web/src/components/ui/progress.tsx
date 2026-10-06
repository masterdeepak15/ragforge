import { cn } from '../../lib/cn';

/** A thin determinate line. Omit `value` for an indeterminate shimmer while the total is unknown. */
export function Progress({ value, label, className }: { value?: number; label: string; className?: string }) {
  const known = typeof value === 'number';
  const pct = known ? Math.max(0, Math.min(100, value)) : undefined;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct === undefined ? undefined : Math.round(pct)}
      className={cn('h-[3px] w-full overflow-hidden rounded-full bg-border', className)}
    >
      <div
        className={cn('h-full rounded-full bg-primary transition-[width] duration-300', !known && 'w-1/3 animate-pulse-slow')}
        style={known ? { width: `${pct}%` } : undefined}
      />
    </div>
  );
}
