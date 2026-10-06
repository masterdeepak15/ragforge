import { cn } from '../../lib/cn';

/** Placeholder block shown while content loads; keeps layout stable (no shift when data arrives). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse-slow rounded-md bg-muted', className)} />;
}
