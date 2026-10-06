import { useQuery } from '@tanstack/react-query';
import { api } from './api-client';
import type { KbSummary } from '../features/knowledge/types';

export const queryKeys = {
  knowledgeBases: ['knowledge-bases'] as const,
};

export function useKnowledgeBases() {
  return useQuery({
    queryKey: queryKeys.knowledgeBases,
    queryFn: () => api.get<KbSummary[]>('/api/knowledge-bases'),
  });
}
