import { parseArgs } from 'util';
import { cmdDoctor } from './doctor.js';
import { appUrl, requireConfig, type CliContext } from './context.js';
import { cmdLogs, cmdOpen, cmdRestart, cmdStart, cmdStatus, cmdStop, serviceTarget } from './lifecycle.js';
import { cmdMcp } from './mcp-command.js';
import { autoPrompter } from './prompter.js';
import { ServiceProblem, installService, serviceStatus, uninstallService } from './service.js';
import { runSetup, type SetupFlags } from './setup.js';
import { cmdUninstall } from './uninstall.js';

export const HELP = `RAGForge: a self-hosted knowledge base with cited answers and an MCP server.

Usage: ragforge <command> [options]

Set up and run
  setup            Guided setup: where to keep data, the database, local AI with Docker and Ollama
  start            Start RAGForge in the background          (--open to open the browser)
  stop             Stop it                                    (--all also stops Ollama)
  restart          Stop and start again
  status           Show what is running and where the data is
  logs             Show the log                               (-n 100 for more lines, -f to follow)
  open             Open RAGForge in your browser
  doctor           Check everything RAGForge depends on and say what to fix

Connect AI tools
  mcp add <tool>   Connect Claude Code, Claude Desktop or Cursor     (tool: claude-code | claude-desktop | cursor)
  mcp remove <tool>
  mcp snippet <tool>   Print the configuration instead of writing it

Start with the computer
  service install      Start RAGForge automatically when you log in
  service uninstall
  service status

Remove
  uninstall        Stop RAGForge and remove its container and autostart; your data is kept
  uninstall --data Also delete your data, database and settings (asks first)

Run \`ragforge setup --help\` or \`ragforge mcp\` for the options of a command.
Settings live in ~/.ragforge (change with the RAGFORGE_HOME environment variable).`;

const SETUP_HELP = `Usage: ragforge setup [options]

  -y, --yes               Accept every default and ask nothing
      --port <n>          Port for the web app (default 8080)
      --host <address>    127.0.0.1 = this computer only (default), 0.0.0.0 = the whole network
      --data-dir <path>   Where uploaded files and models are kept (default ~/.ragforge/data)
      --db-path <path>    SQLite database file (default <data-dir>/ragforge.db)
      --models-dir <path> Where Ollama keeps its models (default <data-dir>/ollama)
      --ollama <mode>     docker | external | none
      --ollama-url <url>  Address of your own Ollama (with --ollama external)
      --ollama-port <n>   Port for the Ollama container (default 11434)
      --chat-model <name> Model for answers
      --no-start          Do not start RAGForge when setup finishes`;

class UsageError extends Error {}

function parse<T extends Record<string, { type: 'string' | 'boolean'; short?: string }>>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

const toPort = (v: string | undefined, flag: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError(`${flag} must be a number from 1 to 65535.`);
  return n;
};

