import { useQuery } from '@tanstack/react-query';
import { api } from './api-client';
import type { KnowledgeBase } from '../types/api';

export const queryKeys = {
  knowledgeBases: ['knowledge-bases'] as const,
};

export function useKnowledgeBases() {
  return useQuery({
    queryKey: queryKeys.knowledgeBases,
    queryFn: () => api.get<KnowledgeBase[]>('/api/knowledge-bases'),
  });
}
