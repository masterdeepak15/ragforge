import React, { createContext, useContext, useEffect, useState } from 'react';
import { apiFetch, setToken, clearToken } from './api.js';
import type { User } from '../types/api.js';

interface AuthState {
  user: User | null;
  token: string | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setManualUser: (user: User, token: string) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>(() => {
    try {
      const token = localStorage.getItem('ragforge_token');
      const raw = localStorage.getItem('ragforge_user');
      const user = raw ? (JSON.parse(raw) as User) : null;
      return { user, token, loading: !!token && !user };
    } catch {
      return { user: null, token: null, loading: false };
    }
  });

  useEffect(() => {
    if (state.token && !state.user) {
      apiFetch<User>('/api/auth/me')
        .then((user) => {
          localStorage.setItem('ragforge_user', JSON.stringify(user));
          setState((s) => ({ ...s, user, loading: false }));
        })
        .catch(() => {
          clearToken();
          setState({ user: null, token: null, loading: false });
        });
    } else if (!state.token) {
      setState((s) => ({ ...s, loading: false }));
    }
  }, []);

  const login = async (email: string, password: string) => {
    const res = await apiFetch<{ token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      json: { email, password },
    });
    setToken(res.token);
    localStorage.setItem('ragforge_user', JSON.stringify(res.user));
    setState({ user: res.user, token: res.token, loading: false });
  };

  const logout = () => {
    clearToken();
    setState({ user: null, token: null, loading: false });
  };

  const setManualUser = (user: User, token: string) => {
    setToken(token);
    localStorage.setItem('ragforge_user', JSON.stringify(user));
    setState({ user, token, loading: false });
  };

  return (
    <AuthContext.Provider value={{ ...state, login, logout, setManualUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
