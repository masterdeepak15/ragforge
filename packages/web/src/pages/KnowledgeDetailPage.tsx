import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Upload, FileText, Loader2, Trash2, CheckCircle,
  XCircle, Clock, Layers, ChevronDown, ChevronRight, Link
} from 'lucide-react';
import { apiFetch, apiUpload } from '../lib/api';
import type { KnowledgeBase, Document, DocumentChunk } from '../types/api';

const STATUS_ICON = {
  pending: <Clock className="w-4 h-4 text-slate-400" />,
  processing: <Loader2 className="w-4 h-4 text-yellow-400 animate-spin" />,
  ready: <CheckCircle className="w-4 h-4 text-emerald-400" />,
  error: <XCircle className="w-4 h-4 text-red-400" />,
};

export default function KnowledgeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);
  const [chunks, setChunks] = useState<Record<string, DocumentChunk[]>>({});
  const [urlInput, setUrlInput] = useState('');
  const [showUrlInput, setShowUrlInput] = useState(false);

  useEffect(() => {
    if (id) loadData();
  }, [id]);

  const loadData = async () => {
    try {
      const [kbData, docsData] = await Promise.all([
        apiFetch<KnowledgeBase>(`/api/knowledge-bases/${id}`),
        apiFetch<Document[]>(`/api/knowledge-bases/${id}/documents`),
      ]);
      setKb(kbData);
      setDocuments(docsData);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        setUploadProgress(`Uploading ${file.name}...`);
        const form = new FormData();
        form.append('file', file);
        form.append('knowledgeBaseId', id!);
        await apiUpload<Document>('/api/documents/upload', form);
      }
      await loadData();
    } catch (e: any) {
      setUploadProgress(`Error: ${e.message}`);
    } finally {
      setUploading(false);
      setUploadProgress('');
      e.target.value = '';
    }
  };

  const handleUrlIngest = async () => {
    if (!urlInput.trim()) return;
    setUploading(true);
    setUploadProgress(`Fetching ${urlInput}...`);
    try {
      const form = new FormData();
      form.append('url', urlInput);
      form.append('knowledgeBaseId', id!);
      await apiUpload<Document>('/api/documents/upload', form);
      setUrlInput('');
      setShowUrlInput(false);
      await loadData();
    } catch (e: any) {
      setUploadProgress(`Error: ${e.message}`);
    } finally {
      setUploading(false);
      setUploadProgress('');
    }
  };

  const deleteDocument = async (docId: string) => {
    if (!confirm('Delete this document and all its chunks?')) return;
    try {
      await apiFetch(`/api/documents/${docId}`, { method: 'DELETE' });
      setDocuments((prev) => prev.filter((d) => d.id !== docId));
    } catch (e) {
      console.error(e);
    }
  };

  const toggleChunks = async (docId: string) => {
    if (expandedDoc === docId) {
      setExpandedDoc(null);
      return;
    }
    setExpandedDoc(docId);
    if (!chunks[docId]) {
      try {
        const data = await apiFetch<{ chunks: DocumentChunk[] }>(`/api/documents/${docId}/chunks`);
        setChunks((prev) => ({ ...prev, [docId]: data.chunks }));
      } catch (e) {
        console.error(e);
      }
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-slate-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 h-full overflow-y-auto bg-slate-950">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => navigate('/knowledge-bases')}
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-bold text-white">{kb?.name}</h1>
            {kb?.description && <p className="text-sm text-slate-400">{kb.description}</p>}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowUrlInput(!showUrlInput)}
              className="flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm rounded-lg transition-colors"
            >
              <Link className="w-4 h-4" />
              URL
            </button>
            <label className="flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium rounded-lg cursor-pointer transition-colors">
              <Upload className="w-4 h-4" />
              Upload
              <input
                type="file"
                multiple
                accept=".pdf,.docx,.txt,.md"
                onChange={handleFileUpload}
                className="hidden"
                disabled={uploading}
              />
            </label>
          </div>
        </div>

        {/* URL input */}
        {showUrlInput && (
          <div className="mb-4 flex gap-2">
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleUrlIngest()}
              placeholder="https://example.com/page"
              className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:ring-2 focus:ring-emerald-500 text-sm"
            />
            <button
              onClick={handleUrlIngest}
              disabled={!urlInput.trim() || uploading}
              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
            >
              Ingest
            </button>
          </div>
        )}

        {/* Upload progress */}
        {uploading && (
          <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-slate-800 rounded-lg text-sm text-slate-300">
            <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
            {uploadProgress || 'Processing...'}
          </div>
        )}

        {/* Documents list */}
        {documents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <FileText className="w-12 h-12 text-slate-600 mb-4" />
            <h3 className="text-lg font-semibold text-white mb-2">No documents yet</h3>
            <p className="text-slate-400">Upload PDFs, Word docs, text files, or ingest a URL</p>
          </div>
        ) : (
          <div className="space-y-2">
            {documents.map((doc) => (
              <div key={doc.id} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3">
                  {STATUS_ICON[doc.status as keyof typeof STATUS_ICON] ?? STATUS_ICON.pending}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{doc.title}</p>
                    <p className="text-xs text-slate-500">
                      {doc.chunk_count ?? 0} chunks · {doc.status}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => toggleChunks(doc.id)}
                      className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                      title="View chunks"
                    >
                      {expandedDoc === doc.id ? (
                        <ChevronDown className="w-4 h-4" />
                      ) : (
                        <ChevronRight className="w-4 h-4" />
                      )}
                    </button>
                    <button
                      onClick={() => deleteDocument(doc.id)}
                      className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Chunk inspector */}
                {expandedDoc === doc.id && (
                  <div className="border-t border-slate-800 bg-slate-950/50 p-4">
                    {!chunks[doc.id] ? (
                      <div className="flex items-center gap-2 text-sm text-slate-400">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Loading chunks...
                      </div>
                    ) : chunks[doc.id].length === 0 ? (
                      <p className="text-sm text-slate-500">No chunks found</p>
                    ) : (
                      <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                        {chunks[doc.id].map((chunk, i) => (
                          <div key={chunk.id} className="text-xs bg-slate-800 rounded-lg p-3">
                            <div className="flex items-center gap-2 mb-1.5">
                              <Layers className="w-3 h-3 text-slate-500" />
                              <span className="text-slate-400">Chunk {i + 1}</span>
                              <span className="text-slate-600">·</span>
                              <span className="text-slate-500">{chunk.token_count ?? '?'} tokens</span>
                            </div>
                            <p className="text-slate-300 leading-relaxed line-clamp-4">
                              {chunk.content}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
