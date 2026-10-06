import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api-client';
import type { DocumentsPage } from '../knowledge/types';

/** How many documents of a knowledge base are ready or still being indexed; polls while indexing. */
export function useKbReadiness(kbId: string | undefined) {
  return useQuery({
    queryKey: ['kb-readiness', kbId],
    enabled: !!kbId,
    queryFn: async () => {
      const page = await api.get<DocumentsPage>(`/api/knowledge-bases/${kbId}/documents?limit=1`);
      return { ready: page.counts.ready, processing: page.counts.processing + page.counts.pending };
    },
    refetchInterval: (query) => ((query.state.data?.processing ?? 0) > 0 ? 5000 : false),
  });
}
