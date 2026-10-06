import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api-client';

export interface Stats {
  knowledgeBases: number;
  documents: { total: number; ready: number; processing: number; failed: number };
  chunks: number;
  storageBytes: number;
  queue: { queued: number; running: number; failed: number };
  recent: Array<{ id: string; title: string; status: string; knowledgeBaseId: string; knowledgeBaseName: string | null; at: string }>;
  system: { version: string; storageMode: 'sqlite' | 'postgres'; ingestConcurrency: number; workerRunning: boolean };
}

/** Installation-wide numbers. Refreshes quickly while documents are being indexed. */
export function useStats() {
  return useQuery({
    queryKey: ['stats'],
    queryFn: () => api.get<Stats>('/api/stats'),
    refetchInterval: (query) => {
      const s = query.state.data;
      return s && s.queue.queued + s.queue.running > 0 ? 5000 : 30_000;
    },
  });
}
