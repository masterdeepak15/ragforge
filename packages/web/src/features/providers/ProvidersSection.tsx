import { useState } from 'react';
import { Info, Plus, Trash2, Zap } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { EmptyState, ErrorState } from '../../components/ui/empty-state';
import { Skeleton } from '../../components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '../../components/ui/table';
import { toast } from '../../components/ui/toaster';
import { AddProviderDialog } from './AddProviderDialog';
import { useProviderSpecs, useProviders, useRemoveProvider, useSetDefault, useTestSaved } from './queries';
import type { ProviderConfig, ProviderSpec, TestResult } from './types';

function RoleSummary({ label, provider, model }: { label: string; provider?: ProviderConfig; model?: string | null }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{provider ? `${provider.name} · ${model ?? 'default model'}` : <span className="text-warning">Not set</span>}</p>
    </div>
  );
}

function Chip({ children }: { children: string }) {
  return <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">{children}</span>;
}

/** Everything about AI providers: which one answers, which one indexes, adding, testing and removing. */
export function ProvidersSection() {
  const providers = useProviders();
  const specsQuery = useProviderSpecs();
  const setDefault = useSetDefault();
  const remove = useRemoveProvider();
  const testSaved = useTestSaved();

  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProviderConfig | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});

  const specs = specsQuery.data ?? [];
  const specOf = (p: ProviderConfig): ProviderSpec | undefined => specs.find((s) => s.type === p.provider);
  const list = providers.data ?? [];
  const answering = list.find((p) => p.isDefaultLlm);
  const indexing = list.find((p) => p.isDefaultEmbedding);

  const indexingWarning = (() => {
    if (indexing) return null;
    if (list.length === 0) return 'Documents cannot be indexed until you add an AI provider.';
    const canEmbed = list.some((p) => specOf(p)?.supportsEmbeddings);
    if (!canEmbed) return `Documents cannot be indexed yet. ${specOf(list[0])?.label ?? 'This provider'} cannot create embeddings, so add another provider for indexing (Ollama, OpenAI or Google Gemini).`;
    return 'Documents cannot be indexed until a provider is chosen for indexing. Use the “Use … for indexing” button below.';
  })();

  const addButton = (
    <Button onClick={() => setAdding(true)} disabled={specs.length === 0}>
      <Plus /> Add provider
    </Button>
  );

  const runTest = async (p: ProviderConfig) => {
    // Drop the previous message first so a stale result never sits next to a running test.
    setResults((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== p.id)));
    try {
      const result = await testSaved.mutateAsync(p.id);
      setResults((prev) => ({ ...prev, [p.id]: result }));
    } catch (e) {
      setResults((prev) => ({ ...prev, [p.id]: { ok: false, message: (e as Error).message } }));
    }
  };

  return (
    <section aria-labelledby="providers-heading" className="mb-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="providers-heading" className="text-base font-semibold">AI providers</h2>
          <p className="text-sm text-muted-foreground">One provider writes answers and one indexes your documents. A single provider such as OpenAI or Ollama can do both.</p>
        </div>
        {addButton}
      </div>

      {providers.isLoading || specsQuery.isLoading ? (
        <div className="space-y-2 rounded-lg border border-border bg-card p-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : providers.isError || specsQuery.isError ? (
        <ErrorState
          title="Could not load AI providers"
          message={((providers.error ?? specsQuery.error) as Error).message}
          onRetry={() => {
            void providers.refetch();
            void specsQuery.refetch();
          }}
        />
      ) : (
        <>
          <div className="mb-3 grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-2">
            <RoleSummary label="Used for answers" provider={answering} model={answering?.defaultLlmModel} />
            <RoleSummary label="Used for indexing" provider={indexing} model={indexing?.defaultEmbeddingModel} />
          </div>

          {indexingWarning && (
            <p role="status" className="mb-3 flex items-start gap-2 rounded-md bg-accent px-3.5 py-2.5 text-sm text-accent-foreground">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{indexingWarning}</span>
            </p>
          )}

          {list.length === 0 ? (
            <EmptyState icon={Zap} title="No AI provider yet" description="Connect Ollama for a free local setup, or add an API key for OpenAI, Google Gemini, Anthropic or Groq." action={addButton} />
          ) : (
            <Table aria-label="AI providers">
              <THead>
                <TR>
                  <TH>Provider</TH>
                  <TH className="hidden md:table-cell">Models</TH>
                  <TH>Roles</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {list.map((p) => {
                  const spec = specOf(p);
                  const result = results[p.id];
                  return (
                    <TR key={p.id}>
                      <TD>
                        <p className="font-medium">{p.name}</p>
                        <p className="text-[13px] text-muted-foreground">{spec?.label ?? p.provider}{p.baseUrl ? ` · ${p.baseUrl}` : ''}</p>
                        {result && (
                          <p role="status" className={result.ok ? 'mt-1 text-[13px] text-success' : 'mt-1 text-[13px] text-destructive'}>
                            {result.ok ? `Connected. Found ${result.models.length} ${result.models.length === 1 ? 'model' : 'models'}.` : result.message}
                          </p>
                        )}
                      </TD>
                      <TD className="hidden text-muted-foreground md:table-cell">
                        <p>{p.defaultLlmModel ?? '—'}</p>
                        {spec?.supportsEmbeddings && <p>{p.defaultEmbeddingModel ?? '—'}</p>}
                      </TD>
                      <TD>
                        <div className="flex flex-wrap gap-1">
                          {p.isDefaultLlm && <Chip>Answers</Chip>}
                          {p.isDefaultEmbedding && <Chip>Indexing</Chip>}
                        </div>
                      </TD>
                      <TD>
                        <div className="flex flex-wrap justify-end gap-1">
                          {!p.isDefaultLlm && spec?.supportsLlm && (
                            <Button variant="ghost" size="sm" aria-label={`Use ${p.name} for answers`} onClick={() => setDefault.mutate({ id: p.id, role: 'llm' }, { onError: (e) => toast.error((e as Error).message) })}>
                              Use for answers
                            </Button>
                          )}
                          {!p.isDefaultEmbedding && spec?.supportsEmbeddings && (
                            <Button variant="ghost" size="sm" aria-label={`Use ${p.name} for indexing`} onClick={() => setDefault.mutate({ id: p.id, role: 'embedding' }, { onError: (e) => toast.error((e as Error).message) })}>
                              Use for indexing
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" aria-label={`Test ${p.name}`} onClick={() => void runTest(p)}>
                            Test
                          </Button>
                          <Button variant="ghost" size="icon" aria-label={`Remove ${p.name}`} onClick={() => setRemoving(p)}>
                            <Trash2 />
                          </Button>
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </>
      )}

      {specs.length > 0 && <AddProviderDialog open={adding} onOpenChange={setAdding} specs={specs} />}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove “${removing?.name ?? ''}”?`}
        description="Documents that are already indexed keep working, but new uploads need a provider for indexing."
        confirmLabel="Remove provider"
        destructive
        pending={remove.isPending}
        onConfirm={() =>
          removing &&
          remove.mutate(removing.id, {
            onSuccess: () => {
              toast.success(`Removed ${removing.name}`);
              setRemoving(null);
            },
            onError: (e) => toast.error((e as Error).message),
          })
        }
      />
    </section>
  );
}
