import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client';
import type { KnowledgeBase } from '../../types/api';
import { statusParam, type DocumentFilters, type DocumentsPage, type IngestionJob } from './types';

export const PAGE_SIZE = 100;

export function useKnowledgeBase(kbId: string | undefined) {
  return useQuery({
    queryKey: ['kb', kbId],
    queryFn: () => api.get<KnowledgeBase & { documentCount?: number; chunkCount?: number }>(`/api/knowledge-bases/${kbId}`),
    enabled: !!kbId,
  });
}

/** Documents of a knowledge base, fetched page by page as the table scrolls. */
export function useDocuments(kbId: string | undefined, filters: DocumentFilters) {
  return useInfiniteQuery({
    queryKey: ['documents', kbId, filters],
    enabled: !!kbId,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(pageParam) });
      const status = statusParam(filters.status);
      if (status) params.set('status', status);
      if (filters.q) params.set('q', filters.q);
      return api.get<DocumentsPage>(`/api/knowledge-bases/${kbId}/documents?${params}`);
    },
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    placeholderData: (previous) => previous, // keep the old rows visible while a filter loads
  });
}

/** Jobs that need attention: queued, running or failed. Finished jobs are visible as ready documents. */
export function useJobs(kbId: string | undefined) {
  return useQuery({
    queryKey: ['jobs', kbId],
    enabled: !!kbId,
    queryFn: () => api.get<IngestionJob[]>(`/api/ingestion/jobs?knowledgeBaseId=${kbId}&status=queued,running,failed&limit=300`),
  });
}

export function useDeleteDocuments(kbId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.post<{ deleted: number }>('/api/documents/bulk-delete', { ids }),
    onSettled: () => {
      for (const key of ['documents', 'jobs', 'kb']) void qc.invalidateQueries({ queryKey: [key, kbId] });
      void qc.invalidateQueries({ queryKey: ['knowledge-bases'] });
    },
  });
}

export function useRetryJob(kbId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.post(`/api/ingestion/jobs/${jobId}/retry`),
    onSettled: () => {
      for (const key of ['documents', 'jobs']) void qc.invalidateQueries({ queryKey: [key, kbId] });
    },
  });
}

export function useCancelJob(kbId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.del(`/api/ingestion/jobs/${jobId}`),
    onSettled: () => {
      for (const key of ['documents', 'jobs']) void qc.invalidateQueries({ queryKey: [key, kbId] });
    },
  });
}
