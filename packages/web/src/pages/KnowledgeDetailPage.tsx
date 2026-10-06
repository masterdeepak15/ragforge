import { useCallback, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link2, Upload } from 'lucide-react';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Dialog, DialogContent } from '../components/ui/dialog';
import { EmptyState, ErrorState } from '../components/ui/empty-state';
import { Input } from '../components/ui/input';
import { PageHeader } from '../components/ui/page-header';
import { Skeleton } from '../components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { toast } from '../components/ui/toaster';
import { ApiError, api } from '../lib/api-client';
import { formatBytes, formatCount } from '../lib/format';
import { queryKeys } from '../lib/queries';
import { uploadFiles, type UploadHandle, type UploadItem } from '../lib/upload';
import { ChunkInspector } from '../features/knowledge/ChunkInspector';
import { DocumentsTable } from '../features/knowledge/DocumentsTable';
import { ProcessingTable } from '../features/knowledge/ProcessingTable';
import { UploadDropzone, type UploadDropzoneHandle } from '../features/knowledge/UploadDropzone';
import { useIngestionEvents } from '../features/knowledge/events';
import { useCancelJob, useDeleteDocuments, useDocuments, useJobs, useKnowledgeBase, useRetryJob } from '../features/knowledge/queries';
import type { DocumentFilters, DocumentRow } from '../features/knowledge/types';