async function cmdSetup(ctx: CliContext, args: string[]): Promise<number> {
  const { values } = parse(args, {
    yes: { type: 'boolean', short: 'y' },
    port: { type: 'string' },
    host: { type: 'string' },
    'data-dir': { type: 'string' },
    'db-path': { type: 'string' },
    'models-dir': { type: 'string' },
    ollama: { type: 'string' },
    'ollama-url': { type: 'string' },
    'ollama-port': { type: 'string' },
    'chat-model': { type: 'string' },
    'no-start': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help) {
    ctx.out(SETUP_HELP);
    return 0;
  }
  if (values.ollama && !['docker', 'external', 'none'].includes(values.ollama)) throw new UsageError('--ollama must be docker, external or none.');

  const flags: SetupFlags = {
    yes: values.yes,
    port: toPort(values.port, '--port'),
    host: values.host,
    dataDir: values['data-dir'],
    dbPath: values['db-path'],
    modelsDir: values['models-dir'],
    ollama: values.ollama as SetupFlags['ollama'],
    ollamaUrl: values['ollama-url'],
    ollamaPort: toPort(values['ollama-port'], '--ollama-port'),
    chatModel: values['chat-model'],
  };

  try {
    const result = await runSetup({ home: ctx.home, prompter: values.yes ? autoPrompter() : ctx.prompter, shell: ctx.shell, out: ctx.out, platform: ctx.platform, env: ctx.env, ramGb: ctx.ramGb, flags, fetchImpl: ctx.fetchImpl });

    for (const w of result.warnings) ctx.out(`Note: ${w}`);
    if (!result.changed) return 0;

    ctx.out('\nSetup is complete.');
    let code = 0;
    if (result.startNow && !values['no-start']) {
      code = await cmdStart(ctx, { open: false });
    } else {
      ctx.out('Start RAGForge:  ragforge start');
    }
    ctx.out(`\nNext steps`);
    ctx.out(`  Open it:                 ${appUrl(result.config)}   (create your admin account on first visit)`);
    ctx.out('  Connect Claude Code:     ragforge mcp add claude-code');
    ctx.out('  Start at login:          ragforge service install');
    ctx.out('  Check everything:        ragforge doctor');
    return code;
  } catch (err) {
    if (err instanceof Error && /^Invalid --/.test(err.message)) throw new UsageError(err.message);
    throw err;
  } finally {
    ctx.prompter.close?.();
  }
}

async function cmdService(ctx: CliContext, args: string[]): Promise<number> {
  const action = args[0];
  if (!['install', 'uninstall', 'status'].includes(action ?? '')) throw new UsageError('Usage: ragforge service <install|uninstall|status>');
  const target = serviceTarget(ctx);
  try {
    if (action === 'install') {
      if (!(await requireConfig(ctx))) return 1;
      const { summary, note } = await installService(ctx.shell, target);
      ctx.out(summary);
      if (note) ctx.out(note);
      ctx.out('Turn it off again with: ragforge service uninstall');
      return 0;
    }
    if (action === 'uninstall') {
      const r = await uninstallService(ctx.shell, target);
      ctx.out(r === 'removed' ? 'RAGForge will no longer start by itself.' : 'Autostart was not on.');
      return 0;
    }
    const state = await serviceStatus(ctx.shell, target);
    ctx.out(state === 'installed' ? 'On: RAGForge starts when you log in.' : state === 'unsupported' ? `Starting at login is not supported on ${ctx.platform}.` : 'Off. Turn it on with: ragforge service install');
    return 0;
  } catch (err) {
    if (!(err instanceof ServiceProblem)) throw err;
    ctx.err(err.message);
    return 1;
  }
}

export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  const [command = 'help', ...rest] = argv;
  try {
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        ctx.out(HELP);
        return 0;
      case 'version':
      case '--version':
      case '-v':
        ctx.out(ctx.version);
        return 0;
      case 'setup':
        return await cmdSetup(ctx, rest);
      case 'start': {
        const { values } = parse(rest, { quiet: { type: 'boolean' }, open: { type: 'boolean' } });
        return await cmdStart(ctx, { quiet: values.quiet, open: values.open });
      }
      case 'stop': {
        const { values } = parse(rest, { all: { type: 'boolean' } });
        return await cmdStop(ctx, { all: values.all });
      }
      case 'restart': {
        const { values } = parse(rest, { quiet: { type: 'boolean' }, open: { type: 'boolean' } });
        return await cmdRestart(ctx, { quiet: values.quiet, open: values.open });
      }
      case 'status':
        return await cmdStatus(ctx);
      case 'logs': {
        const { values } = parse(rest, { lines: { type: 'string', short: 'n' }, follow: { type: 'boolean', short: 'f' } });
        const lines = values.lines === undefined ? undefined : Number(values.lines);
        if (lines !== undefined && (!Number.isInteger(lines) || lines < 1)) throw new UsageError('-n must be a positive number.');
        return await cmdLogs(ctx, { lines, follow: values.follow });
      }
      case 'open':
        return await cmdOpen(ctx);
      case 'doctor':
        return await cmdDoctor(ctx);
      case 'mcp': {
        const { values, positionals } = parse(rest, { kb: { type: 'string' }, name: { type: 'string' }, scope: { type: 'string' }, 'dry-run': { type: 'boolean' } });
        return await cmdMcp(ctx, positionals, { kb: values.kb, name: values.name, scope: values.scope, dryRun: values['dry-run'] });
      }
      case 'service': {
        const { positionals } = parse(rest, {});
        return await cmdService(ctx, positionals);
      }
      case 'uninstall': {
        const { values } = parse(rest, { data: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' } });
        return await cmdUninstall(ctx, { data: values.data, yes: values.yes });
      }
      default:
        ctx.err(`Unknown command "${command}".\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      ctx.err(err.message);
      return 2;
    }
    ctx.err((err as Error).message || String(err));
    return 1;
  }
}
