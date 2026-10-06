/** How a knowledge base is searched. Shared by the Playground, Chat and connected AI tools. */
export interface RetrievalSettings {
  topK: number;
  useHybridSearch: boolean;
  vectorWeight: number;
  bm25Weight: number;
  /** Vector matches less similar than this (0 to 1) are dropped. */
  minSimilarity: number;
}

export interface RetrievalSettingsView {
  settings: RetrievalSettings;
  defaults: RetrievalSettings;
  /** True once someone has saved their own settings for this knowledge base. */
  customized: boolean;
}
