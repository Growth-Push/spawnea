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
}

export async function createSession(client: ControlCliClient, options: CreateSessionOptions): Promise<void> {
  const result = await client.callTool('spawnea_create_session', {
    projectId: options.project,
    task: options.task,
    agentId: options.agent,
    serverId: options.server,
    baseBranch: options.branch,
    useWorktree: options.worktree ?? true,
  });

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
}

export async function createChild(client: ControlCliClient, options: CreateChildOptions): Promise<void> {
  const result = await client.callTool('spawnea_create_child_session', {
    parentSession: options.parent,
    task: options.task,
    agentId: options.agent,
    workspace: options.workspace ?? 'same-project',
    name: options.name,
    model: options.model,
    initialPrompt: options.initialPrompt,
  });

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

export interface WaitTurnOptions extends OutputOptions {
  turn: string;
  timeout?: number;
}

export async function waitTurn(client: ControlCliClient, options: WaitTurnOptions): Promise<void> {
  const timeoutSec = options.timeout ?? 120;
  const deadline = Date.now() + timeoutSec * 1000;
  let cursor: string | undefined;
  let version = 0;
  let accumulatedOutput = '';

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1000, deadline - Date.now());
    const waitMs = Math.min(remainingMs, 5000);
    const turn = await client.callTool('spawnea_get_turn', {
      turnId: options.turn,
      cursor,
      afterVersion: version,
      waitMs,
      outputMode: 'compact',
    });

    if (turn.output) {
      accumulatedOutput += turn.output;
    }

    cursor = turn.cursor ?? cursor;
    version = turn.version ?? version;

    if (turn.status === 'completed' || turn.status === 'needs_input') {
      let finalTurn = { ...turn };
      while (finalTurn.truncated && finalTurn.cursor) {
        const nextChunk = await client.callTool('spawnea_get_turn', {
          turnId: options.turn,
          cursor: finalTurn.cursor,
          waitMs: 5000,
          outputMode: 'compact',
        });
        if (nextChunk.output) {
          accumulatedOutput += nextChunk.output;
        }
        finalTurn = nextChunk;
      }
      finalTurn = { ...finalTurn, output: accumulatedOutput || finalTurn.output };
      if (options.json) {
        console.log(JSON.stringify(finalTurn, null, 2));
      } else {
        console.log(`Turn ${options.turn} ${turn.status}:`);
        console.log(finalTurn.output || '(No response text)');
      }
      return;
    }

    if (turn.status === 'failed') {
      const finalTurn = { ...turn, output: accumulatedOutput || turn.output };
      if (options.json) {
        console.log(JSON.stringify(finalTurn, null, 2));
      } else {
        console.error(`Turn ${options.turn} failed: ${finalTurn.error || finalTurn.output || 'Unknown error'}`);
      }
      process.exitCode = 1;
      return;
    }
  }

  throw new Error(`Turn ${options.turn} did not complete within ${timeoutSec} seconds.`);
}

export interface SendAndWaitOptions extends OutputOptions {
  session: string;
  prompt: string;
  timeout?: number;
}

export async function sendAndWaitPrompt(client: ControlCliClient, options: SendAndWaitOptions): Promise<void> {
  const sent = await client.callTool('spawnea_send_prompt', {
    target: options.session,
    prompt: options.prompt,
  });

  const turnId = sent.turnId;
  if (!turnId) {
    throw new Error('No turn ID returned from prompt submission');
  }

  const timeoutSec = options.timeout ?? 300;
  const deadline = Date.now() + timeoutSec * 1000;
  let cursor: string | undefined;
  let version = sent.version ?? 0;
  let accumulatedOutput = '';

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1000, deadline - Date.now());
    const waitMs = Math.min(remainingMs, 5000);
    const turn = await client.callTool('spawnea_get_turn', {
      turnId,
      cursor,
      afterVersion: version,
      waitMs,
      outputMode: 'compact',
    });

    if (turn.output) {
      accumulatedOutput += turn.output;
    }

    cursor = turn.cursor ?? cursor;
    version = turn.version ?? version;

    if (turn.status === 'completed' || turn.status === 'needs_input') {
      let finalTurn = { ...turn };
      while (finalTurn.truncated && finalTurn.cursor) {
        const nextChunk = await client.callTool('spawnea_get_turn', {
          turnId,
          cursor: finalTurn.cursor,
          waitMs: 5000,
          outputMode: 'compact',
        });
        if (nextChunk.output) {
          accumulatedOutput += nextChunk.output;
        }
        finalTurn = nextChunk;
      }
      finalTurn = { ...finalTurn, output: accumulatedOutput || finalTurn.output };
      if (options.json) {
        console.log(JSON.stringify(finalTurn, null, 2));
      } else {
        console.log(finalTurn.output || '');
      }
      return;
    }

    if (turn.status === 'failed') {
      const finalTurn = { ...turn, output: accumulatedOutput || turn.output };
      if (options.json) {
        console.log(JSON.stringify(finalTurn, null, 2));
      } else {
        console.error(`Prompt execution failed: ${finalTurn.error || finalTurn.output || 'Unknown failure'}`);
      }
      process.exitCode = 1;
      return;
    }
  }

  throw new Error(`Session ${options.session} did not complete prompt within ${timeoutSec} seconds (turn: ${turnId}).`);
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

export function showSkillPrompt(options: OutputOptions = {}): void {
  const prompt = getAgentSkillPrompt();
  if (options.json) {
    console.log(JSON.stringify({ title: 'Spawnea Agent Orchestration', prompt }, null, 2));
    return;
  }
  console.log(prompt);
}
