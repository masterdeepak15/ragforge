import { useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { testMcpConnection, type ConnectionResult } from './snippets';

/** Calls /mcp with a key. With `apiKey` it tests that key; without, the user pastes one. */
export function ConnectionTester({ origin, apiKey }: { origin: string; apiKey?: string }) {
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectionResult | null>(null);
  const key = apiKey ?? pasted.trim();

  const run = async () => {
    setBusy(true);
    setResult(null);
    setResult(await testMcpConnection(origin, key));
    setBusy(false);
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {apiKey === undefined && (
          <Input type="password" aria-label="API key to test" placeholder="Paste an API key (rf_…)" value={pasted} onChange={(e) => setPasted(e.target.value)} autoComplete="off" />
        )}
        <Button variant="secondary" onClick={() => void run()} loading={busy} disabled={!key}>
          Test connection
        </Button>
      </div>
      {result && (
        <p role="status" className={result.ok ? 'flex items-center gap-1.5 text-sm text-success' : 'flex items-center gap-1.5 text-sm text-destructive'}>
          {result.ok ? <CheckCircle2 className="size-4" aria-hidden /> : <XCircle className="size-4" aria-hidden />}
          {result.ok ? `Connected. This key can see ${result.knowledgeBases} ${result.knowledgeBases === 1 ? 'knowledge base' : 'knowledge bases'}.` : result.message}
        </p>
      )}
    </div>
  );
}
