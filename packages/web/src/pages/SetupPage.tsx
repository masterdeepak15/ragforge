import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useSetupStatus } from '../lib/setup-status';
import { setToken } from '../lib/api';
import type { User } from '../types/api';
import { Sparkles, Key, ArrowRight, Loader2 } from 'lucide-react';

export default function SetupPage() {
  const navigate = useNavigate();
  const { setManualUser } = useAuth();
  const { refresh } = useSetupStatus();
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
      const res = await apiFetch<{ token: string; user?: User }>('/api/setup/init', { method: 'POST', json: form });
      setToken(res.token);
      const user = res.user ?? (await apiFetch<User>('/api/auth/me'));
      setManualUser(user, res.token);
      setStep(2);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  /** Setup is over: tell the app, then go to the overview (a stale status would bounce back here). */
  const finish = async () => {
    await refresh();
    navigate('/');
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
      await finish();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary mb-4">
            <Sparkles className="w-8 h-8 text-foreground" />
          </div>
          <h1 className="text-3xl font-bold text-foreground mb-2">RAGForge</h1>
          <p className="text-muted-foreground">Self-Hosted AI Knowledge Base Platform</p>
        </div>

        <div className="bg-card rounded-xl border border-border p-6">
          {/* Step 1: Welcome */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-foreground mb-4">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-semibold">1</div>
                <h2 className="text-lg font-semibold">Create Admin Account</h2>
              </div>

              <form onSubmit={handleCreateAdmin} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-foreground/80 mb-1">Username</label>
                  <input
                    type="text"
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    className="w-full px-4 py-2 bg-muted border border-border rounded-lg text-foreground focus:ring-2 focus:ring-ring focus:border-transparent"
                    placeholder="admin"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground/80 mb-1">Email</label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className="w-full px-4 py-2 bg-muted border border-border rounded-lg text-foreground focus:ring-2 focus:ring-ring focus:border-transparent"
                    placeholder="admin@example.com"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground/80 mb-1">Password</label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className="w-full px-4 py-2 bg-muted border border-border rounded-lg text-foreground focus:ring-2 focus:ring-ring focus:border-transparent"
                    placeholder="Min 8 characters"
                    minLength={8}
                    required
                  />
                </div>

                {error && <p className="text-destructive text-sm">{error}</p>}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold rounded-lg transition-colors disabled:opacity-50"
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
              <div className="flex items-center gap-3 text-foreground mb-4">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-semibold">2</div>
                <h2 className="text-lg font-semibold">Connect AI Provider</h2>
              </div>

              <form onSubmit={handleAddProvider} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-foreground/80 mb-2">Provider Type</label>
                  <div className="grid grid-cols-2 gap-2">
                    {['ollama', 'openai', 'anthropic', 'gemini', 'groq'].map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setProviderForm({ ...providerForm, type: p as any })}
                        className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                          providerForm.type === p
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-foreground/80 hover:bg-muted'
                        }`}
                      >
                        {p.charAt(0).toUpperCase() + p.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                {(providerForm.type === 'anthropic' || providerForm.type === 'groq') && (
                  <p role="note" className="rounded-md bg-accent px-3 py-2 text-sm text-accent-foreground">
                    {providerForm.type === 'anthropic' ? 'Claude' : 'Groq'} can only write answers. To index documents you also need Ollama, OpenAI or Google Gemini. You can add it later in Settings.
                  </p>
                )}

                {providerForm.type === 'ollama' && (
                  <div>
                    <label className="block text-sm font-medium text-foreground/80 mb-1">Base URL</label>
                    <input
                      type="url"
                      value={providerForm.baseUrl}
                      onChange={(e) => setProviderForm({ ...providerForm, baseUrl: e.target.value })}
                      className="w-full px-4 py-2 bg-muted border border-border rounded-lg text-foreground focus:ring-2 focus:ring-ring focus:border-transparent"
                      placeholder="http://localhost:11434"
                    />
                  </div>
                )}

                {providerForm.type !== 'ollama' && (
                  <div>
                    <label className="block text-sm font-medium text-foreground/80 mb-1">API Key</label>
                    <input
                      type="password"
                      value={providerForm.apiKey}
                      onChange={(e) => setProviderForm({ ...providerForm, apiKey: e.target.value })}
                      className="w-full px-4 py-2 bg-muted border border-border rounded-lg text-foreground focus:ring-2 focus:ring-ring focus:border-transparent"
                      placeholder="sk-..."
                    />
                  </div>
                )}

                {error && <p className="text-destructive text-sm">{error}</p>}

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => void finish()}
                    className="flex-1 px-4 py-3 bg-muted hover:bg-muted text-foreground font-semibold rounded-lg transition-colors"
                  >
                    Skip
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold rounded-lg transition-colors disabled:opacity-50"
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