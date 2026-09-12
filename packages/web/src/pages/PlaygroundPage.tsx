import { useEffect, useState } from 'react';
import { FlaskConical, Play, Loader2, Sliders, Hash, ChevronDown, ChevronUp } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { KnowledgeBase, DocumentChunk } from '../types/api';

interface RetrievalResult extends DocumentChunk {
  score: number;
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
  minScore: 0.0,
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

  useEffect(() => {
    apiFetch<KnowledgeBase[]>('/api/knowledge-bases').then(setKbs).catch(console.error);
  }, []);

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
    if (score >= 0.8) return 'text-emerald-400';
    if (score >= 0.6) return 'text-yellow-400';
    return 'text-slate-400';
  };

  const scoreBar = (score: number) => (
    <div className="w-full h-1.5 bg-slate-700 rounded-full overflow-hidden">
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
    <div className="p-6 h-full overflow-y-auto bg-slate-950">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
            <FlaskConical className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Playground</h1>
            <p className="text-slate-400 text-sm">Test retrieval queries and tune parameters</p>
          </div>
        </div>

        {/* Query form */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-6">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Knowledge Base</label>
              <select
                value={selectedKb}
                onChange={(e) => setSelectedKb(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white"
              >
                <option value="">Select a knowledge base...</option>
                {kbs.map((kb) => (
                  <option key={kb.id} value={kb.id}>{kb.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Query</label>
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && runQuery()}
                placeholder="Enter a search query... (Ctrl+Enter to run)"
                rows={3}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:ring-2 focus:ring-emerald-500 resize-none"
              />
            </div>

            {/* Quick params */}
            <div className="flex flex-wrap gap-4">
              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-400 whitespace-nowrap">Top K</label>
                <input
                  type="number"
                  min={1} max={20}
                  value={params.topK}
                  onChange={(e) => setParams((p) => ({ ...p, topK: Number(e.target.value) }))}
                  className="w-16 px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={params.useHybridSearch}
                  onChange={(e) => setParams((p) => ({ ...p, useHybridSearch: e.target.checked }))}
                  className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-emerald-500"
                />
                <span className="text-sm text-slate-400">Hybrid search</span>
              </label>
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors"
              >
                <Sliders className="w-4 h-4" />
                Advanced
                {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
            </div>

            {/* Advanced params */}
            {showAdvanced && (
              <div className="pt-2 border-t border-slate-800 grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    Vector weight: {params.vectorWeight.toFixed(1)}
                  </label>
                  <input
                    type="range"
                    min={0} max={1} step={0.1}
                    value={params.vectorWeight}
                    onChange={(e) => setParams((p) => ({ ...p, vectorWeight: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    BM25 weight: {params.bm25Weight.toFixed(1)}
                  </label>
                  <input
                    type="range"
                    min={0} max={1} step={0.1}
                    value={params.bm25Weight}
                    onChange={(e) => setParams((p) => ({ ...p, bm25Weight: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    Min score: {params.minScore.toFixed(2)}
                  </label>
                  <input
                    type="range"
                    min={0} max={1} step={0.05}
                    value={params.minScore}
                    onChange={(e) => setParams((p) => ({ ...p, minScore: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>
              </div>
            )}

            <button
              onClick={runQuery}
              disabled={!query.trim() || !selectedKb || loading}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Run Retrieval
            </button>
          </div>
        </div>

        {/* Results */}
        {error && (
          <div className="mb-4 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
            {error}
          </div>
        )}

        {results.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-slate-300">
                {results.length} results
                {latency !== null && <span className="text-slate-500 ml-2">· {latency}ms</span>}
              </h2>
            </div>
            <div className="space-y-3">
              {results.map((chunk, i) => (
                <div
                  key={chunk.id}
                  className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden"
                >
                  <div
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                    onClick={() => setExpandedChunk(expandedChunk === chunk.id ? null : chunk.id)}
                  >
                    <div className="w-7 h-7 rounded-lg bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-300 flex-shrink-0">
                      {i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-medium text-white truncate">
                          {chunk.documentTitle ?? 'Unknown document'}
                        </p>
                        <span className={`text-xs font-mono ${scoreColor(chunk.score)}`}>
                          {chunk.score?.toFixed(3)}
                        </span>
                      </div>
                      {scoreBar(chunk.score)}
                    </div>
                    <Hash className="w-4 h-4 text-slate-600 flex-shrink-0" />
                  </div>
                  {expandedChunk === chunk.id && (
                    <div className="border-t border-slate-800 bg-slate-950/50 px-4 py-3">
                      <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">
                        {chunk.content}
                      </p>
                      {chunk.metadata && Object.keys(chunk.metadata).length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {Object.entries(chunk.metadata).map(([k, v]) => (
                            <span key={k} className="px-2 py-0.5 bg-slate-800 text-xs text-slate-400 rounded">
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
          <div className="text-center py-12 text-slate-500">
            No results found. Try a different query or lower the min score threshold.
          </div>
        )}
      </div>
    </div>
  );
}
