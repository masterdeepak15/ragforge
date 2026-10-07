import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';

/**
 * Shown on a chat that has no knowledge base. Such a chat never searches your documents, so the AI
 * answers from general knowledge only, which looks like "wrong answers" about your own files.
 */
export function NoKbNotice({ hasKnowledgeBases }: { hasKnowledgeBases: boolean }) {
  return (
    <p role="status" className="flex items-start gap-2 rounded-md bg-accent px-3.5 py-2.5 text-sm text-accent-foreground">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        This chat is not using a knowledge base, so answers come from the AI's general knowledge, not from your documents.{' '}
        {hasKnowledgeBases ? (
          'Choose a knowledge base in the box above.'
        ) : (
          <Link to="/knowledge-bases" className="font-semibold underline underline-offset-2">
            Create a knowledge base
          </Link>
        )}
      </span>
    </p>
  );
}
