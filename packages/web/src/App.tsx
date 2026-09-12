import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { apiFetch } from './lib/api';
import type { SetupStatus } from './types/api';

// Lazy load pages
const SetupPage = React.lazy(() => import('./pages/SetupPage'));
const LoginPage = React.lazy(() => import('./pages/LoginPage'));
const Layout = React.lazy(() => import('./components/Layout'));
const ChatPage = React.lazy(() => import('./pages/ChatPage'));
const KnowledgeBasesPage = React.lazy(() => import('./pages/KnowledgeBasesPage'));
const KnowledgeDetailPage = React.lazy(() => import('./pages/KnowledgeDetailPage'));
const SettingsPage = React.lazy(() => import('./pages/SettingsPage'));
const PlaygroundPage = React.lazy(() => import('./pages/PlaygroundPage'));

function AppRoutes() {
  const { user, token, loading } = useAuth();
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [checkingSetup, setCheckingSetup] = useState(true);

  useEffect(() => {
    apiFetch<SetupStatus>('/api/setup/status')
      .then(setSetupStatus)
      .catch(() => setSetupStatus(null))
      .finally(() => setCheckingSetup(false));
  }, []);

  if (loading || checkingSetup) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-slate-400 text-center">
          <div className="w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p>Loading RAGForge...</p>
        </div>
      </div>
    );
  }

  if (!setupStatus?.isInitialized) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (!token || !user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<ChatPage />} />
        <Route path="knowledge-bases" element={<KnowledgeBasesPage />} />
        <Route path="knowledge-bases/:id" element={<KnowledgeDetailPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="playground" element={<PlaygroundPage />} />
      </Route>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/setup" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <React.Suspense
        fallback={
          <div className="min-h-screen bg-slate-950 flex items-center justify-center">
            <div className="w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          </div>
        }
      >
        <AppRoutes />
      </React.Suspense>
    </AuthProvider>
  );
}
