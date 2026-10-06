import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plus } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { Dialog, DialogContent } from '../../components/ui/dialog';
import { EmptyState, ErrorState } from '../../components/ui/empty-state';
import { PageHeader } from '../../components/ui/page-header';
import { Skeleton } from '../../components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '../../components/ui/table';
import { toast } from '../../components/ui/toaster';
import { api } from '../../lib/api-client';
import { timeAgo } from '../../lib/format';
import { useKnowledgeBases } from '../../lib/queries';
import { ConfigSnippets } from './ConfigSnippets';
import { ConnectionTester } from './ConnectionTester';
import { CreateKeyDialog } from './CreateKeyDialog';
import { copyText } from './clipboard';

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopeKbIds: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export default function ConnectPage() {
  const qc = useQueryClient();
  const origin = window.location.origin;
  const endpoint = `${origin}/mcp`;

  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api.get<ApiKeyRow[]>('/api/api-keys') });
  const { data: kbs = [] } = useKnowledgeBases();
  const kbName = useMemo(() => new Map(kbs.map((k) => [k.id, k.name])), [kbs]);

  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/api-keys/${id}`),
    onSuccess: () => {
      toast.success(`Revoked “${revoking?.name}”`);
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
      setRevoking(null);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const access = (k: ApiKeyRow) =>
    k.scopeKbIds === null ? 'All knowledge bases' : k.scopeKbIds.map((id) => kbName.get(id) ?? 'Deleted knowledge base').join(', ') || 'No knowledge bases';

  const createButton = (
    <Button onClick={() => setCreating(true)}>
      <Plus /> Create API key
    </Button>
  );

  return (
    <div className="mx-auto max-w-5xl px-5 py-6 md:px-8">
      <PageHeader title="Connect other AI tools" description="Give Claude, Cursor or any MCP client read access to your knowledge bases." actions={createButton} />

      <div className="mb-8 flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-card px-3 py-2 font-mono text-sm" aria-label="MCP endpoint address">{endpoint}</code>
        <Button variant="secondary" onClick={() => void copyText(endpoint, 'Address copied')} aria-label="Copy URL">
          <Copy /> Copy
        </Button>
        <Button variant="secondary" onClick={() => setTesting(true)}>Test connection</Button>
      </div>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold">API keys</h2>
        {keys.isLoading ? (
          <div className="space-y-2 rounded-lg border border-border bg-card p-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : keys.isError ? (
          <ErrorState title="Could not load API keys" message={(keys.error as Error).message} onRetry={() => void keys.refetch()} />
        ) : (keys.data ?? []).length === 0 ? (
          <EmptyState icon={KeyRound} title="No API keys yet" description="Create a key to let an AI tool search your knowledge bases. You choose which ones it can see." action={createButton} />
        ) : (
          <Table aria-label="API keys">
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Access</TH>
                <TH className="hidden sm:table-cell">Last used</TH>
                <TH className="hidden md:table-cell">Key</TH>
                <TH className="w-24" />
              </TR>
            </THead>
            <TBody>
              {keys.data!.map((k) => (
                <TR key={k.id} className={k.revokedAt ? 'text-muted-foreground' : undefined}>
                  <TD className="font-medium">{k.name}</TD>
                  <TD>{access(k)}</TD>
                  <TD className="hidden text-muted-foreground sm:table-cell">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'Never'}</TD>
                  <TD className="hidden font-mono text-[13px] text-muted-foreground md:table-cell">{k.prefix}…</TD>
                  <TD className="text-right">
                    {k.revokedAt ? (
                      <span className="text-sm">Revoked</span>
                    ) : (
                      <Button variant="ghost" size="sm" aria-label={`Revoke ${k.name}`} onClick={() => setRevoking(k)}>
                        Revoke
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold">Set up a client</h2>
        <p className="mb-3 text-sm text-muted-foreground">Replace the placeholder with a key you created. Keys are shown only once, when you create them.</p>
        <ConfigSnippets origin={origin} />
      </section>

      <CreateKeyDialog open={creating} onOpenChange={setCreating} kbs={kbs} origin={origin} />

      <Dialog open={testing} onOpenChange={setTesting}>
        <DialogContent title="Test connection" description="Calls the endpoint the way an AI tool would, using a key you paste here.">
          <ConnectionTester origin={origin} />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke “${revoking?.name ?? ''}”?`}
        description="Anything using this key stops working immediately. This can't be undone."
        confirmLabel="Revoke key"
        destructive
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </div>
  );
}
