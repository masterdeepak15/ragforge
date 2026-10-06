import React, { useCallback, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { SetupStatusProvider } from './lib/setup-status';
import { apiFetch } from './lib/api';
import type { SetupStatus } from './types/api';

// Lazy load pages
const SetupPage = React.lazy(() => import('./pages/SetupPage'));
const LoginPage = React.lazy(() => import('./pages/LoginPage'));
const AppShell = React.lazy(() => import('./components/shell/AppShell'));
const DashboardPage = React.lazy(() => import('./features/dashboard/DashboardPage'));
const ChatPage = React.lazy(() => import('./pages/ChatPage'));
const KnowledgeBasesPage = React.lazy(() => import('./pages/KnowledgeBasesPage'));
const KnowledgeDetailPage = React.lazy(() => import('./pages/KnowledgeDetailPage'));
const ConnectPage = React.lazy(() => import('./features/connect/ConnectPage'));
const SettingsPage = React.lazy(() => import('./pages/SettingsPage'));
const PlaygroundPage = React.lazy(() => import('./pages/PlaygroundPage'));

function AppRoutes() {
  const { user, token, loading } = useAuth();
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [checkingSetup, setCheckingSetup] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setSetupStatus(await apiFetch<SetupStatus>('/api/setup/status'));
    } catch {
      setSetupStatus(null);
    } finally {
      setCheckingSetup(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading || checkingSetup) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground text-center">
          <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p>Loading RAGForge...</p>
        </div>
      </div>
    );
  }

  // Mid-wizard the admin already exists and is signed in; the wizard stays up until it refreshes the status itself.
  if (!setupStatus?.isInitialized) {
    return (
      <SetupStatusProvider value={{ status: setupStatus, refresh }}>
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="*" element={<Navigate to="/setup" replace />} />
        </Routes>
      </SetupStatusProvider>
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
      <Route path="/" element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="chat/:id" element={<ChatPage />} />
        <Route path="knowledge-bases" element={<KnowledgeBasesPage />} />
        <Route path="knowledge-bases/:id" element={<KnowledgeDetailPage />} />
        <Route path="connect" element={<ConnectPage />} />
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
          <div className="min-h-screen bg-background flex items-center justify-center">
            <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        }
      >
        <AppRoutes />
      </React.Suspense>
    </AuthProvider>
  );
}
