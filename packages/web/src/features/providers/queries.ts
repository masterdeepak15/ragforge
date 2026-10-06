import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client';
import type { ProviderConfig, ProviderSpec, TestResult } from './types';

export const providerKeys = { list: ['providers'] as const, specs: ['provider-specs'] as const };

export function useProviders() {
  return useQuery({ queryKey: providerKeys.list, queryFn: () => api.get<ProviderConfig[]>('/api/providers') });
}

export function useProviderSpecs() {
  return useQuery({
    queryKey: providerKeys.specs,
    queryFn: async () => (await api.get<{ providers: ProviderSpec[] }>('/api/providers/capabilities')).providers,
    staleTime: Infinity,
  });
}

/** Anything that reads providers (overview checklist, system numbers) refreshes after a change. */
function useRefreshProviders() {
  const qc = useQueryClient();
  return () => {
    for (const key of [providerKeys.list, ['setup-status'], ['stats']]) void qc.invalidateQueries({ queryKey: [...key] });
  };
}

export function useSetDefault() {
  const refresh = useRefreshProviders();
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: 'llm' | 'embedding' }) =>
      api.patch<ProviderConfig>(`/api/providers/${id}`, role === 'llm' ? { isDefaultLlm: true } : { isDefaultEmbedding: true }),
    onSettled: refresh,
  });
}

export function useRemoveProvider() {
  const refresh = useRefreshProviders();
  return useMutation({ mutationFn: (id: string) => api.del(`/api/providers/${id}`), onSettled: refresh });
}

export function useTestSaved() {
  return useMutation({ mutationFn: (id: string) => api.post<TestResult>(`/api/providers/${id}/test`) });
}

export function useAddProvider() {
  const refresh = useRefreshProviders();
  return useMutation({ mutationFn: (body: Record<string, unknown>) => api.post<ProviderConfig>('/api/providers', body), onSuccess: refresh });
}

export function useTestSettings() {
  return useMutation({ mutationFn: (body: Record<string, unknown>) => api.post<TestResult>('/api/providers/test', body) });
}
