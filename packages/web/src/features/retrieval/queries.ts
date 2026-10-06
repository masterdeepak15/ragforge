import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client';
import type { RetrievalSettings, RetrievalSettingsView } from './types';

export const retrievalKey = (kbId: string) => ['retrieval-settings', kbId] as const;
const path = (kbId: string) => `/api/knowledge-bases/${kbId}/retrieval-settings`;

export function useRetrievalSettings(kbId: string | undefined) {
  return useQuery({
    queryKey: retrievalKey(kbId ?? ''),
    queryFn: () => api.get<RetrievalSettingsView>(path(kbId!)),
    enabled: !!kbId,
  });
}

export function useSaveRetrievalSettings(kbId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: RetrievalSettings) => api.put<RetrievalSettingsView>(path(kbId), settings),
    onSuccess: (view) => qc.setQueryData(retrievalKey(kbId), view),
  });
}

export function useResetRetrievalSettings(kbId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del<RetrievalSettingsView>(path(kbId)),
    onSuccess: (view) => qc.setQueryData(retrievalKey(kbId), view),
  });
}
