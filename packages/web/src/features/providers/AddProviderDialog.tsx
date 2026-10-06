import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, ExternalLink, XCircle } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { toast } from '../../components/ui/toaster';
import { pickModel, splitModels } from './models';
import { useAddProvider, useTestSettings } from './queries';
import type { ProviderSpec, TestResult } from './types';

const selectClass = 'h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground';

/** A dropdown of the provider's real models once they are known; a text box until then. */
function ModelField({ id, value, onChange, options }: { id: string; value: string; onChange: (v: string) => void; options?: string[] }) {
  if (!options?.length) return <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />;
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
      {options.map((m) => (
        <option key={m} value={m}>{m}</option>
      ))}
    </select>
  );
}

export function AddProviderDialog({ open, onOpenChange, specs }: { open: boolean; onOpenChange: (open: boolean) => void; specs: ProviderSpec[] }) {
  const [type, setType] = useState(specs[0]?.type ?? 'ollama');
  const spec = specs.find((s) => s.type === type) ?? specs[0];

  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [tested, setTested] = useState<TestResult | null>(null);
  const [error, setError] = useState('');

  const add = useAddProvider();
  /** Only the newest lookup may change the form; an older answer for another provider is ignored. */
  const lookup = useRef(0);
  const test = useTestSettings();

  // Each provider type has its own sensible defaults.
  useEffect(() => {
    if (!spec) return;
    setBaseUrl(spec.defaultBaseUrl ?? '');
    setApiKey('');
    setLlmModel(spec.defaultLlmModel);
    setEmbeddingModel(spec.defaultEmbeddingModel ?? '');
    setTested(null);
    setError('');
    lookup.current++;
    // A provider that needs no key can be asked for its models right away.
    if (!spec.needsApiKey) void runTest({ provider: spec.type, ...(spec.defaultBaseUrl ? { baseUrl: spec.defaultBaseUrl } : {}) });
  }, [spec?.type]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!spec) return null;

  const settings = (): Record<string, unknown> => ({
    provider: spec.type,
    ...(spec.usesBaseUrl && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    ...(spec.needsApiKey && apiKey ? { apiKey } : {}),
  });
  const canSubmit = !spec.needsApiKey || apiKey.length > 0;
  const available = tested?.ok ? splitModels(tested.models) : null;

  const runTest = async (explicit?: Record<string, unknown>) => {
    const mine = ++lookup.current;
    setTested(null);
    try {
      const result = await test.mutateAsync(explicit ?? settings());
      if (mine !== lookup.current) return;
      setTested(result);
      if (result.ok) {
        const { chat, embedding } = splitModels(result.models);
        if (chat.length) setLlmModel((m) => pickModel(chat, m));
        if (spec.supportsEmbeddings && embedding.length) setEmbeddingModel((m) => pickModel(embedding, m));
      }
    } catch (e) {
      if (mine === lookup.current) setTested({ ok: false, message: (e as Error).message });
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    try {
      const saved = await add.mutateAsync({
        ...settings(),
        ...(name.trim() ? { name: name.trim() } : {}),
        defaultLlmModel: llmModel.trim() || spec.defaultLlmModel,
        ...(spec.supportsEmbeddings ? { defaultEmbeddingModel: embeddingModel.trim() || spec.defaultEmbeddingModel } : {}),
      });
      const roles = [saved.isDefaultLlm && 'answers questions', saved.isDefaultEmbedding && 'indexes documents'].filter(Boolean).join(' and ');
      toast.success(roles ? `Added ${saved.name}. It now ${roles}.` : `Added ${saved.name}.`);
      onOpenChange(false);
      setName('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !add.isPending && onOpenChange(next)}>
      <DialogContent title="Add AI provider" description="RAGForge uses a provider to write answers and to index your documents." className="max-w-xl">
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="prov-type" className="text-sm font-medium">Provider</label>
            <select id="prov-type" value={type} onChange={(e) => setType(e.target.value)} className={selectClass}>
              {specs.map((s) => (
                <option key={s.type} value={s.type}>{s.label}</option>
              ))}
            </select>
            <p className="text-[13px] text-muted-foreground">{spec.description}</p>
          </div>

          {spec.usesBaseUrl && (
            <div className="space-y-1.5">
              <label htmlFor="prov-url" className="text-sm font-medium">Server address</label>
              <Input id="prov-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={spec.defaultBaseUrl} inputMode="url" />
              <p className="text-[13px] text-muted-foreground">Running in Docker? Use the host's address, for example http://host.docker.internal:11434.</p>
            </div>
          )}

          {spec.needsApiKey && (
            <div className="space-y-1.5">
              <label htmlFor="prov-key" className="text-sm font-medium">API key</label>
              <Input id="prov-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} onBlur={() => apiKey && void runTest()} placeholder="Paste your key" autoComplete="off" />
              <p className="text-[13px] text-muted-foreground">
                Stored encrypted.{' '}
                {spec.keyHelpUrl && (
                  <a href={spec.keyHelpUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                    Get an API key <ExternalLink className="size-3" aria-hidden />
                  </a>
                )}
              </p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="prov-llm" className="text-sm font-medium">Model for answers</label>
              <ModelField id="prov-llm" value={llmModel} onChange={setLlmModel} options={available?.chat} />
            </div>
            {spec.supportsEmbeddings && (
              <div className="space-y-1.5">
                <label htmlFor="prov-emb" className="text-sm font-medium">Model for indexing (embeddings)</label>
                <ModelField id="prov-emb" value={embeddingModel} onChange={setEmbeddingModel} options={available?.embedding.length ? available.embedding : undefined} />
              </div>
            )}
          </div>
          {!spec.supportsEmbeddings && (
            <p className="text-[13px] text-muted-foreground">{spec.label} has no embeddings API, so it cannot index documents. Pair it with another provider for indexing.</p>
          )}

          {!available && <p className="text-[13px] text-muted-foreground">Test the connection to choose from the models this provider offers.</p>}

          <div className="space-y-2">
            <Button variant="secondary" onClick={() => void runTest()} loading={test.isPending} disabled={!canSubmit}>
              Test connection
            </Button>
            {tested?.ok && (
              <p role="status" className="flex items-center gap-1.5 text-sm text-success">
                <CheckCircle2 className="size-4" aria-hidden /> Connected. Found {tested.models.length} {tested.models.length === 1 ? 'model' : 'models'}.
              </p>
            )}
            {tested && !tested.ok && (
              <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
                <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {tested.message}
              </p>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={add.isPending}>Cancel</Button>
            <Button type="submit" disabled={!canSubmit} loading={add.isPending}>Add provider</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
