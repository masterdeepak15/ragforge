import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FileText, Layers, Search, Trash2, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { EmptyState } from '../../components/ui/empty-state';
import { Input } from '../../components/ui/input';
import { Skeleton } from '../../components/ui/skeleton';
import { Status, toStatusKind } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import { formatBytes, formatCount, timeAgo } from '../../lib/format';
import type { DocumentCounts, DocumentFilters, DocumentRow } from './types';

const ROW_HEIGHT = 56;
const COLUMNS = 'grid-cols-[32px_minmax(0,1fr)_104px_40px] md:grid-cols-[32px_minmax(0,1fr)_112px_72px_84px_120px_40px]';

export interface DocumentsTableProps {
  items: DocumentRow[];
  total: number;
  counts: DocumentCounts;
  filters: DocumentFilters;
  onFiltersChange: (filters: DocumentFilters) => void;
  hasMore: boolean;
  /** True while a page is being fetched. */
  loading: boolean;
  onLoadMore: () => void;
  onDelete: (ids: string[]) => void | Promise<unknown>;
  onViewChunks: (doc: DocumentRow) => void;
  searchDebounceMs?: number;
}

const FILTERS: Array<{ value: DocumentFilters['status']; label: string; count: (c: DocumentCounts) => number }> = [
  { value: 'all', label: 'All', count: (c) => c.ready + c.failed + c.processing + c.pending },
  { value: 'ready', label: 'Ready', count: (c) => c.ready },
  { value: 'processing', label: 'Processing', count: (c) => c.processing + c.pending },
  { value: 'failed', label: 'Failed', count: (c) => c.failed },
];

const TYPE_LABEL: Record<string, string> = { pdf: 'PDF', docx: 'DOC', md: 'MD', txt: 'TXT', url: 'URL' };

