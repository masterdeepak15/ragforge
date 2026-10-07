import { createMcpApiKey, openAdminDb } from '@ragforge/server/admin';
import { sqliteUrl, type CliConfig } from './config.js';
import { healthUrl, requireConfig, type CliContext } from './context.js';
import { McpConfigProblem, addToClaudeCode, addToJsonConfig, claudeCodeCommand, cursorConfigPath, desktopConfigPath, entryFor, mcpUrl, removeFromClaudeCode, removeFromJsonConfig, type McpEntry } from './mcp.js';

const TARGETS = ['claude-code', 'claude-desktop', 'cursor'] as const;
type Target = (typeof TARGETS)[number];
const LABEL: Record<Target, string> = { 'claude-code': 'Claude Code', 'claude-desktop': 'Claude Desktop', cursor: 'Cursor' };
const SCOPES = ['user', 'local', 'project'];
const PLACEHOLDER = '<your-api-key>';

const USAGE = `Usage: ragforge mcp <add|remove|snippet> <claude-code|claude-desktop|cursor> [options]

  add       Connect the tool to your knowledge bases (creates an API key and writes the tool's configuration)
  remove    Disconnect the tool
  snippet   Print the configuration to paste yourself (changes nothing)

Options:
  --kb <names>    Limit access to these knowledge bases (comma separated names or ids). Default: all
  --name <name>   Name of the server inside the tool (default: ragforge)
  --scope <s>     Claude Code only: user (all projects, default), local or project
  --dry-run       Show what would be written, create nothing`;

async function withDb<T>(config: CliConfig, fn: (db: Awaited<ReturnType<typeof openAdminDb>>) => Promise<T>): Promise<T> {
  const db = await openAdminDb({ sqliteUrl: sqliteUrl(config.dbPath) });
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

/** Turns names (or ids) into knowledge base ids, or explains which ones exist. */
async function resolveKnowledgeBases(config: CliConfig, wanted: string[]): Promise<{ ids: string[] } | { error: string }> {
  const all = await withDb(config, async (db) => (await db.client.execute('SELECT id, name FROM knowledge_bases ORDER BY name')).rows as any[]);
  const ids: string[] = [];
  for (const w of wanted) {
    const hit = all.find((k) => k.id === w) ?? all.find((k) => String(k.name).toLowerCase() === w.toLowerCase());
    if (!hit) {
      const names = all.map((k) => `"${k.name}"`).join(', ') || 'none yet';
      return { error: `No knowledge base named "${w}". Available: ${names}.` };
    }
    ids.push(hit.id as string);
  }
  return { ids };
}

function snippetFor(target: Target, entry: McpEntry, scope: string): string {
  if (target === 'claude-code') return claudeCodeCommand(entry, scope);
  return JSON.stringify({ mcpServers: { [entry.name]: entryFor(target, entry) } }, null, 2);
}

export async function cmdMcp(ctx: CliContext, args: string[], flags: { kb?: string; name?: string; scope?: string; dryRun?: boolean }): Promise<number> {
  const [action, target] = args as [string | undefined, Target | undefined];
  if (!action || !['add', 'remove', 'snippet'].includes(action) || !target || !TARGETS.includes(target)) {
    ctx.err(USAGE);
    return 2;
  }
  const scope = flags.scope ?? 'user';
  if (!SCOPES.includes(scope)) {
    ctx.err(`--scope must be one of: ${SCOPES.join(', ')}.`);
    return 2;
  }
  const config = await requireConfig(ctx);
  if (!config) return 1;

  const name = flags.name ?? 'ragforge';
  const url = mcpUrl(config);
  const desktopFile = desktopConfigPath(ctx.platform, ctx.env, ctx.userHome);
  const jsonFile = target === 'claude-desktop' ? desktopFile : cursorConfigPath(ctx.userHome);

  try {
    if (action === 'snippet') {
      ctx.out(snippetFor(target, { name, url, key: PLACEHOLDER }, scope));
      return 0;
    }

    if (action === 'remove') {
      const result = target === 'claude-code' ? await removeFromClaudeCode(ctx.shell, name, scope) : await removeFromJsonConfig(jsonFile, name);
      ctx.out(result === 'removed' ? `Disconnected ${LABEL[target]} (removed "${name}").` : result === 'not-installed' ? 'Claude Code was not found on this computer.' : `${LABEL[target]} had no "${name}" entry.`);
      if (result === 'removed') ctx.out('The API key still exists in RAGForge; revoke it on the Connect page if you no longer need it.');
      return 0;
    }

    // add
    let scopeKbIds: string[] | undefined;
    if (flags.kb) {
      const resolved = await resolveKnowledgeBases(config, flags.kb.split(',').map((s) => s.trim()).filter(Boolean));
      if ('error' in resolved) {
        ctx.err(resolved.error);
        return 1;
      }
      scopeKbIds = resolved.ids;
    }

    if (flags.dryRun) {
      const entry = { name, url, key: PLACEHOLDER };
      ctx.out(`Dry run: nothing was created or changed. For ${LABEL[target]} RAGForge would add:\n`);
      if (target === 'claude-code') ctx.out(snippetFor(target, entry, scope));
      else ctx.out((await addToJsonConfig(jsonFile, target, entry, { dryRun: true })).preview!);
      return 0;
    }

    const { key } = await withDb(config, (db) => createMcpApiKey(db, { name: `RAGForge CLI (${target}: ${name})`, knowledgeBaseIds: scopeKbIds, replaceExisting: true }));
    const entry = { name, url, key };

    if (target === 'claude-code') {
      const result = await addToClaudeCode(ctx.shell, entry, { scope });
      if (result.done) {
        ctx.out(`Connected Claude Code to RAGForge (server "${name}", scope ${scope}).`);
      } else {
        ctx.out('Claude Code was not found on this computer. Install it, then run this command:\n');
        ctx.out(result.manual);
      }
    } else {
      const written = await addToJsonConfig(jsonFile, target, entry);
      ctx.out(`Connected ${LABEL[target]} to RAGForge: ${written.file}`);
      if (written.backup) ctx.out(`Your previous settings were kept as a backup: ${written.backup}`);
      if (target === 'claude-desktop') ctx.out('Restart Claude Desktop to load it. It needs Node.js, because it connects through "npx mcp-remote".');
      else ctx.out('Restart Cursor (or reload its MCP settings) to load it.');
    }

    ctx.out(scopeKbIds ? `Access is limited to ${scopeKbIds.length} knowledge base(s).` : 'Access: all knowledge bases. Use --kb to limit it.');
    const running = await fetch(healthUrl(config), { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    if (!running) ctx.out('RAGForge is not running right now. Start it with: ragforge start');
    return 0;
  } catch (err) {
    if (err instanceof McpConfigProblem) {
      ctx.err(err.message);
      return 1;
    }
    throw err;
  }
}
