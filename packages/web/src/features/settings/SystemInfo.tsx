import { ErrorState } from '../../components/ui/empty-state';
import { Skeleton } from '../../components/ui/skeleton';
import { formatBytes } from '../../lib/format';
import { useStats } from '../dashboard/useStats';

/** Read-only facts about this installation: version, database, ingestion workers, storage. */
export function SystemInfo() {
  const { data, isLoading, isError, error, refetch } = useStats();

  return (
    <section aria-labelledby="system-heading" className="mb-8 rounded-lg border border-border bg-card p-5">
      <h2 id="system-heading" className="text-sm font-semibold">System</h2>
      {isLoading ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : isError || !data ? (
        <div className="mt-3">
          <ErrorState title="Could not load system information" message={(error as Error)?.message ?? 'Unknown error'} onRetry={() => void refetch()} />
        </div>
      ) : (
        <dl className="mt-3 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Version</dt>
            <dd className="font-medium">RAGForge {data.system.version}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Database</dt>
            <dd className="font-medium">{data.system.storageMode === 'postgres' ? 'PostgreSQL with pgvector' : 'SQLite (local file)'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Indexing workers</dt>
            <dd className="font-medium">{`${data.system.ingestConcurrency} at a time, ${data.system.workerRunning ? 'running' : 'stopped'}`}</dd>
            <dd className="text-[13px] text-muted-foreground">Set INGEST_CONCURRENCY and restart to change how many files are indexed at once.</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Uploaded files</dt>
            <dd className="font-medium">{formatBytes(data.storageBytes)}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
