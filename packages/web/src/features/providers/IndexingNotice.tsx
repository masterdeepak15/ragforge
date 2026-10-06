import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { indexingGap } from './indexing';
import { useProviderSpecs, useProviders } from './queries';

/** Shown where documents are uploaded, so a missing indexing provider is noticed before an upload fails. */
export function IndexingNotice() {
  const providers = useProviders();
  const specs = useProviderSpecs();
  if (!providers.data || !specs.data) return null;
  const gap = indexingGap(providers.data, specs.data);
  if (!gap) return null;
  return (
    <p role="status" className="flex items-start gap-2 rounded-md bg-accent px-3.5 py-2.5 text-sm text-accent-foreground">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        {gap}{' '}
        <Link to="/settings" className="font-semibold underline">
          Open settings
        </Link>
      </span>
    </p>
  );
}
