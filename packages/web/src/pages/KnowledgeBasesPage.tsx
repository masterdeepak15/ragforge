import { useEffect, useState } from 'react';
import { Plus, Database, FileText, Layers, Trash2, Loader2, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useNavigate } from 'react-router-dom';
import type { KnowledgeBase } from '../types/api';

export default function KnowledgeBasesPage() {
  const navigate = useNavigate();
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '' });
  const [error, setError] = useState('');

  useEffect(() => {
    loadKbs();
  }, []);

  const loadKbs = async () => {
    try {
      const data = await apiFetch<KnowledgeBase[]>('/api/knowledge-bases');
      setKbs(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const createKb = async () => {
    if (!form.name.trim()) return;
    setCreating(true);
    setError('');
    try {
      const kb = await apiFetch<KnowledgeBase>('/api/knowledge-bases', {
        method: 'POST',
        json: form,
      });
      setKbs((prev) => [kb, ...prev]);
      setShowCreate(false);
      setForm({ name: '', description: '' });
    } catch (e: any) {
      setError(e.message || 'Failed to create knowledge base');
    } finally {
      setCreating(false);
    }
  };

  const deleteKb = async (id: string) => {
    if (!confirm('Delete this knowledge base and all its documents?')) return;
    try {
      await apiFetch(`/api/knowledge-bases/${id}`, { method: 'DELETE' });
      setKbs((prev) => prev.filter((kb) => kb.id !== id));
    } catch (e) {
      console.error(e);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-slate-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 h-full overflow-y-auto bg-slate-950">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">Knowledge Bases</h1>
            <p className="text-slate-400 mt-1">Organize and manage your document collections</p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white font-medium rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Knowledge Base
          </button>
        </div>

        {kbs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 rounded-2xl bg-slate-800 flex items-center justify-center mb-4">
              <Database className="w-8 h-8 text-slate-500" />
            </div>
            <h3 className="text-lg font-semibold text-white mb-2">No knowledge bases yet</h3>
            <p className="text-slate-400 mb-6">Create one to start uploading documents</p>
            <button
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg transition-colors"
            >
              Create Knowledge Base
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {kbs.map((kb) => (
              <div
                key={kb.id}
                onClick={() => navigate(`/knowledge-bases/${kb.id}`)}
                className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 cursor-pointer transition-all group"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500/20 to-cyan-500/20 flex items-center justify-center">
                    <Database className="w-5 h-5 text-emerald-400" />
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteKb(kb.id); }}
                    className="opacity-0 group-hover:opacity-100 p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <h3 className="font-semibold text-white mb-1">{kb.name}</h3>
                {kb.description && (
                  <p className="text-sm text-slate-400 mb-4 line-clamp-2">{kb.description}</p>
                )}
                <div className="flex items-center gap-4 text-xs text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5" />
                    {kb.document_count ?? 0} docs
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5" />
                    {kb.chunk_count ?? 0} chunks
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-800 p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-white">New Knowledge Base</h2>
              <button
                onClick={() => setShowCreate(false)}
                className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="My Knowledge Base"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Description (optional)</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="What documents will you store here?"
                  rows={3}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:ring-2 focus:ring-emerald-500 focus:border-transparent resize-none"
                />
              </div>
              {error && <p className="text-sm text-red-400">{error}</p>}
              <div className="flex gap-3 pt-1">
                <button
                  onClick={() => setShowCreate(false)}
                  className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={createKb}
                  disabled={!form.name.trim() || creating}
                  className="flex-1 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {creating && <Loader2 className="w-4 h-4 animate-spin" />}
                  Create
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
