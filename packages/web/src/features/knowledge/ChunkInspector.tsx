import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent } from '../../components/ui/dialog';
import { ErrorState } from '../../components/ui/empty-state';
import { Skeleton } from '../../components/ui/skeleton';
import { api } from '../../lib/api-client';
import { formatCount } from '../../lib/format';
import type { DocumentRow } from './types';

interface ChunkRow {
  id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
}
interface ChunkPage {
  chunks: ChunkRow[];
  pagination: { page: number; limit: number; total: number };
}

const LIMIT = 20;

/** Shows the exact text pieces a document was split into: what the assistant can retrieve and cite. */
export function ChunkInspector({ doc, onClose }: { doc: DocumentRow | null; onClose: () => void }) {
  const query = useInfiniteQuery({
    queryKey: ['chunks', doc?.id],
    enabled: !!doc,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api.get<ChunkPage>(`/api/documents/${doc!.id}/chunks?page=${pageParam}&limit=${LIMIT}`),
    getNextPageParam: (last) => (last.pagination.page * last.pagination.limit < last.pagination.total ? last.pagination.page + 1 : undefined),
  });
  const chunks = query.data?.pages.flatMap((p) => p.chunks) ?? [];

  return (
    <Dialog open={!!doc} onOpenChange={(open) => !open && onClose()}>
      {doc && (
        <DialogContent title={doc.title} description={`${formatCount(doc.chunk_count ?? 0)} chunks. This is the text your assistants search and cite.`} className="max-w-2xl">
          {query.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : query.isError ? (
            <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />
          ) : chunks.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No chunks are stored for this document.</p>
          ) : (
            <ol className="space-y-2">
              {chunks.map((c) => (
                <li key={c.id} className="rounded-md border border-border bg-background p-3">
                  <p className="mb-1 text-xs text-muted-foreground">
                    Chunk {c.chunk_index + 1} · {formatCount(c.token_count ?? 0)} tokens
                  </p>
                  <p className="line-clamp-6 whitespace-pre-wrap text-sm leading-relaxed">{c.content}</p>
                </li>
              ))}
            </ol>
          )}
          {query.hasNextPage && (
            <div className="mt-3 text-center">
              <Button variant="secondary" size="sm" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                Show more chunks
              </Button>
            </div>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}