export function DocumentsTable({
  items, total, counts, filters, onFiltersChange, hasMore, loading, onLoadMore, onDelete, onViewChunks, searchDebounceMs = 300,
}: DocumentsTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [q, setQ] = useState(filters.q);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();

  // Selection never outlives what is on screen: a filter change could otherwise delete hidden rows.
  useEffect(() => setSelected(new Set()), [filters.status, filters.q]);
  useEffect(() => setQ(filters.q), [filters.q]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    initialRect: { width: 900, height: 560 },
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisible = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;

  useEffect(() => {
    if (hasMore && !loading && lastVisible >= items.length - 10 && items.length > 0) onLoadMore();
  }, [hasMore, loading, lastVisible, items.length, onLoadMore]);

  const onSearch = (value: string) => {
    setQ(value);
    clearTimeout(searchTimer.current);
    if (searchDebounceMs <= 0) onFiltersChange({ status: filters.status, q: value });
    else searchTimer.current = setTimeout(() => onFiltersChange({ status: filters.status, q: value }), searchDebounceMs);
  };
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const allSelected = items.length > 0 && items.every((d) => selected.has(d.id));
  const someSelected = selected.size > 0 && !allSelected;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const filtered = filters.status !== 'all' || filters.q !== '';
  const ids = useMemo(() => items.filter((d) => selected.has(d.id)).map((d) => d.id), [items, selected]);

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await Promise.resolve(onDelete(ids));
      setSelected(new Set());
      setConfirming(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section aria-labelledby="documents-heading">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="documents-heading" className="text-sm font-semibold">Documents</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="Filter by status">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => onFiltersChange({ status: f.value, q: filters.q })}
                aria-pressed={filters.status === f.value}
                className={cn(
                  'rounded px-2.5 py-1 text-[13px] font-medium',
                  filters.status === f.value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {f.label} <span className="text-muted-foreground">{formatCount(f.count(counts))}</span>
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input type="search" aria-label="Search documents" placeholder="Search by name" value={q} onChange={(e) => onSearch(e.target.value)} className="w-56 pl-8" />
          </div>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-lg bg-accent px-3.5 py-2 text-sm text-accent-foreground">
          <span className="font-medium">{selected.size} selected</span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              <X /> Clear selection
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>
              <Trash2 /> Delete selected
            </Button>
          </div>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div data-testid="documents-loading" className="space-y-2 rounded-lg border border-border bg-card p-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState
            icon={Search}
            title="No documents match"
            description="Try a different name or status."
            action={<Button variant="secondary" onClick={() => onFiltersChange({ status: 'all', q: '' })}>Clear filters</Button>}
          />
        ) : (
          <EmptyState icon={FileText} title="No documents yet" description="Upload PDFs, Word files, Markdown or text to start building this knowledge base." />
        )
      ) : (
        <div role="table" aria-label="Documents" aria-rowcount={total + 1} className="overflow-hidden rounded-lg border border-border bg-card text-sm">
          <div role="row" aria-rowindex={1} className={cn('grid items-center gap-3 border-b border-border bg-muted/50 px-3.5 py-2.5 text-xs font-medium text-muted-foreground', COLUMNS)}>
            <span role="columnheader">
              <input
                type="checkbox"
                aria-label="Select all loaded documents"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((d) => d.id)))}
              />
            </span>
            <span role="columnheader">Name</span>
            <span role="columnheader">Status</span>
            <span role="columnheader" className="hidden md:block">Chunks</span>
            <span role="columnheader" className="hidden md:block">Size</span>
            <span role="columnheader" className="hidden md:block">Added</span>
            <span role="columnheader" />
          </div>

          <div ref={scrollRef} className="max-h-[60vh] min-h-[120px] overflow-auto">
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualItems.map((v) => {
                const d = items[v.index];
                const isSelected = selected.has(d.id);
                return (
                  <div
                    key={d.id}
                    role="row"
                    aria-rowindex={v.index + 2}
                    aria-selected={isSelected}
                    className={cn('absolute left-0 top-0 grid w-full items-center gap-3 border-b border-border px-3.5', COLUMNS, isSelected && 'bg-accent/60')}
                    style={{ height: ROW_HEIGHT, transform: `translateY(${v.start}px)` }}
                  >
                    <span role="cell">
                      <input type="checkbox" aria-label={`Select ${d.title}`} checked={isSelected} onChange={() => toggle(d.id)} />
                    </span>
                    <span role="cell" className="flex min-w-0 items-center gap-2.5">
                      <span className="grid size-[30px] shrink-0 place-items-center rounded-md bg-muted text-[10.5px] font-bold text-muted-foreground" aria-hidden>
                        {TYPE_LABEL[d.source_type] ?? 'FILE'}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{d.title}</span>
                        {d.status === 'failed' && d.error_message && <span className="block truncate text-[13px] text-destructive">{d.error_message}</span>}
                      </span>
                    </span>
                    <span role="cell"><Status kind={toStatusKind(d.status)} /></span>
                    <span role="cell" className="hidden text-muted-foreground md:block">{formatCount(d.chunk_count ?? 0)}</span>
                    <span role="cell" className="hidden text-muted-foreground md:block">{formatBytes(d.file_size)}</span>
                    <span role="cell" className="hidden text-muted-foreground md:block">{timeAgo(d.created_at)}</span>
                    <span role="cell" className="text-right">
                      <Button variant="ghost" size="icon" aria-label={`View chunks of ${d.title}`} onClick={() => onViewChunks(d)} disabled={d.status !== 'ready'}>
                        <Layers />
                      </Button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          {hasMore && <p className="border-t border-border px-3.5 py-2 text-center text-xs text-muted-foreground">Showing {formatCount(items.length)} of {formatCount(total)}. Scroll for more.</p>}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${ids.length} ${ids.length === 1 ? 'document' : 'documents'}?`}
        description="Their text is removed from search and from answers, and the uploaded files are deleted. This can't be undone."
        confirmLabel={ids.length === 1 ? 'Delete document' : 'Delete documents'}
        destructive
        pending={deleting}
        onConfirm={confirmDelete}
      />
    </section>
  );
}
