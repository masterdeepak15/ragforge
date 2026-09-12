import { useEffect, useState } from 'react';
import {
  Settings, Trash2, Loader2, CheckCircle, XCircle,
  Plus, X, ChevronDown, ExternalLink,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { AIProviderConfig } from '../types/api';

const PROVIDER_META: Record<string, { label: string; color: string; hasOAuth: boolean; oauthLabel?: string }> = {
  openai:    { label: 'OpenAI',     color: 'from-green-500 to-emerald-600',  hasOAuth: false },
  anthropic: { label: 'Anthropic',  color: 'from-orange-500 to-amber-600',   hasOAuth: false },
  gemini:    { label: 'Gemini',     color: 'from-blue-500 to-indigo-600',    hasOAuth: true,  oauthLabel: 'Connect Google' },
  groq:      { label: 'Groq',       color: 'from-purple-500 to-violet-600',  hasOAuth: true,  oauthLabel: 'Connect Groq' },
  ollama:    { label: 'Ollama',     color: 'from-slate-500 to-slate-600',    hasOAuth: false },
};

interface AddProviderForm {
  type: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  defaultEmbeddingModel: string;
}

const EMPTY_FORM: AddProviderForm = {
  type: 'openai', name: '', apiKey: '', baseUrl: '', defaultModel: '', defaultEmbeddingModel: ''
};

export default function SettingsPage() {
  const [providers, setProviders] = useState<AIProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<AddProviderForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [oauthPending, setOauthPending] = useState<string | null>(null);
  const [modelsOpen, setModelsOpen] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, { llm: string[]; embedding: string[] }>>({});

  useEffect(() => {
    loadProviders();
    // Handle OAuth redirect params (e.g. ?oauth_success=1&provider=groq&token=...)
    const params = new URLSearchParams(window.location.search);
    if (params.get('oauth_success') === '1') {
      const provider = params.get('provider') ?? '';
      const token = params.get('token') ?? '';
      if (provider && token) {
        finalizeOAuth(provider, token);
      }
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const loadProviders = async () => {
    try {
      const data = await apiFetch<AIProviderConfig[]>('/api/providers');
      setProviders(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const finalizeOAuth = async (providerType: string, encryptedToken: string) => {
    try {
      await apiFetch('/api/providers', {
        method: 'POST',
        json: {
          type: providerType,
          name: PROVIDER_META[providerType]?.label ?? providerType,
          encryptedOAuthToken: encryptedToken,
        },
      });
      await loadProviders();
    } catch (e) {
      console.error('OAuth finalize error:', e);
    }
  };

  const startOAuth = async (providerType: string) => {
    setOauthPending(providerType);
    try {
      const { authUrl } = await apiFetch<{ authUrl: string; state: string }>(
        `/api/providers/oauth/start/${providerType}`
      );
      // Open popup
      const popup = window.open(authUrl, 'oauth', 'width=600,height=700,noopener');
      if (!popup) {
        window.location.href = authUrl;
        return;
      }
      // Poll until popup closes
      const timer = setInterval(async () => {
        if (popup.closed) {
          clearInterval(timer);
          setOauthPending(null);
          await loadProviders();
        }
      }, 500);
    } catch (e: any) {
      setError(e.message || 'OAuth failed');
      setOauthPending(null);
    }
  };

  const addProvider = async () => {
    setSaving(true);
    setError('');
    try {
      await apiFetch('/api/providers', {
        method: 'POST',
        json: {
          type: form.type,
          name: form.name || PROVIDER_META[form.type]?.label,
          apiKey: form.apiKey || undefined,
          baseUrl: form.baseUrl || undefined,
          defaultModel: form.defaultModel || undefined,
          defaultEmbeddingModel: form.defaultEmbeddingModel || undefined,
        },
      });
      await loadProviders();
      setShowAdd(false);
      setForm(EMPTY_FORM);
    } catch (e: any) {
      setError(e.message || 'Failed to add provider');
    } finally {
      setSaving(false);
    }
  };

  const deleteProvider = async (id: string) => {
    if (!confirm('Remove this AI provider?')) return;
    try {
      await apiFetch(`/api/providers/${id}`, { method: 'DELETE' });
      setProviders((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      console.error(e);
    }
  };

  const loadModels = async (providerId: string) => {
    if (modelsOpen === providerId) { setModelsOpen(null); return; }
    setModelsOpen(providerId);
    if (!models[providerId]) {
      try {
        const data = await apiFetch<{ llm: string[]; embedding: string[] }>(
          `/api/providers/${providerId}/models`
        );
        setModels((prev) => ({ ...prev, [providerId]: data }));
      } catch (e) {
        console.error(e);
      }
    }
  };

  const updateDefaultModel = async (id: string, defaultModel: string) => {
    try {
      await apiFetch(`/api/providers/${id}`, {
        method: 'PATCH',
        json: { defaultModel },
      });
      setProviders((prev) => prev.map((p) => p.id === id ? { ...p, defaultModel } : p));
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
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">Settings</h1>
            <p className="text-slate-400 mt-1">Manage AI providers and application settings</p>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white font-medium rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Provider
          </button>
        </div>

        {/* Quick OAuth connect buttons */}
        <div className="mb-8">
          <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide mb-3">Quick Connect</h2>
          <div className="flex flex-wrap gap-3">
            {Object.entries(PROVIDER_META).filter(([, m]) => m.hasOAuth).map(([type, meta]) => (
              <button
                key={type}
                onClick={() => startOAuth(type)}
                disabled={oauthPending === type}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-white text-sm font-medium bg-gradient-to-r ${meta.color} hover:opacity-90 disabled:opacity-50 transition-opacity`}
              >
                {oauthPending === type ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ExternalLink className="w-4 h-4" />
                )}
                {meta.oauthLabel}
              </button>
            ))}
          </div>
        </div>

        {/* Configured providers */}
        <div>
          <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide mb-3">
            Configured Providers ({providers.length})
          </h2>
          {providers.length === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
              <Settings className="w-10 h-10 text-slate-600 mx-auto mb-3" />
              <p className="text-slate-400">No AI providers configured yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {providers.map((p) => {
                const meta = PROVIDER_META[p.provider] ?? { label: p.provider, color: 'from-slate-500 to-slate-600', hasOAuth: false };
                return (
                  <div key={p.id} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                    <div className="flex items-center gap-4 px-4 py-3">
                      <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${meta.color} flex items-center justify-center flex-shrink-0`}>
                        <span className="text-white text-xs font-bold">{meta.label[0]}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-white">{p.name}</p>
                          {p.isDefaultLlm || p.isDefaultEmbedding ? (
                            <CheckCircle className="w-4 h-4 text-emerald-400" />
                          ) : (
                            <XCircle className="w-4 h-4 text-slate-500" />
                          )}
                        </div>
                        <p className="text-xs text-slate-500">
                          {meta.label} · {p.hasApiKey ? 'API Key' : 'OAuth'}
                          {p.defaultLlmModel && ` · ${p.defaultLlmModel}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => loadModels(p.id)}
                          className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                          title="Models"
                        >
                          <ChevronDown className={`w-4 h-4 transition-transform ${modelsOpen === p.id ? 'rotate-180' : ''}`} />
                        </button>
                        <button
                          onClick={() => deleteProvider(p.id)}
                          className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {modelsOpen === p.id && (
                      <div className="border-t border-slate-800 bg-slate-950/50 p-4">
                        {!models[p.id] ? (
                          <div className="flex items-center gap-2 text-sm text-slate-400">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Fetching models...
                          </div>
                        ) : (
                          <div className="space-y-3">
                            <div>
                              <label className="block text-xs text-slate-400 mb-1.5">Default LLM model</label>
                              <select
                                value={p.defaultLlmModel ?? ''}
                                onChange={(e) => updateDefaultModel(p.id, e.target.value)}
                                className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white"
                              >
                                <option value="">Select model...</option>
                                {models[p.id].llm.map((m) => (
                                  <option key={m} value={m}>{m}</option>
                                ))}
                              </select>
                            </div>
                            {models[p.id].embedding.length > 0 && (
                              <div>
                                <label className="block text-xs text-slate-400 mb-1.5">Embedding models available</label>
                                <div className="flex flex-wrap gap-1.5">
                                  {models[p.id].embedding.map((m) => (
                                    <span key={m} className="px-2 py-1 bg-slate-800 text-xs text-slate-300 rounded">
                                      {m}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Add provider modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-800 p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-white">Add AI Provider</h2>
              <button
                onClick={() => { setShowAdd(false); setForm(EMPTY_FORM); setError(''); }}
                className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Provider type</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white"
                >
                  {Object.entries(PROVIDER_META).map(([type, meta]) => (
                    <option key={type} value={type}>{meta.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Display name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={PROVIDER_META[form.type]?.label ?? 'Provider'}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-400"
                />
              </div>
              {form.type !== 'ollama' && !PROVIDER_META[form.type]?.hasOAuth && (
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5">API Key</label>
                  <input
                    type="password"
                    value={form.apiKey}
                    onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                    placeholder="sk-..."
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-400"
                  />
                </div>
              )}
              {form.type === 'ollama' && (
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5">Base URL</label>
                  <input
                    type="url"
                    value={form.baseUrl}
                    onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                    placeholder="http://localhost:11434"
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-400"
                  />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Default model (optional)</label>
                <input
                  type="text"
                  value={form.defaultModel}
                  onChange={(e) => setForm((f) => ({ ...f, defaultModel: e.target.value }))}
                  placeholder="e.g. gpt-4o-mini"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-400"
                />
              </div>
              {error && <p className="text-sm text-red-400">{error}</p>}
              <div className="flex gap-3 pt-1">
                <button
                  onClick={() => { setShowAdd(false); setForm(EMPTY_FORM); setError(''); }}
                  className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                {PROVIDER_META[form.type]?.hasOAuth ? (
                  <button
                    onClick={() => { setShowAdd(false); startOAuth(form.type); }}
                    className="flex-1 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Authorize
                  </button>
                ) : (
                  <button
                    onClick={addProvider}
                    disabled={saving}
                    className="flex-1 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                    Connect
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