function AddUrlDialog({ kbId, open, onOpenChange }: { kbId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const add = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('knowledgeBaseId', kbId);
      form.append('url', url.trim());
      return api.request<{ items: Array<{ deduplicated: boolean }> }>('POST', '/api/documents/upload', form);
    },
    onSuccess: (res) => {
      toast.success(res.items[0]?.deduplicated ? 'That page is already in this knowledge base' : 'Page added. It will be indexed in the background.');
      for (const key of ['documents', 'jobs', 'kb']) void qc.invalidateQueries({ queryKey: [key, kbId] });
      setUrl('');
      onOpenChange(false);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) add.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !add.isPending && onOpenChange(next)}>
      <DialogContent title="Add a web page" description="The page's readable text is fetched and indexed.">
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="page-url" className="text-sm font-medium">Page address</label>
            <Input id="page-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/docs/getting-started" autoFocus />
          </div>
          {add.isError && (
            <p role="alert" className="text-sm text-destructive">
              {(add.error as Error).message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={add.isPending}>Cancel</Button>
            <Button type="submit" disabled={!url.trim()} loading={add.isPending}>Add page</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function KnowledgeDetailPage() {
  const { id: kbId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const kbQuery = useKnowledgeBase(kbId);
  const [filters, setFilters] = useState<DocumentFilters>({ status: 'all', q: '' });
  const docsQuery = useDocuments(kbId, filters);
  const jobsQuery = useJobs(kbId);
  useIngestionEvents(kbId);

  const retryJob = useRetryJob(kbId ?? '');
  const cancelJob = useCancelJob(kbId ?? '');
  const deleteDocs = useDeleteDocuments(kbId ?? '');

  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const handles = useRef<UploadHandle[]>([]);
  const dropzone = useRef<UploadDropzoneHandle>(null);
  const [inspecting, setInspecting] = useState<DocumentRow | null>(null);
  const [addingUrl, setAddingUrl] = useState(false);
  const [deletingKb, setDeletingKb] = useState(false);

  const removeKb = useMutation({
    mutationFn: () => api.del(`/api/knowledge-bases/${kbId}`),
    onSuccess: () => {
      toast.success(`Deleted “${kbQuery.data?.name}”`);
      void qc.invalidateQueries({ queryKey: queryKeys.knowledgeBases });
      navigate('/knowledge-bases');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const startUpload = useCallback(
    (files: File[]) => {
      if (!kbId) return;
      const handle = uploadFiles(files, kbId, (item) =>
        setUploads((prev) => (prev.some((u) => u.id === item.id) ? prev.map((u) => (u.id === item.id ? item : u)) : [...prev, item])),
      );
      handles.current.push(handle);
      void handle.done.then(() => {
        for (const key of ['documents', 'jobs', 'kb']) void qc.invalidateQueries({ queryKey: [key, kbId] });
        void qc.invalidateQueries({ queryKey: queryKeys.knowledgeBases });
        toast.success(files.length === 1 ? `Uploaded ${files[0].name}` : `Uploaded ${formatCount(files.length)} files. Indexing continues in the background.`);
      });
    },
    [kbId, qc],
  );

  const loadMore = useCallback(() => {
    if (docsQuery.hasNextPage && !docsQuery.isFetchingNextPage) void docsQuery.fetchNextPage();
  }, [docsQuery]);

  if (kbQuery.isError) {
    const notFound = kbQuery.error instanceof ApiError && kbQuery.error.status === 404;
    return (
      <div className="mx-auto max-w-5xl px-5 py-6 md:px-8">
        {notFound ? (
          <EmptyState
            icon={Upload}
            title="Knowledge base not found"
            description="It may have been deleted."
            action={
              <Button asChild variant="secondary">
                <Link to="/knowledge-bases">Back to knowledge bases</Link>
              </Button>
            }
          />
        ) : (
          <ErrorState title="Could not load this knowledge base" message={(kbQuery.error as Error).message} onRetry={() => void kbQuery.refetch()} />
        )}
      </div>
    );
  }

  const kb = kbQuery.data;
  const first = docsQuery.data?.pages[0];
  const items = docsQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const stats = first?.stats;
  const processing = (first?.counts.processing ?? 0) + (first?.counts.pending ?? 0);

  const summary = stats
    ? [
        `${formatCount(stats.readyDocuments)} ${stats.readyDocuments === 1 ? 'document' : 'documents'} ready`,
        `${formatCount(stats.chunks)} ${stats.chunks === 1 ? 'chunk' : 'chunks'}`,
        formatBytes(stats.bytes),
        ...(processing > 0 ? [`${formatCount(processing)} processing`] : []),
      ].join(' · ')
    : undefined;

  return (
    <div className="mx-auto max-w-5xl px-5 py-6 md:px-8">
      {kb ? (
        <PageHeader
          crumbs={[{ label: 'Knowledge bases', to: '/knowledge-bases' }, { label: kb.name }]}
          title={kb.name}
          description={
            <>
              {kb.description && <span className="block">{kb.description}</span>}
              <span className="block">{summary ?? <Skeleton className="mt-1 inline-block h-4 w-64 align-middle" />}</span>
            </>
          }
          actions={
            <>
              <Button variant="secondary" onClick={() => setAddingUrl(true)}>
                <Link2 /> Add URL
              </Button>
              <Button onClick={() => dropzone.current?.open()}>
                <Upload /> Upload files
              </Button>
            </>
          }
        />
      ) : (
        <div className="mb-6 space-y-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-8 w-72" />
        </div>
      )}

      <Tabs defaultValue="documents">
        <TabsList className="mb-5">
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="documents" className="space-y-6">
          <UploadDropzone ref={dropzone} onFiles={startUpload} />
          <ProcessingTable
            uploads={uploads}
            jobs={jobsQuery.data ?? []}
            onRetry={(jobId) => retryJob.mutate(jobId, { onError: (e) => toast.error((e as Error).message) })}
            onCancelJob={(jobId) => cancelJob.mutate(jobId, { onError: (e) => toast.error((e as Error).message) })}
            onCancelUploads={() => handles.current.forEach((h) => h.cancel())}
            onClearUploads={() => setUploads((prev) => prev.filter((u) => u.status === 'uploading' || u.status === 'queued'))}
          />
          {docsQuery.isError ? (
            <ErrorState title="Could not load documents" message={(docsQuery.error as Error).message} onRetry={() => void docsQuery.refetch()} />
          ) : (
            <DocumentsTable
              items={items}
              total={first?.total ?? 0}
              counts={first?.counts ?? { ready: 0, failed: 0, processing: 0, pending: 0 }}
              filters={filters}
              onFiltersChange={setFilters}
              hasMore={!!docsQuery.hasNextPage}
              loading={docsQuery.isLoading || docsQuery.isFetchingNextPage}
              onLoadMore={loadMore}
              onViewChunks={setInspecting}
              onDelete={async (ids) => {
                try {
                  const res = await deleteDocs.mutateAsync(ids);
                  toast.success(`Deleted ${formatCount(res.deleted)} ${res.deleted === 1 ? 'document' : 'documents'}`);
                } catch (err) {
                  toast.error((err as Error).message);
                  throw err;
                }
              }}
            />
          )}
        </TabsContent>

        <TabsContent value="settings" className="space-y-6">
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-sm font-semibold">Indexing</h2>
            <p className="mt-1 text-sm text-muted-foreground">These are fixed when documents are indexed.</p>
            <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
              <div><dt className="text-muted-foreground">Embedding model</dt><dd className="font-medium">{kb?.embedding_model ?? '—'}</dd></div>
              <div><dt className="text-muted-foreground">Vector dimension</dt><dd className="font-medium">{kb?.embedding_dimension ?? '—'}</dd></div>
              <div><dt className="text-muted-foreground">Chunk size</dt><dd className="font-medium">{formatCount(kb?.chunk_size ?? 0)} tokens</dd></div>
              <div><dt className="text-muted-foreground">Chunk overlap</dt><dd className="font-medium">{formatCount(kb?.chunk_overlap ?? 0)} tokens</dd></div>
            </dl>
          </section>
          <section className="rounded-lg border border-destructive/30 bg-card p-5">
            <h2 className="text-sm font-semibold text-destructive">Delete this knowledge base</h2>
            <p className="mt-1 text-sm text-muted-foreground">Removes every document and its search data. Connected AI tools lose access to it.</p>
            <Button variant="destructive" className="mt-4" onClick={() => setDeletingKb(true)}>Delete knowledge base</Button>
          </section>
        </TabsContent>
      </Tabs>

      {kbId && <AddUrlDialog kbId={kbId} open={addingUrl} onOpenChange={setAddingUrl} />}
      <ChunkInspector doc={inspecting} onClose={() => setInspecting(null)} />
      <ConfirmDialog
        open={deletingKb}
        onOpenChange={setDeletingKb}
        title={`Delete “${kb?.name ?? ''}”?`}
        description="All documents and their search data are removed. This can't be undone."
        confirmLabel="Delete knowledge base"
        destructive
        pending={removeKb.isPending}
        onConfirm={() => removeKb.mutate()}
      />
    </div>
  );
}
