export interface VectorChunkInput {
  id: string;
  documentId: string;
  knowledgeBaseId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  metadata?: Record<string, any>;
  embedding: number[];
}

export interface VectorSearchResult {
  id: string;
  score: number;
}

export interface IVectorStore {
  upsertChunks(chunks: VectorChunkInput[]): Promise<void>;
  search(
    knowledgeBaseId: string,
    queryEmbedding: number[],
    topK: number,
    threshold?: number
  ): Promise<VectorSearchResult[]>;
  deleteByDocumentId(documentId: string): Promise<void>;
  deleteByKnowledgeBaseId(knowledgeBaseId: string): Promise<void>;
}
