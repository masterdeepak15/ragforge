import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { ErrorState } from '../../components/ui/empty-state';
import { Skeleton } from '../../components/ui/skeleton';
import { toast } from '../../components/ui/toaster';
import { useResetRetrievalSettings, useRetrievalSettings, useSaveRetrievalSettings } from './queries';
import { RetrievalSettingsForm } from './RetrievalSettingsForm';
import type { RetrievalSettings } from './types';

const same = (a: RetrievalSettings, b: RetrievalSettings) =>
  a.topK === b.topK && a.useHybridSearch === b.useHybridSearch && a.vectorWeight === b.vectorWeight && a.bm25Weight === b.bm25Weight && a.minSimilarity === b.minSimilarity;

/** Settings tab section: how this knowledge base is searched, for the Playground, Chat and connected AI tools. */
export function RetrievalSection({ kbId }: { kbId: string }) {
  const query = useRetrievalSettings(kbId);
  const save = useSaveRetrievalSettings(kbId);
  const reset = useResetRetrievalSettings(kbId);
  const saved = query.data?.settings;
  const [draft, setDraft] = useState<RetrievalSettings | null>(null);
  const [error, setError] = useState('');

  // Follow the server: after loading, saving or resetting, the form shows what is saved.
  useEffect(() => {
    if (saved) setDraft(saved);
  }, [saved]);

  const submit = async () => {
    if (!draft) return;
    setError('');
    try {
      await save.mutateAsync(draft);
      toast.success('Search settings saved');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const restore = async () => {
    setError('');
    try {
      await reset.mutateAsync();
      toast.success('Search settings reset to the defaults');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section aria-labelledby="retrieval-heading" className="rounded-lg border border-border bg-card p-5">
      <h2 id="retrieval-heading" className="text-sm font-semibold">Search</h2>
      <p className="mt-1 text-sm text-muted-foreground">How this knowledge base is searched. Used by the Playground, Chat and connected AI tools.</p>

      {query.isError ? (
        <div className="mt-4">
          <ErrorState title="Could not load the search settings" message={(query.error as Error).message} onRetry={() => void query.refetch()} />
        </div>
      ) : !draft || !saved ? (
        <Skeleton className="mt-4 h-40 w-full" />
      ) : (
        <div className="mt-5 space-y-5">
          <RetrievalSettingsForm value={draft} onChange={setDraft} />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void submit()} loading={save.isPending} disabled={same(draft, saved)}>Save settings</Button>
            {query.data?.customized && (
              <Button variant="secondary" onClick={() => void restore()} loading={reset.isPending}>Reset to defaults</Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
