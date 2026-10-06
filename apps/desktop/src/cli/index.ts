import { ControlCliClient } from './client.js';
import {
  listSessions,
  getSessionStatus,
  createSession,
  createChild,
  sendPrompt,
  waitTurn,
  sendAndWaitPrompt,
  closeSession,
  showSkillPrompt,
} from './commands.js';

function printHelp(): void {
  console.log(`spawnea — Local control CLI for Spawnea agent orchestration

USAGE:
  spawnea <command> [subcommand] [options]

COMMANDS:
  list                          List active Spawnea sessions
  status <session-id>           Inspect session details and worktree status

  session create                Create a new root session
    --project <id>              Project identifier (required)
    --task "<description>"      Task description (required)
    [--agent <id>]              Agent harness (e.g. codex, local:codex)
    [--server <id>]             Target server (default: local)
    [--branch <branch>]         Base git branch
    [--no-worktree]             Do not use isolated worktree
    [--request-id <id>]         Client request ID for idempotent retries
    [--timeout <sec>]           Operation timeout in seconds (default: 120)

  session close <session-id>    Close an active session
    [--force]                   Force close even if working or starting

  child create                  Create a child sub-agent session
    --parent <id>               Parent session ID (defaults to $SPAWNEA_SESSION_ID)
    --task "<description>"      Task description (required)
    [--agent <id>]              Harness (defaults to parent harness)
    [--workspace <type>]        Workspace: same-project | new-worktree (default: same-project)
    [--name <name>]             Display title for the child
    [--request-id <id>]         Client request ID for idempotent retries
    [--timeout <sec>]           Operation timeout in seconds (default: 120)

  prompt send                   Deliver prompt to a session terminal
    --session <id>              Target session ID (required)
    "<prompt>"                  Prompt text to submit

  prompt wait                   Wait for turn output to finish
    --turn <turnId>             Turn ID returned from prompt send (required)
    [--timeout <sec>]           Max seconds to wait (default: 120)

  prompt send-and-wait          Submit prompt and wait for final response
    --session <id>              Target session ID (required)
    "<prompt>"                  Prompt text to submit
    [--timeout <sec>]           Max seconds to wait (default: 300)

  skill prompt                  Output markdown instructions for AI agents

GLOBAL OPTIONS:
  --profile <name>              Select Spawnea desktop profile
  --runtime-file <path>         Explicit path to control-runtime.json
  --json                        Format output as JSON
  -h, --help                    Show this help message
  -v, --version                 Print Spawnea CLI version
`);
}

interface ParsedArgs {
  command?: string;
  subcommand?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  'json',
  'force',
  'no-worktree',
  'help',
  'h',
  'version',
  'v',
  'sync',
  'activate',
  'uncommitted',
  'verbose',
]);

export function parseArgs(rawArgs: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--') {
      positional.push(...rawArgs.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        flags[key] = val;
      } else {
        const key = arg.slice(2);
        if (BOOLEAN_FLAGS.has(key)) {
          flags[key] = true;
        } else {
          const next = rawArgs[i + 1];
          if (next !== undefined && !next.startsWith('--')) {
            flags[key] = next;
            i++;
          } else {
            throw new Error(`Flag '--${key}' requires a value.`);
          }
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.slice(1);
      flags[key] = true;
    } else {
      positional.push(arg);
    }
  }

  return {
    command: positional[0],
    subcommand: positional[1],
    positional: positional.slice(2),
    flags,
  };
}

