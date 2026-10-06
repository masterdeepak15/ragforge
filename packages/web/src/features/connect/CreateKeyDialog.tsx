import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { api } from '../../lib/api-client';
import type { KbSummary } from '../knowledge/types';
import { ConfigSnippets } from './ConfigSnippets';
import { ConnectionTester } from './ConnectionTester';
import { copyText } from './clipboard';

interface CreatedKey {
  id: string;
  key: string;
  name: string;
}

export function CreateKeyDialog({ open, onOpenChange, kbs, origin }: { open: boolean; onOpenChange: (open: boolean) => void; kbs: KbSummary[]; origin: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [created, setCreated] = useState<CreatedKey | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<CreatedKey>('/api/api-keys', { name: name.trim(), knowledgeBaseIds: scope === 'all' ? null : [...selected] }),
    onSuccess: (key) => {
      setCreated(key);
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  const reset = () => {
    setName('');
    setScope('all');
    setSelected(new Set());
    setCreated(null);
    create.reset();
  };
  const close = () => {
    onOpenChange(false);
    reset();
  };

  const canSubmit = name.trim().length > 0 && (scope === 'all' || selected.size > 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canSubmit) create.mutate();
  };
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // While the one-time key is on screen, only "Done" closes the dialog.
        if (next || (!created && !create.isPending)) next ? onOpenChange(true) : close();
      }}
    >
      <DialogContent
        title={created ? 'Your new API key' : 'Create API key'}
        description={created ? undefined : 'A key lets an AI tool search the knowledge bases you choose. It cannot change or delete anything.'}
        className="max-w-xl"
        hideClose={!!created}
      >
        {created ? (
          <div className="space-y-4">
            <div className="rounded-md bg-accent px-3.5 py-2.5 text-sm text-accent-foreground">
              Copy this key now. You won't be able to see this key again; if you lose it, create a new one.
            </div>
            <div className="flex gap-2">
              <Input readOnly aria-label="API key" value={created.key} onFocus={(e) => e.currentTarget.select()} className="font-mono" />
              <Button variant="secondary" aria-label="Copy key" onClick={() => void copyText(created.key, 'Key copied')}>
                <Copy /> Copy
              </Button>
            </div>
            <ConfigSnippets origin={origin} apiKey={created.key} />
            <ConnectionTester origin={origin} apiKey={created.key} />
            <div className="flex justify-end">
              <Button onClick={close}>Done</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <div className="space-y-1.5">
              <label htmlFor="key-name" className="text-sm font-medium">Name</label>
              <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Cursor on my laptop" maxLength={100} autoFocus />
              <p className="text-[13px] text-muted-foreground">Name the tool or machine that will use it, so you can revoke the right key later.</p>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Access</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} /> All knowledge bases
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="scope" checked={scope === 'selected'} onChange={() => setScope('selected')} /> Only selected knowledge bases
              </label>
              {scope === 'selected' && (
                <div className="ml-6 space-y-1.5 rounded-md border border-border p-3">
                  {kbs.length === 0 && <p className="text-sm text-muted-foreground">Create a knowledge base first.</p>}
                  {kbs.map((kb) => (
                    <label key={kb.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={selected.has(kb.id)} onChange={() => toggle(kb.id)} /> {kb.name}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            {create.isError && (
              <p role="alert" className="text-sm text-destructive">
                {(create.error as Error).message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={close} disabled={create.isPending}>Cancel</Button>
              <Button type="submit" disabled={!canSubmit} loading={create.isPending}>Create key</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
