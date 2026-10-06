import { X, FileText, ExternalLink, Hash } from 'lucide-react';
import type { Citation } from '../../types/api';

interface Props {
  citation: Citation | null;
  onClose: () => void;
}

export default function CitationDrawer({ citation, onClose }: Props) {
  return (
    <div
      className={`fixed inset-y-0 right-0 w-96 bg-card border-l border-border transform transition-transform duration-300 ease-in-out z-40 flex flex-col ${
        citation ? 'translate-x-0' : 'translate-x-full'
      }`}
    >
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-primary/20 flex items-center justify-center">
            <span className="text-xs font-bold text-primary">{citation?.citationIndex}</span>
          </div>
          <h3 className="font-semibold text-foreground text-sm">Source</h3>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {citation && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Document info */}
          <div className="bg-muted/50 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2 text-foreground/80">
              <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <span className="text-sm font-medium truncate">{citation.documentTitle}</span>
            </div>
            {citation.sourceUrl && (
              <a
                href={citation.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-primary hover:text-primary transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                <span className="truncate">{citation.sourceUrl}</span>
              </a>
            )}
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Hash className="w-3 h-3" />
              <span>Score: {citation.score?.toFixed(3) ?? 'N/A'}</span>
            </div>
          </div>

          {/* Chunk content */}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Relevant passage
            </p>
            <div className="bg-muted rounded-lg p-3">
              <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                {citation.chunkContent}
              </p>
            </div>
          </div>

          {/* Metadata breadcrumbs */}
          {citation.metadata && Object.keys(citation.metadata).length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Metadata
              </p>
              <div className="space-y-1">
                {Object.entries(citation.metadata).map(([key, value]) => (
                  <div key={key} className="flex gap-2 text-xs">
                    <span className="text-muted-foreground min-w-[80px]">{key}</span>
                    <span className="text-foreground/80">{String(value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
