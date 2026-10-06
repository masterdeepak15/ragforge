import { useEffect, useState } from 'react';
import { FlaskConical, Play, Loader2, Sliders, Hash, ChevronDown, ChevronUp } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { KnowledgeBase, DocumentChunk } from '../types/api';
import type { RetrievalSettingsView } from '../features/retrieval/types';

interface RetrievalResult extends DocumentChunk {
  score: number;
  /** How close the passage is to the question, 0 to 1. Null when it was found by keyword only. */
  similarity: number | null;
  keywordMatch: boolean;
  documentTitle: string;
  rank: number;
}

interface RetrievalParams {
  topK: number;
  useHybridSearch: boolean;
  vectorWeight: number;
  bm25Weight: number;
  minScore: number;
}

const DEFAULT_PARAMS: RetrievalParams = {
  topK: 6,
  useHybridSearch: true,
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  minScore: 0.3,
};

export default function PlaygroundPage() {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [selectedKb, setSelectedKb] = useState('');
  const [query, setQuery] = useState('');
  const [params, setParams] = useState<RetrievalParams>(DEFAULT_PARAMS);
  const [results, setResults] = useState<RetrievalResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [expandedChunk, setExpandedChunk] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState('');
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    apiFetch<KnowledgeBase[]>('/api/knowledge-bases').then(setKbs).catch(console.error);
  }, []);

  // Each knowledge base has its own search settings; start from the ones saved for it.
  useEffect(() => {
    setSaveNote('');
    setSaveError('');
    if (!selectedKb) return;
    let current = true;
    apiFetch<RetrievalSettingsView>(`/api/knowledge-bases/${selectedKb}/retrieval-settings`)
      .then(({ settings }) => {
        if (!current) return;
        setParams({ topK: settings.topK, useHybridSearch: settings.useHybridSearch, vectorWeight: settings.vectorWeight, bm25Weight: settings.bm25Weight, minScore: settings.minSimilarity });
      })
      .catch(() => {
        /* keep the values on screen; searching still works */
      });
    return () => {
      current = false;
    };
  }, [selectedKb]);

  /** Keeps what was tuned here as how this knowledge base is searched everywhere (Chat, connected AI tools). */
  const saveDefaults = async () => {
    if (!selectedKb) return;
    setSaving(true);
    setSaveNote('');
    setSaveError('');
    try {
      await apiFetch(`/api/knowledge-bases/${selectedKb}/retrieval-settings`, {
        method: 'PUT',
        json: { topK: params.topK, useHybridSearch: params.useHybridSearch, vectorWeight: params.vectorWeight, bm25Weight: params.bm25Weight, minSimilarity: params.minScore },
      });
      setSaveNote('Saved. Chat and connected AI tools now search this way.');
    } catch (e: any) {
      setSaveError(e.message || 'Could not save the settings.');
    } finally {
      setSaving(false);
    }
  };

  const runQuery = async () => {
    if (!query.trim() || !selectedKb) return;
    setLoading(true);
    setError('');
    setResults([]);
    setLatency(null);
    const t0 = performance.now();
    try {
      const data = await apiFetch<{ chunks: RetrievalResult[] }>('/api/playground/retrieve', {
        method: 'POST',
        json: { query, knowledgeBaseId: selectedKb, ...params },
      });
      setResults(data.chunks ?? []);
      setLatency(Math.round(performance.now() - t0));
    } catch (e: any) {
      // Fallback: if no playground route, use chat stream just for retrieval context
      setError(e.message || 'Retrieval failed');
    } finally {
      setLoading(false);
    }
  };

  const scoreColor = (score: number) => {
    if (score >= 0.8) return 'text-primary';
    if (score >= 0.6) return 'text-warning';
    return 'text-muted-foreground';
  };

  const scoreBar = (score: number) => (
    <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full bg-gradient-to-r ${
          score >= 0.8 ? 'from-emerald-500 to-emerald-400' :
          score >= 0.6 ? 'from-yellow-500 to-yellow-400' :
          'from-slate-500 to-slate-400'
        }`}
        style={{ width: `${Math.min(score * 100, 100)}%` }}
      />
    </div>
  );

  return (
    <div className="p-6 h-full overflow-y-auto bg-background">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
            <FlaskConical className="w-5 h-5 text-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Playground</h1>
            <p className="text-muted-foreground text-sm">Test retrieval queries and tune parameters</p>
          </div>
        </div>

        {/* Query form */}
        <div className="bg-card border border-border rounded-xl p-5 mb-6">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground/80 mb-1.5">Knowledge Base</label>
              <select
                aria-label="Knowledge base"
                value={selectedKb}
                onChange={(e) => setSelectedKb(e.target.value)}
                className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-foreground"
              >
                <option value="">Select a knowledge base...</option>
                {kbs.map((kb) => (
                  <option key={kb.id} value={kb.id}>{kb.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground/80 mb-1.5">Query</label>
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && runQuery()}
                placeholder="Enter a search query... (Ctrl+Enter to run)"
                rows={3}
                className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-ring resize-none"
              />
            </div>

            {/* Quick params */}
            <div className="flex flex-wrap gap-4">
              <div className="flex items-center gap-2">
                <label className="text-sm text-muted-foreground whitespace-nowrap">Top K</label>
                <input
                  type="number"
                  aria-label="Top K"
                  min={1} max={50}
                  value={params.topK}
                  onChange={(e) => setParams((p) => ({ ...p, topK: Number(e.target.value) }))}
                  className="w-16 px-2 py-1.5 bg-muted border border-border rounded-lg text-foreground text-sm"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={params.useHybridSearch}
                  onChange={(e) => setParams((p) => ({ ...p, useHybridSearch: e.target.checked }))}
                  className="w-4 h-4 rounded border-border bg-muted text-primary"
                />
                <span className="text-sm text-muted-foreground">Hybrid search</span>
              </label>
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <Sliders className="w-4 h-4" />
                Advanced
                {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
            </div>

            {/* Advanced params */}
            {showAdvanced && (
              <div className="pt-2 border-t border-border grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    Vector weight: {params.vectorWeight.toFixed(1)}
                  </label>
                  <input
                    type="range"
                    aria-label="Vector weight"
                    min={0} max={1} step={0.1}
                    value={params.vectorWeight}
                    onChange={(e) => setParams((p) => ({ ...p, vectorWeight: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    BM25 weight: {params.bm25Weight.toFixed(1)}
                  </label>
                  <input
                    type="range"
                    aria-label="Keyword weight"
                    min={0} max={1} step={0.1}
                    value={params.bm25Weight}
                    onChange={(e) => setParams((p) => ({ ...p, bm25Weight: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    Min similarity: {params.minScore.toFixed(2)}
                  </label>
                  <input
                    type="range"
                    aria-label="Minimum similarity"
                    min={0} max={1} step={0.05}
                    value={params.minScore}
                    onChange={(e) => setParams((p) => ({ ...p, minScore: Number(e.target.value) }))}
                    className="w-full"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">Passages less similar than this are hidden, unless they contain your words.</p>
                </div>
              </div>
            )}

            <button
              onClick={runQuery}
              disabled={!query.trim() || !selectedKb || loading}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed text-primary-foreground font-medium rounded-lg transition-colors"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Run Retrieval
            </button>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void saveDefaults()}
                disabled={!selectedKb || saving}
                className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save as defaults for this knowledge base'}
              </button>
              <p className="text-xs text-muted-foreground">Chat and connected AI tools use the saved settings.</p>
            </div>
            {saveNote && <p role="status" className="text-sm text-success">{saveNote}</p>}
            {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
          </div>
        </div>

        {/* Results */}
        {error && (
          <div className="mb-4 px-4 py-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive">
            {error}
          </div>
        )}

        {results.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-foreground/80">
                {results.length} results
                {latency !== null && <span className="text-muted-foreground ml-2">· {latency}ms</span>}
              </h2>
            </div>
            <div className="space-y-3">
              {results.map((chunk, i) => (
                <div
                  key={chunk.id}
                  className="bg-card border border-border rounded-xl overflow-hidden"
                >
                  <div
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                    onClick={() => setExpandedChunk(expandedChunk === chunk.id ? null : chunk.id)}
                  >
                    <div className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center text-xs font-bold text-foreground/80 flex-shrink-0">
                      {i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-medium text-foreground truncate">
                          {chunk.documentTitle ?? 'Unknown document'}
                        </p>
                        <span className={`text-xs font-mono ${scoreColor(chunk.similarity ?? 0)}`} title="How similar this passage is to your question">
                          {chunk.similarity === null ? 'keyword only' : chunk.similarity.toFixed(2)}
                        </span>
                        {chunk.keywordMatch && <span className="rounded bg-accent px-1.5 py-0.5 text-xs text-accent-foreground">keyword match</span>}
                      </div>
                      {scoreBar(chunk.similarity ?? 0)}
                    </div>
                    <Hash className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  </div>
                  {expandedChunk === chunk.id && (
                    <div className="border-t border-border bg-background/50 px-4 py-3">
                      <p className="text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap">
                        {chunk.content}
                      </p>
                      {chunk.metadata && Object.keys(chunk.metadata).length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {Object.entries(chunk.metadata).map(([k, v]) => (
                            <span key={k} className="px-2 py-0.5 bg-muted text-xs text-muted-foreground rounded">
                              {k}: {String(v)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {!loading && results.length === 0 && query && !error && (
          <div className="text-center py-12 text-muted-foreground">
            No results. Try different words, or lower the minimum similarity.
          </div>
        )}
      </div>
    </div>
  );
}
