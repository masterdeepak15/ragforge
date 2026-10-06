import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { ErrorState } from '../../components/ui/empty-state';
import { PageHeader } from '../../components/ui/page-header';
import { Skeleton } from '../../components/ui/skeleton';
import { Status, toStatusKind } from '../../components/ui/status';
import { Table, TBody, TD, TH, THead, TR } from '../../components/ui/table';
import { api } from '../../lib/api-client';
import { cn } from '../../lib/cn';
import { formatBytes, formatCount, timeAgo } from '../../lib/format';
import type { SetupStatus } from '../../types/api';
import { useStats, type Stats } from './useStats';

function GetStarted({ stats, setup }: { stats: Stats; setup?: SetupStatus }) {
  // Indexing needs a provider that can create embeddings; one that only writes answers (Claude, Groq) is not enough.
  const answerOnly = !!setup?.hasDefaultProvider && !setup?.hasEmbeddingProvider;
  const steps = [
    {
      done: !!setup?.hasEmbeddingProvider,
      node: <Link to="/settings" className="font-semibold text-primary hover:underline">{answerOnly ? 'Add an AI provider for indexing' : 'Add an AI provider'}</Link>,
      note: answerOnly
        ? 'Anthropic and Groq can only write answers. Add Ollama, OpenAI or Google Gemini so documents can be indexed.'
        : 'It turns your documents into searchable vectors and writes the answers.',
    },
    { done: stats.knowledgeBases > 0, node: <Link to="/knowledge-bases" className="font-semibold text-primary hover:underline">Create a knowledge base</Link>, note: 'A collection of documents your assistants can search.' },
    { done: stats.documents.total > 0, node: <span className="font-semibold">Upload documents</span>, note: 'Drop PDFs, Word files or notes into a knowledge base. They are indexed in the background.' },
    { done: false, optional: true, node: <Link to="/connect" className="font-semibold text-primary hover:underline">Connect an AI tool</Link>, note: 'Or ask a question right here in Chat.' },
  ];
  return (
    <section aria-labelledby="start-heading" className="mb-8 rounded-lg border border-border bg-card p-5">
      <h2 id="start-heading" className="text-base font-semibold">Get started</h2>
      <ol className="mt-4 space-y-4">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span
              aria-hidden
              className={cn('mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold', s.done ? 'bg-success text-primary-foreground' : 'bg-accent text-accent-foreground')}
            >
              {s.done ? <Check className="size-3.5" /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2">
                {s.node}
                {s.done && <span className="text-xs font-medium text-success">Done</span>}
                {s.optional && <span className="text-xs text-muted-foreground">Optional</span>}
              </p>
              <p className="text-sm text-muted-foreground">{s.note}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function DashboardPage() {
  const stats = useStats();
  const setup = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<SetupStatus>('/api/setup/status') });
  const s = stats.data;

  return (
    <div className="mx-auto max-w-5xl px-5 py-6 md:px-8">
      <PageHeader title="Overview" description="What is in your knowledge bases and what is being processed." />

      {stats.isLoading ? (
        <div data-testid="dashboard-loading" className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : stats.isError || !s ? (
        <ErrorState title="Could not load the overview" message={(stats.error as Error)?.message ?? 'Unknown error'} onRetry={() => void stats.refetch()} />
      ) : (
        <>
          {!(setup.data?.hasEmbeddingProvider && s.knowledgeBases > 0 && s.documents.total > 0) && <GetStarted stats={s} setup={setup.data} />}

          <section className="mb-8 grid gap-6 sm:grid-cols-2">
            <div>
              <h2 className="mb-1 text-sm font-semibold">Library</h2>
              <p className="text-sm text-muted-foreground">
                {formatCount(s.knowledgeBases)} {s.knowledgeBases === 1 ? 'knowledge base' : 'knowledge bases'} · {formatCount(s.documents.ready)}{' '}
                {s.documents.ready === 1 ? 'document' : 'documents'} ready · {formatCount(s.chunks)} {s.chunks === 1 ? 'chunk' : 'chunks'} · {formatBytes(s.storageBytes)}
              </p>
            </div>
            <div>
              <h2 className="mb-1 text-sm font-semibold">Indexing</h2>
              <p className="text-sm text-muted-foreground">
                {s.documents.processing + s.queue.queued + s.queue.failed === 0
                  ? 'Nothing is being processed.'
                  : `${formatCount(s.documents.processing)} processing · ${formatCount(s.queue.queued)} queued · ${formatCount(s.queue.failed)} failed`}
              </p>
            </div>
          </section>

          <section aria-labelledby="recent-heading">
            <h2 id="recent-heading" className="mb-2 text-sm font-semibold">Recent documents</h2>
            {s.recent.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">Documents you upload will appear here.</p>
            ) : (
              <Table aria-label="Recent documents">
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH className="hidden sm:table-cell">Knowledge base</TH>
                    <TH>Status</TH>
                    <TH className="hidden md:table-cell">Added</TH>
                  </TR>
                </THead>
                <TBody>
                  {s.recent.map((d) => (
                    <TR key={d.id}>
                      <TD className="font-medium">{d.title}</TD>
                      <TD className="hidden sm:table-cell">
                        {d.knowledgeBaseName ? (
                          <Link to={`/knowledge-bases/${d.knowledgeBaseId}`} className="hover:text-primary">
                            {d.knowledgeBaseName}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </TD>
                      <TD><Status kind={toStatusKind(d.status)} /></TD>
                      <TD className="hidden text-muted-foreground md:table-cell">{timeAgo(d.at)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
