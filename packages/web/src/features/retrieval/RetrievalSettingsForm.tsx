import { useId } from 'react';
import { Input } from '../../components/ui/input';
import type { RetrievalSettings } from './types';

function Slider({ id, label, value, onChange, disabled }: { id: string; label: string; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="flex justify-between text-sm font-medium">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">{value.toFixed(2)}</span>
      </label>
      <input id={id} type="range" min={0} max={1} step={0.05} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-primary disabled:opacity-50" />
    </div>
  );
}

/** The five search settings, editable. Used on the knowledge base page; the Playground has its own compact version. */
export function RetrievalSettingsForm({ value, onChange }: { value: RetrievalSettings; onChange: (next: RetrievalSettings) => void }) {
  const uid = useId();
  const set = (patch: Partial<RetrievalSettings>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor={`${uid}-k`} className="text-sm font-medium">Passages per search</label>
          <Input id={`${uid}-k`} type="number" min={1} max={50} value={value.topK} onChange={(e) => set({ topK: Math.round(Number(e.target.value)) })} />
          <p className="text-[13px] text-muted-foreground">How many passages are handed to the answer. More gives more context but a slower, noisier answer.</p>
        </div>
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 pt-6 text-sm font-medium">
            <input type="checkbox" checked={value.useHybridSearch} onChange={(e) => set({ useHybridSearch: e.target.checked })} className="size-4 accent-primary" />
            Also use keyword search
          </label>
          <p className="text-[13px] text-muted-foreground">Finds exact words, names and codes that meaning-based search can miss.</p>
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Slider id={`${uid}-vw`} label="Meaning weight" value={value.vectorWeight} onChange={(v) => set({ vectorWeight: v })} disabled={!value.useHybridSearch} />
        <Slider id={`${uid}-bw`} label="Keyword weight" value={value.bm25Weight} onChange={(v) => set({ bm25Weight: v })} disabled={!value.useHybridSearch} />
      </div>

      <div>
        <Slider id={`${uid}-ms`} label="Minimum similarity" value={value.minSimilarity} onChange={(v) => set({ minSimilarity: v })} />
        <p className="mt-1 text-[13px] text-muted-foreground">
          Passages less similar than this are left out, unless they contain the words searched for. Raise it to stop unrelated questions from pulling in text.
        </p>
      </div>
    </div>
  );
}
