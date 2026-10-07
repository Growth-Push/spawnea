import { getAgentSkillPrompt } from '@spawnea/domain';
import type { ControlCliClient } from './client.js';

export interface OutputOptions {
  json?: boolean;
}

export async function listSessions(client: ControlCliClient, options: OutputOptions = {}): Promise<void> {
  const result = await client.callTool('spawnea_list_sessions');
  const sessions = result.sessions || [];

  if (options.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log('No active Spawnea sessions found.');
    return;
  }

  console.log('ACTIVE SESSIONS:');
  console.log('-----------------------------------------------------------------------------------------------------');
  console.log(
    'ID'.padEnd(28) +
    'STATUS'.padEnd(12) +
    'HARNESS'.padEnd(16) +
    'PROJECT'.padEnd(18) +
    'TASK'
  );
  console.log('-----------------------------------------------------------------------------------------------------');

  for (const s of sessions) {
    const parentIndicator = s.parentSessionId ? ` ↳ ` : '';
    const idStr = `${parentIndicator}${s.id}`.padEnd(28);
    const statusStr = (s.status || 'unknown').padEnd(12);
    const harnessStr = (s.harness?.kind || s.harness?.name || '-').padEnd(16);
    const projectStr = (s.project?.name || s.project?.id || '-').padEnd(18);
    const taskStr = s.task ? (s.task.length > 50 ? `${s.task.slice(0, 47)}...` : s.task) : '-';
    console.log(`${idStr}${statusStr}${harnessStr}${projectStr}${taskStr}`);
  }
}

export async function getSessionStatus(
  client: ControlCliClient,
  sessionId: string,
  options: OutputOptions = {},
): Promise<void> {
  const result = await client.callTool('spawnea_status', { sessionId });
  const session = result.session;

  if (options.json) {
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  console.log(`Session:      ${session.id}`);
  console.log(`Name:         ${session.name || '-'}`);
  console.log(`Status:       ${session.status}`);
  console.log(`Task:         ${session.task || '-'}`);
  console.log(`Host:         ${session.host?.name || session.host?.id || '-'}`);
  console.log(`Project:      ${session.project?.name || session.project?.id || '-'}`);
  console.log(`Harness:      ${session.harness?.name || session.harness?.command || '-'}`);
  if (session.parentSessionId) {
    console.log(`Parent:       ${session.parentSessionId}`);
  }
  if (session.worktree) {
    console.log(`Worktree:     ${session.worktree.path}`);
    console.log(`Branch:       ${session.worktree.branch || '-'}`);
    console.log(`Managed:      ${session.worktree.managed ? 'yes' : 'no'}`);
  }
  console.log(`Created:      ${session.createdAt || '-'}`);
  console.log(`Last active:  ${session.lastActivityAt || '-'}`);
}

export interface CreateSessionOptions extends OutputOptions {
  project: string;
  task: string;
  agent?: string;
  server?: string;
  branch?: string;
  worktree?: boolean;
  clientRequestId?: string;
  timeoutMs?: number;
}

export async function createSession(client: ControlCliClient, options: CreateSessionOptions): Promise<void> {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`Invalid timeoutMs: '${options.timeoutMs}'. Expected positive number of milliseconds.`);
  }
  const result = await client.callTool('spawnea_create_session', {
    projectId: options.project,
    task: options.task,
    agentId: options.agent,
    serverId: options.server,
    baseBranch: options.branch,
    useWorktree: options.worktree ?? true,
    clientRequestId: options.clientRequestId,
  }, options.timeoutMs);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Created root session: ${result.sessionId || result.rootSessionId}`);
  if (result.session?.worktree?.path) {
    console.log(`Worktree path:        ${result.session.worktree.path}`);
  }
  if (result.session?.harness?.name) {
    console.log(`Harness:              ${result.session.harness.name}`);
  }
}

export interface CreateChildOptions extends OutputOptions {
  parent: string;
  task: string;
  agent?: string;
  workspace?: 'same-project' | 'new-worktree';
  name?: string;
  model?: string;
  initialPrompt?: string;
  clientRequestId?: string;
  timeoutMs?: number;
}

export async function createChild(client: ControlCliClient, options: CreateChildOptions): Promise<void> {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`Invalid timeoutMs: '${options.timeoutMs}'. Expected positive number of milliseconds.`);
  }
  const result = await client.callTool('spawnea_create_child_session', {
    parentSession: options.parent,
    task: options.task,
    agentId: options.agent,
    workspace: options.workspace ?? 'same-project',
    name: options.name,
    model: options.model,
    initialPrompt: options.initialPrompt,
    clientRequestId: options.clientRequestId,
  }, options.timeoutMs);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Created child session: ${result.sessionId}`);
  console.log(`Parent session:        ${result.parentSessionId || options.parent}`);
  if (result.childAlias) {
    console.log(`Child alias:           ${result.childAlias}`);
  }
  if (result.worktree?.path) {
    console.log(`Worktree path:         ${result.worktree.path}`);
  }
  if (result.harness?.name) {
    console.log(`Harness:               ${result.harness.name}`);
  }
}

