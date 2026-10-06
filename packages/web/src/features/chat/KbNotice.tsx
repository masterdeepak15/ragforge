import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';

/**
 * A heads-up above the chat input when the attached knowledge base cannot fully ground answers yet.
 * Renders nothing while readiness is unknown or when everything is indexed.
 */
export function KbNotice({ kbId, ready, processing }: { kbId: string; ready?: number; processing?: number }) {
  if (ready === undefined || processing === undefined) return null;

  let message: React.ReactNode = null;
  if (processing > 0) {
    message = `${processing} ${processing === 1 ? 'document is' : 'documents are'} still being indexed. Answers may be incomplete until they finish.`;
  } else if (ready === 0) {
    message = (
      <>
        This knowledge base has no ready documents yet, so answers cannot cite your files.{' '}
        <Link to={`/knowledge-bases/${kbId}`} className="font-semibold underline underline-offset-2">
          Add documents
        </Link>
      </>
    );
  }
  if (!message) return null;

  return (
    <p role="status" className="flex items-start gap-2 rounded-md bg-accent px-3.5 py-2.5 text-sm text-accent-foreground">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </p>
  );
}
