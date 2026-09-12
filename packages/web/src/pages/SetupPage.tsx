import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Sparkles, Key, ArrowRight, Loader2 } from 'lucide-react';

export default function SetupPage() {
  const navigate = useNavigate();
  const { setManualUser } = useAuth();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [providerForm, setProviderForm] = useState({
    type: 'ollama' as 'ollama' | 'openai' | 'anthropic' | 'gemini' | 'groq',
    name: '',
    baseUrl: 'http://localhost:11434',
    apiKey: ''
  });

  const handleCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch<{ token: string; user: { id: string; email: string; username: string; role: string } }>(
        '/api/setup/init',
        { method: 'POST', json: form }
      );
      setManualUser(res.user as any, res.token);
      setStep(2);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAddProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const payload: any = {
        name: providerForm.name || `${providerForm.type} Provider`,
        provider: providerForm.type,
      };
      if (providerForm.type === 'ollama') {
        payload.baseUrl = providerForm.baseUrl;
      } else if (providerForm.apiKey) {
        payload.apiKey = providerForm.apiKey;
      }
      await apiFetch('/api/providers', { method: 'POST', json: payload });
      navigate('/');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-cyan-500 mb-4">
            <Sparkles className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">RAGForge</h1>
          <p className="text-slate-400">Self-Hosted AI Knowledge Base Platform</p>
        </div>

        <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
          {/* Step 1: Welcome */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-white mb-4">
                <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 font-semibold">1</div>
                <h2 className="text-lg font-semibold">Create Admin Account</h2>
              </div>

              <form onSubmit={handleCreateAdmin} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">Username</label>
                  <input
                    type="text"
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                    placeholder="admin"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">Email</label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                    placeholder="admin@example.com"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">Password</label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                    placeholder="Min 8 characters"
                    minLength={8}
                    required
                  />
                </div>

                {error && <p className="text-red-400 text-sm">{error}</p>}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold rounded-lg transition-colors disabled:opacity-50"
                >
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ArrowRight className="w-5 h-5" />}
                  Continue
                </button>
              </form>
            </div>
          )}

          {/* Step 2: Add Provider */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-white mb-4">
                <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 font-semibold">2</div>
                <h2 className="text-lg font-semibold">Connect AI Provider</h2>
              </div>

              <form onSubmit={handleAddProvider} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">Provider Type</label>
                  <div className="grid grid-cols-2 gap-2">
                    {['ollama', 'openai', 'anthropic', 'gemini', 'groq'].map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setProviderForm({ ...providerForm, type: p as any })}
                        className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                          providerForm.type === p
                            ? 'bg-emerald-500 text-white'
                            : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                        }`}
                      >
                        {p.charAt(0).toUpperCase() + p.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                {providerForm.type === 'ollama' && (
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1">Base URL</label>
                    <input
                      type="url"
                      value={providerForm.baseUrl}
                      onChange={(e) => setProviderForm({ ...providerForm, baseUrl: e.target.value })}
                      className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                      placeholder="http://localhost:11434"
                    />
                  </div>
                )}

                {providerForm.type !== 'ollama' && (
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1">API Key</label>
                    <input
                      type="password"
                      value={providerForm.apiKey}
                      onChange={(e) => setProviderForm({ ...providerForm, apiKey: e.target.value })}
                      className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                      placeholder="sk-..."
                    />
                  </div>
                )}

                {error && <p className="text-red-400 text-sm">{error}</p>}

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => navigate('/')}
                    className="flex-1 px-4 py-3 bg-slate-700 hover:bg-slate-600 text-slate-200 font-semibold rounded-lg transition-colors"
                  >
                    Skip
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold rounded-lg transition-colors disabled:opacity-50"
                  >
                    {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Key className="w-5 h-5" />}
                    Connect
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}