export async function runCli(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const isJson = Boolean(parsed.flags.json);

  if (parsed.flags.help || parsed.flags.h || (!parsed.command && argv.length === 0)) {
    printHelp();
    return;
  }

  if (parsed.flags.version || parsed.flags.v) {
    console.log('spawnea v0.1.0');
    return;
  }

  const profile = typeof parsed.flags.profile === 'string' ? parsed.flags.profile : undefined;
  const runtimeFile = typeof parsed.flags['runtime-file'] === 'string' ? parsed.flags['runtime-file'] : undefined;

  // Handle offline skill command without requiring active app
  if (parsed.command === 'skill' && (parsed.subcommand === 'prompt' || !parsed.subcommand)) {
    showSkillPrompt({ json: isJson });
    return;
  }

  let client: ControlCliClient | null = null;
  try {
    client = await ControlCliClient.connect({
      profile,
      runtimeFile,
      sessionId: process.env.SPAWNEA_SESSION_ID !== undefined ? process.env.SPAWNEA_SESSION_ID : undefined,
    });

    switch (parsed.command) {
      case 'list': {
        await listSessions(client, { json: isJson });
        break;
      }

      case 'status': {
        const sessionId = parsed.subcommand || parsed.positional[0];
        if (!sessionId) {
          throw new Error('Usage: spawnea status <session-id>');
        }
        await getSessionStatus(client, sessionId, { json: isJson });
        break;
      }

      case 'session': {
        if (parsed.subcommand === 'create') {
          const project = String(parsed.flags.project || '');
          const task = String(parsed.flags.task || '');
          if (!project) throw new Error('--project <id> is required');
          if (!task) throw new Error('--task "<description>" is required');

          const agent = typeof parsed.flags.agent === 'string' ? parsed.flags.agent : undefined;
          const server = typeof parsed.flags.server === 'string' ? parsed.flags.server : undefined;
          const branch = typeof parsed.flags.branch === 'string' ? parsed.flags.branch : undefined;
          const worktree = parsed.flags['no-worktree'] ? false : true;
          const clientRequestId = typeof parsed.flags['request-id'] === 'string'
            ? parsed.flags['request-id']
            : typeof parsed.flags['client-request-id'] === 'string'
              ? parsed.flags['client-request-id']
              : undefined;
          const timeoutMs = typeof parsed.flags.timeout === 'string'
            ? Number(parsed.flags.timeout) * 1000
            : undefined;

          await createSession(client, {
            project,
            task,
            agent,
            server,
            branch,
            worktree,
            clientRequestId,
            timeoutMs,
            json: isJson,
          });
        } else if (parsed.subcommand === 'close') {
          const sessionId = parsed.positional[0] || (typeof parsed.flags.session === 'string' ? parsed.flags.session : undefined);
          if (!sessionId) throw new Error('Usage: spawnea session close <session-id>');
          const force = Boolean(parsed.flags.force);
          await closeSession(client, sessionId, { force, json: isJson });
        } else {
          throw new Error(`Unknown session subcommand: '${parsed.subcommand}'. Expected 'create' or 'close'.`);
        }
        break;
      }

      case 'child': {
        if (parsed.subcommand === 'create') {
          let parent = typeof parsed.flags.parent === 'string' ? parsed.flags.parent : undefined;
          if (!parent && process.env.SPAWNEA_SESSION_ID) {
            const status = await client.callTool<{ session?: { id: string; parentSessionId?: string | null } }>(
              'spawnea_status',
              { sessionId: process.env.SPAWNEA_SESSION_ID }
            ).catch(() => null);
            parent = status?.session?.parentSessionId || process.env.SPAWNEA_SESSION_ID;
          }
          if (!parent) throw new Error('--parent <id> is required (or set SPAWNEA_SESSION_ID)');
          const task = String(parsed.flags.task || '');
          if (!task) throw new Error('--task "<description>" is required');

          const agent = typeof parsed.flags.agent === 'string' ? parsed.flags.agent : undefined;
          let workspace: 'same-project' | 'new-worktree' = 'same-project';
          if (parsed.flags.workspace !== undefined) {
            const rawWorkspace = String(parsed.flags.workspace);
            if (rawWorkspace !== 'same-project' && rawWorkspace !== 'new-worktree') {
              throw new Error(`Invalid --workspace: '${rawWorkspace}'. Supported values are 'same-project' and 'new-worktree'.`);
            }
            workspace = rawWorkspace;
          }
          const name = typeof parsed.flags.name === 'string' ? parsed.flags.name : undefined;
          const model = typeof parsed.flags.model === 'string' ? parsed.flags.model : undefined;
          const clientRequestId = typeof parsed.flags['request-id'] === 'string'
            ? parsed.flags['request-id']
            : typeof parsed.flags['client-request-id'] === 'string'
              ? parsed.flags['client-request-id']
              : undefined;
          const timeoutMs = typeof parsed.flags.timeout === 'string'
            ? Number(parsed.flags.timeout) * 1000
            : undefined;

          await createChild(client, {
            parent,
            task,
            agent,
            workspace,
            name,
            model,
            clientRequestId,
            timeoutMs,
            json: isJson,
          });
        } else {
          throw new Error(`Unknown child subcommand: '${parsed.subcommand}'. Expected 'create'.`);
        }
        break;
      }

      case 'prompt': {
        if (parsed.subcommand === 'send') {
          const session = String(parsed.flags.session || '');
          const prompt = parsed.positional.join(' ') || (typeof parsed.flags.prompt === 'string' ? parsed.flags.prompt : '');
          if (!session) throw new Error('--session <id> is required');
          if (!prompt) throw new Error('Prompt text is required');

          await sendPrompt(client, { session, prompt, json: isJson });
        } else if (parsed.subcommand === 'wait') {
          const turn = String(parsed.flags.turn || '');
          if (!turn) throw new Error('--turn <turnId> is required');
          const timeout = parsed.flags.timeout !== undefined ? Number(parsed.flags.timeout) : undefined;
          if (timeout !== undefined && (isNaN(timeout) || timeout <= 0)) {
            throw new Error(`Invalid timeout: '${parsed.flags.timeout}'. Expected positive number of seconds.`);
          }

          await waitTurn(client, { turn, timeout, json: isJson });
        } else if (parsed.subcommand === 'send-and-wait') {
          const session = String(parsed.flags.session || '');
          const prompt = parsed.positional.join(' ') || (typeof parsed.flags.prompt === 'string' ? parsed.flags.prompt : '');
          if (!session) throw new Error('--session <id> is required');
          if (!prompt) throw new Error('Prompt text is required');
          const timeout = parsed.flags.timeout !== undefined ? Number(parsed.flags.timeout) : undefined;
          if (timeout !== undefined && (isNaN(timeout) || timeout <= 0)) {
            throw new Error(`Invalid timeout: '${parsed.flags.timeout}'. Expected positive number of seconds.`);
          }

          await sendAndWaitPrompt(client, { session, prompt, timeout, json: isJson });
        } else {
          throw new Error(`Unknown prompt subcommand: '${parsed.subcommand}'. Expected 'send', 'wait', or 'send-and-wait'.`);
        }
        break;
      }

      default: {
        throw new Error(`Unknown command: '${parsed.command}'. Run 'spawnea --help' for available commands.`);
      }
    }
  } finally {
    client?.close();
  }
}

// Auto-run if executed directly as main module in Node.js
if (
  process.argv[1] &&
  (process.argv[1].endsWith('spawnea-cli.js') || process.argv[1].endsWith('src/cli/index.ts')) &&
  !process.argv[1].endsWith('spawnea.mjs') &&
  !process.argv.includes('--spawnea-cli')
) {
  runCli(process.argv.slice(2)).catch((err) => {
    console.error(`spawnea error: ${err.message || String(err)}`);
    process.exit(1);
  });
}