export interface SendPromptOptions extends OutputOptions {
  session: string;
  prompt: string;
}

export async function sendPrompt(client: ControlCliClient, options: SendPromptOptions): Promise<void> {
  const result = await client.callTool('spawnea_send_prompt', {
    target: options.session,
    prompt: options.prompt,
  });

  if (result.delivered === false) {
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(
        `Prompt delivery could not be confirmed for session ${result.sessionId || options.session}: ${result.message || 'Enter key could not be confirmed'}`
      );
      if (result.turnId) console.error(`Turn ID: ${result.turnId}`);
    }
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Prompt submitted to session ${result.sessionId || options.session}`);
  console.log(`Turn ID: ${result.turnId}`);
  if (result.status) {
    console.log(`Status:  ${result.status}`);
  }
}

export interface PollTurnResult {
  turnId: string;
  status: string;
  output: string;
  error?: string;
  rawTurn: any;
}

export async function pollTurn(
  client: ControlCliClient,
  turnId: string,
  timeoutSec: number,
  initialVersion = 0,
): Promise<PollTurnResult> {
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new Error(`Invalid timeout '${timeoutSec}'. Must be a positive finite number.`);
  }

  const deadline = Date.now() + timeoutSec * 1000;
  let cursor: string | undefined;
  let version = initialVersion;
  let accumulatedOutput = '';
  let hasDelimitedResponse = false;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const waitMs = Math.round(Math.min(remainingMs, 5000));
    const rpcTimeoutMs = Math.round(Math.min(waitMs + 2000, Math.max(500, remainingMs + 500)));
    const turn = await client.callTool('spawnea_get_turn', {
      turnId,
      cursor,
      afterVersion: version,
      waitMs,
      outputMode: 'compact',
    }, rpcTimeoutMs);

    if (Date.now() >= deadline) break;

    if (turn.cursorExpired) {
      accumulatedOutput = '';
      hasDelimitedResponse = false;
    }

    if (turn.extraction === 'delimited') {
      accumulatedOutput = turn.output || '';
      hasDelimitedResponse = true;
    } else if (!hasDelimitedResponse && turn.output) {
      accumulatedOutput += turn.output;
    }

    cursor = turn.cursor ?? cursor;
    version = turn.version ?? version;

    if (turn.status === 'completed' || turn.status === 'needs_input' || turn.status === 'failed') {
      let finalTurn = { ...turn };

      while (finalTurn.truncated && finalTurn.cursor) {
        const remainingDrainMs = deadline - Date.now();
        if (remainingDrainMs <= 0) break;
        const waitMs = Math.round(Math.min(Math.max(100, remainingDrainMs), 5000));
        const rpcTimeoutMs = Math.round(Math.min(waitMs + 2000, Math.max(500, remainingDrainMs + 500)));
        const nextChunk = await client.callTool('spawnea_get_turn', {
          turnId,
          cursor: finalTurn.cursor,
          waitMs,
          outputMode: 'compact',
        }, rpcTimeoutMs);
        if (nextChunk.cursorExpired) {
          accumulatedOutput = '';
          hasDelimitedResponse = false;
        }
        if (nextChunk.extraction === 'delimited') {
          accumulatedOutput = nextChunk.output || '';
          hasDelimitedResponse = true;
        } else if (!hasDelimitedResponse && nextChunk.output) {
          accumulatedOutput += nextChunk.output;
        }
        finalTurn = nextChunk;
      }

      if (finalTurn.truncated || Date.now() >= deadline) {
        throw new Error(`Turn ${turnId} completed, but draining remaining output timed out after ${timeoutSec} seconds.`);
      }

      finalTurn = { ...finalTurn, output: accumulatedOutput || finalTurn.output || '' };
      return {
        turnId,
        status: turn.status,
        output: finalTurn.output,
        error: finalTurn.error,
        rawTurn: finalTurn,
      };
    }
  }

  throw new Error(`Turn ${turnId} did not complete within ${timeoutSec} seconds.`);
}

export interface WaitTurnOptions extends OutputOptions {
  turn: string;
  timeout?: number;
}

export async function waitTurn(client: ControlCliClient, options: WaitTurnOptions): Promise<void> {
  if (options.timeout !== undefined && (typeof options.timeout !== 'number' || isNaN(options.timeout) || options.timeout <= 0)) {
    throw new Error(`Invalid timeout: ${options.timeout}. Expected positive number of seconds.`);
  }
  const timeoutSec = options.timeout ?? 120;
  const result = await pollTurn(client, options.turn, timeoutSec);

  if (result.status === 'failed') {
    if (options.json) {
      console.log(JSON.stringify(result.rawTurn, null, 2));
    } else {
      console.error(`Turn ${options.turn} failed: ${result.error || result.output || 'Unknown error'}`);
    }
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(result.rawTurn, null, 2));
  } else {
    console.log(`Turn ${options.turn} ${result.status}:`);
    console.log(result.output || '(No response text)');
  }
}

export interface SendAndWaitOptions extends OutputOptions {
  session: string;
  prompt: string;
  timeout?: number;
}

export async function sendAndWaitPrompt(client: ControlCliClient, options: SendAndWaitOptions): Promise<void> {
  if (options.timeout !== undefined && (typeof options.timeout !== 'number' || isNaN(options.timeout) || options.timeout <= 0)) {
    throw new Error(`Invalid timeout: ${options.timeout}. Expected positive number of seconds.`);
  }
  const sent = await client.callTool('spawnea_send_prompt', {
    target: options.session,
    prompt: options.prompt,
  });

  if (sent.delivered === false) {
    if (options.json) {
      console.log(JSON.stringify(sent, null, 2));
    } else {
      console.error(
        `Prompt delivery could not be confirmed for session ${sent.sessionId || options.session}: ${sent.message || 'Enter key could not be confirmed'}`
      );
      if (sent.turnId) console.error(`Turn ID: ${sent.turnId}`);
    }
    process.exitCode = 1;
    return;
  }

  const turnId = sent.turnId;
  if (!turnId) {
    throw new Error('No turn ID returned from prompt submission');
  }

  const timeoutSec = options.timeout ?? 300;
  try {
    const result = await pollTurn(client, turnId, timeoutSec, sent.version ?? 0);

    if (result.status === 'failed') {
      if (options.json) {
        console.log(JSON.stringify(result.rawTurn, null, 2));
      } else {
        console.error(`Prompt execution failed: ${result.error || result.output || 'Unknown failure'}`);
      }
      process.exitCode = 1;
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(result.rawTurn, null, 2));
    } else {
      console.log(result.output || '');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('did not complete within')) {
      throw new Error(`Session ${options.session} did not complete prompt within ${timeoutSec} seconds (turn: ${turnId}).`);
    }
    throw err;
  }
}

export interface CloseSessionOptions extends OutputOptions {
  force?: boolean;
}

export async function closeSession(
  client: ControlCliClient,
  sessionId: string,
  options: CloseSessionOptions = {},
): Promise<void> {
  const result = await client.callTool('spawnea_close_session', {
    sessionId,
    force: options.force ?? false,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Closed session ${sessionId}.`);
}

