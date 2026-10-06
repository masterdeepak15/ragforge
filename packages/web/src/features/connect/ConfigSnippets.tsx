import { Copy } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { copyText } from './clipboard';
import { KEY_PLACEHOLDER, buildSnippets } from './snippets';

const CLIENTS = [
  { value: 'claude-code', label: 'Claude Code', key: 'claudeCode' as const, hint: 'Run this in a terminal.' },
  { value: 'claude-desktop', label: 'Claude Desktop', key: 'claudeDesktop' as const, hint: 'Add it to claude_desktop_config.json (Settings → Developer → Edit config).' },
  { value: 'cursor', label: 'Cursor', key: 'cursor' as const, hint: 'Add it to ~/.cursor/mcp.json, or the project\'s .cursor/mcp.json.' },
];

/** Setup instructions per AI client. Uses a placeholder until a real key is supplied. */
export function ConfigSnippets({ origin, apiKey }: { origin: string; apiKey?: string | null }) {
  const snippets = buildSnippets(origin, apiKey || KEY_PLACEHOLDER);
  return (
    <Tabs defaultValue="claude-code">
      <TabsList>
        {CLIENTS.map((c) => (
          <TabsTrigger key={c.value} value={c.value}>{c.label}</TabsTrigger>
        ))}
      </TabsList>
      {CLIENTS.map((c) => (
        <TabsContent key={c.value} value={c.value} className="mt-3">
          <p className="mb-2 text-sm text-muted-foreground">{c.hint}</p>
          <div className="relative">
            <pre className="whitespace-pre-wrap break-all pr-12"><code>{snippets[c.key]}</code></pre>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Copy ${c.label} setup`}
              className="absolute right-2 top-2 text-code-foreground hover:bg-white/10 hover:text-code-foreground"
              onClick={() => void copyText(snippets[c.key], 'Setup copied')}
            >
              <Copy />
            </Button>
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}
