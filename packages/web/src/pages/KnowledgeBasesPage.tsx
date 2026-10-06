import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Database, ExternalLink, MessageSquare, MoreHorizontal, Plug, Plus, Trash2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Dialog, DialogContent } from '../components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { EmptyState, ErrorState } from '../components/ui/empty-state';
import { Input } from '../components/ui/input';
import { PageHeader } from '../components/ui/page-header';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';
import { toast } from '../components/ui/toaster';
import { api } from '../lib/api-client';
import { formatCount, timeAgo } from '../lib/format';
import { queryKeys, useKnowledgeBases } from '../lib/queries';
import type { KbSummary } from '../features/knowledge/types';

function NewKnowledgeBaseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const create = useMutation({
    mutationFn: () => api.post<{ id: string; name: string }>('/api/knowledge-bases', { name: name.trim(), description: description.trim() }),
    onSuccess: (kb) => {
      void qc.invalidateQueries({ queryKey: queryKeys.knowledgeBases });
      toast.success(`Created “${kb.name}”`);
      onOpenChange(false);
      setName('');
      setDescription('');
      navigate(`/knowledge-bases/${kb.id}`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !create.isPending && onOpenChange(next)}>
      <DialogContent title="New knowledge base" description="A knowledge base is a collection of documents your assistants can search.">
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="kb-name" className="text-sm font-medium">Name</label>
            <Input id="kb-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Engineering handbook" autoFocus maxLength={100} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="kb-description" className="text-sm font-medium">Description</label>
            <Input id="kb-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Runbooks, postmortems and architecture notes" />
          </div>
          {create.isError && (
            <p role="alert" className="text-sm text-destructive">
              {(create.error as Error).message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={create.isPending}>Cancel</Button>
            <Button type="submit" disabled={!name.trim()} loading={create.isPending}>Create knowledge base</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function KnowledgeBasesPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useKnowledgeBases();
  const kbs = (data ?? []) as KbSummary[];
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<KbSummary | null>(null);
  const navigate = useNavigate();

  const startChat = useMutation({
    mutationFn: (kb: KbSummary) => api.post<{ id: string }>('/api/chat/sessions', { title: kb.name, knowledgeBaseId: kb.id }),
    onSuccess: (session) => navigate(`/chat/${session.id}`),
    onError: (err) => toast.error(`Could not start a chat. ${(err as Error).message}`),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/knowledge-bases/${id}`),
    onSuccess: () => {
      toast.success(`Deleted “${deleting?.name}”`);
      void qc.invalidateQueries({ queryKey: queryKeys.knowledgeBases });
      setDeleting(null);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const newButton = (
    <Button onClick={() => setCreating(true)}>
      <Plus /> New knowledge base
    </Button>
  );

  return (
    <div className="mx-auto max-w-5xl px-5 py-6 md:px-8">
      <PageHeader title="Knowledge bases" description="Collections of documents your assistants can search." actions={newButton} />

      {isLoading ? (
        <div data-testid="kb-loading" className="space-y-2 rounded-lg border border-border bg-card p-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState title="Could not load knowledge bases" message={(error as Error).message} onRetry={() => void refetch()} />
      ) : kbs.length === 0 ? (
        <EmptyState icon={Database} title="No knowledge bases yet" description="Create one, then drop in your PDFs, Word files and notes. They are indexed in the background." action={newButton} />
      ) : (
        <Table aria-label="Knowledge bases">
          <THead>
            <TR>
              <TH>Name</TH>
              <TH className="text-right">Documents</TH>
              <TH className="hidden text-right sm:table-cell">Chunks</TH>
              <TH className="hidden md:table-cell">Created</TH>
              <TH className="w-12" />
            </TR>
          </THead>
          <TBody>
            {kbs.map((kb) => (
              <TR key={kb.id} className="hover:bg-muted/40">
                <TD>
                  <Link to={`/knowledge-bases/${kb.id}`} className="font-semibold hover:text-primary">
                    {kb.name}
                  </Link>
                  {kb.description && <p className="mt-0.5 line-clamp-1 text-[13px] text-muted-foreground">{kb.description}</p>}
                </TD>
                <TD className="text-right tabular-nums">{formatCount(kb.documentCount ?? 0)}</TD>
                <TD className="hidden text-right tabular-nums sm:table-cell">{formatCount(kb.chunkCount ?? 0)}</TD>
                <TD className="hidden text-muted-foreground md:table-cell">{timeAgo(kb.created_at)}</TD>
                <TD className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={`Actions for ${kb.name}`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem asChild>
                        <Link to={`/knowledge-bases/${kb.id}`}>
                          <ExternalLink aria-hidden /> Open
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => startChat.mutate(kb)}>
                        <MessageSquare aria-hidden /> Ask in Chat
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link to="/connect">
                          <Plug aria-hidden /> Connect an AI tool
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem destructive onSelect={() => setDeleting(kb)}>
                        <Trash2 aria-hidden /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <NewKnowledgeBaseDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        description={`All ${formatCount(deleting?.documentCount ?? 0)} documents and their search data are removed. This can't be undone.`}
        confirmLabel="Delete knowledge base"
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}