export interface CatalogData {
  projects: Array<{
    id: string;
    name: string;
    hostId: string;
    rootPath: string;
    baseBranch?: string;
  }>;
  harnesses: Array<{
    id: string;
    name: string;
    kind: string;
    command: string;
  }>;
  hosts: Array<{
    id: string;
    name: string;
    enabled: boolean;
  }>;
}

export async function showCatalog(
  client: ControlCliClient,
  options: OutputOptions = {},
): Promise<void> {
  const result = await client.callTool<CatalogData & { apiVersion?: string }>('spawnea_catalog');
  const projects = result.projects || [];
  const harnesses = result.harnesses || [];
  const hosts = result.hosts || [];

  if (options.json) {
    console.log(JSON.stringify({
      apiVersion: result.apiVersion ?? 'v1',
      projects,
      harnesses,
      hosts,
    }, null, 2));
    return;
  }

  console.log('PROJECTS:');
  console.log('-----------------------------------------------------------------------------------------------------');
  console.log(
    'ID'.padEnd(20) +
    'NAME'.padEnd(24) +
    'HOST'.padEnd(12) +
    'BRANCH'.padEnd(16) +
    'ROOT PATH'
  );
  console.log('-----------------------------------------------------------------------------------------------------');
  if (projects.length === 0) {
    console.log('(none)');
  } else {
    for (const p of projects) {
      console.log(
        p.id.padEnd(20) +
        (p.name || '-').padEnd(24) +
        (p.hostId || 'local').padEnd(12) +
        (p.baseBranch || '-').padEnd(16) +
        (p.rootPath || '-')
      );
    }
  }

  console.log('\nHARNESSES:');
  console.log('-----------------------------------------------------------------------------------------------------');
  console.log(
    'ID'.padEnd(24) +
    'NAME'.padEnd(24) +
    'KIND'.padEnd(16) +
    'COMMAND'
  );
  console.log('-----------------------------------------------------------------------------------------------------');
  if (harnesses.length === 0) {
    console.log('(none)');
  } else {
    for (const h of harnesses) {
      console.log(
        h.id.padEnd(24) +
        (h.name || '-').padEnd(24) +
        (h.kind || '-').padEnd(16) +
        (h.command || '-')
      );
    }
  }

  console.log('\nHOSTS:');
  console.log('-----------------------------------------------------------------------------------------------------');
  console.log(
    'ID'.padEnd(20) +
    'NAME'.padEnd(28) +
    'ENABLED'
  );
  console.log('-----------------------------------------------------------------------------------------------------');
  if (hosts.length === 0) {
    console.log('(none)');
  } else {
    for (const h of hosts) {
      console.log(
        h.id.padEnd(20) +
        (h.name || '-').padEnd(28) +
        (h.enabled ? 'yes' : 'no')
      );
    }
  }
}

export function generateCompletion(shell: 'bash' | 'zsh'): void {
  if (shell === 'bash') {
    console.log(`# bash completion for spawnea
_spawnea_completions() {
  local cur prev words cword
  if declare -F _init_completion >/dev/null 2>&1; then
    _init_completion || return
  else
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    words=("\${COMP_WORDS[@]}")
    cword=$COMP_CWORD
  fi

  local commands="list status catalog session child prompt skill completion"

  case $cword in
    1)
      COMPREPLY=($(compgen -W "$commands" -- "$cur"))
      return
      ;;
  esac

  case "\${words[1]}" in
    session)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=($(compgen -W "create close" -- "$cur"))
        return
      fi
      if [[ "\${words[2]}" == "create" ]]; then
        COMPREPLY=($(compgen -W "--project --task --agent --server --branch --no-worktree --request-id --timeout --json" -- "$cur"))
        return
      elif [[ "\${words[2]}" == "close" ]]; then
        COMPREPLY=($(compgen -W "--force --json" -- "$cur"))
        return
      fi
      ;;
    child)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=($(compgen -W "create" -- "$cur"))
        return
      fi
      if [[ "\${words[2]}" == "create" ]]; then
        COMPREPLY=($(compgen -W "--parent --task --agent --workspace --name --request-id --timeout --json" -- "$cur"))
        return
      fi
      ;;
    prompt)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=($(compgen -W "send wait send-and-wait" -- "$cur"))
        return
      fi
      case "\${words[2]}" in
        send)
          COMPREPLY=($(compgen -W "--session --json" -- "$cur"))
          return
          ;;
        wait)
          COMPREPLY=($(compgen -W "--turn --timeout --json" -- "$cur"))
          return
          ;;
        send-and-wait)
          COMPREPLY=($(compgen -W "--session --timeout --json" -- "$cur"))
          return
          ;;
      esac
      ;;
    skill)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=($(compgen -W "prompt" -- "$cur"))
        return
      fi
      if [[ "\${words[2]}" == "prompt" ]]; then
        COMPREPLY=($(compgen -W "--json" -- "$cur"))
        return
      fi
      ;;
    completion)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=($(compgen -W "bash zsh" -- "$cur"))
        return
      fi
      ;;
    catalog)
      COMPREPLY=($(compgen -W "--json" -- "$cur"))
      return
      ;;
    list)
      COMPREPLY=($(compgen -W "--json --profile" -- "$cur"))
      return
      ;;
    status)
      COMPREPLY=($(compgen -W "--json" -- "$cur"))
      return
      ;;
  esac

  COMPREPLY=($(compgen -W "--help --version --json" -- "$cur"))
}

complete -F _spawnea_completions spawnea`);
    return;
  }

  if (shell === 'zsh') {
    console.log(`#compdef spawnea

_spawnea() {
  local curcontext="$curcontext" state line
  typeset -A opt_args

  local -a commands
  commands=(
    'list:List active Spawnea sessions'
    'status:Inspect session details and worktree status'
    'catalog:Get configured projects, harnesses, and hosts'
    'session:Manage Spawnea sessions'
    'child:Create and manage child sub-agent sessions'
    'prompt:Deliver prompts and wait for turns'
    'skill:Output skill prompt instructions'
    'completion:Generate shell auto-completion script'
  )

  _arguments -C \
    '(-h --help)'{-h,--help}'[Show help]' \
    '(-v --version)'{-v,--version}'[Print version]' \
    '--json[Format output as JSON]' \
    '--profile[Select Spawnea desktop profile]:profile:' \
    '--runtime-file[Explicit path to control-runtime.json]:file:_files' \
    '1: :->command' \
    '*:: :->args'

  case $state in
    command)
      _describe -t commands 'spawnea command' commands
      ;;
    args)
      case $words[1] in
        catalog)
          _arguments '--json[Format output as JSON]'
          ;;
        list)
          _arguments '--json[Format output as JSON]' '--profile[Profile]:profile:'
          ;;
        status)
          _arguments '--json[Format output as JSON]' '1:session-id:'
          ;;
        session)
          local -a subcommands
          subcommands=('create:Create a new root session' 'close:Close an active session')
          _arguments '1: :->subcmd' '*:: :->subargs'
          case $state in
            subcmd)
              _describe -t subcommands 'session subcommand' subcommands
              ;;
            subargs)
              case $words[1] in
                create)
                  _arguments \
                    '--project[Project identifier]:project:' \
                    '--task[Task description]:task:' \
                    '--agent[Agent harness]:agent:' \
                    '--server[Target server]:server:' \
                    '--branch[Base git branch]:branch:' \
                    '--no-worktree[Do not use isolated worktree]' \
                    '--request-id[Client request ID]:id:' \
                    '--timeout[Operation timeout in seconds]:sec:' \
                    '--json[Format output as JSON]'
                  ;;
                close)
                  _arguments \
                    '--force[Force close]' \
                    '--json[Format output as JSON]' \
                    '1:session-id:'
                  ;;
              esac
              ;;
          esac
          ;;
        child)
          local -a child_subcmds
          child_subcmds=('create:Create a child sub-agent session')
          _arguments '1: :->subcmd' '*:: :->subargs'
          case $state in
            subcmd)
              _describe -t child_subcmds 'child subcommand' child_subcmds
              ;;
            subargs)
              case $words[1] in
                create)
                  _arguments \
                    '--parent[Parent session ID]:parent:' \
                    '--task[Task description]:task:' \
                    '--agent[Harness]:agent:' \
                    '--workspace=[Workspace mode]:mode:(same-project new-worktree)' \
                    '--name[Display title for child]:name:' \
                    '--request-id[Client request ID]:id:' \
                    '--timeout[Operation timeout in seconds]:sec:' \
                    '--json[Format output as JSON]'
                  ;;
              esac
              ;;
          esac
          ;;
        prompt)
          local -a prompt_subcmds
          prompt_subcmds=('send:Deliver prompt to a session terminal' 'wait:Wait for turn output to finish' 'send-and-wait:Submit prompt and wait for final response')
          _arguments '1: :->subcmd' '*:: :->subargs'
          case $state in
            subcmd)
              _describe -t prompt_subcmds 'prompt subcommand' prompt_subcmds
              ;;
            subargs)
              case $words[1] in
                send)
                  _arguments '--session[Target session ID]:session:' '--json[Format output as JSON]' '1:prompt:'
                  ;;
                wait)
                  _arguments '--turn[Turn ID]:turn:' '--timeout[Timeout in seconds]:sec:' '--json[Format output as JSON]'
                  ;;
                send-and-wait)
                  _arguments '--session[Target session ID]:session:' '--timeout[Timeout in seconds]:sec:' '--json[Format output as JSON]' '1:prompt:'
                  ;;
              esac
              ;;
          esac
          ;;
        skill)
          _arguments '1:subcommand:(prompt)' '--json[Format output as JSON]'
          ;;
        completion)
          _arguments '1:shell:(bash zsh)'
          ;;
      esac
      ;;
  esac
}

if type compdef >/dev/null 2>&1; then
  compdef _spawnea spawnea
fi`);
    return;
  }
}

export interface ShowSkillPromptOptions extends OutputOptions {
  catalog?: CatalogData;
  profile?: string;
}

export function showSkillPrompt(options: ShowSkillPromptOptions = {}): void {
  const catalogContext = options.catalog
    ? { ...options.catalog, profile: options.profile ?? (options.catalog as any).profile }
    : (options.profile ? { profile: options.profile } : undefined);
  const prompt = getAgentSkillPrompt(catalogContext);
  if (options.json) {
    console.log(JSON.stringify({ title: 'Spawnea Agent Orchestration', prompt }, null, 2));
    return;
  }
  console.log(prompt);
}
