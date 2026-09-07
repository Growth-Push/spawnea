import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { SPAWNEA_CONTROL_API_VERSION } from '@spawnea/domain';
import type { ScopedAgentControlService } from './agent-control-service.js';

const workspaceTabSchema = z.enum(['terminal', 'files', 'diff', 'artifacts', 'details', 'agent-context']);

function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const code = normalized.includes('not found')
    ? 'not_found'
    : normalized.includes('outside the authenticated mcp scope') || normalized.includes('identity is not an active local root')
      ? 'unauthorized'
    : normalized.includes('already has an open turn') || normalized.includes('already used with a different')
      ? 'conflict'
      : normalized.includes('did not become ready') || normalized.includes('not available for prompt delivery')
        ? 'needs_human'
    : normalized.includes('cannot be empty') || normalized.includes('must be 120 characters or fewer') || normalized.includes('does not support explicit model selection')
      ? 'invalid_request'
      : 'operation_failed';
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
    structuredContent: {
      apiVersion: SPAWNEA_CONTROL_API_VERSION,
      error: { code, message },
    },
  };
}

function safeTool<T>(operation: () => Promise<T> | T) {
  return async () => {
    try {
      return toolResult(await operation());
    } catch (error) {
      return toolError(error);
    }
  };
}

export function createSpawneaMcpServer(control: ScopedAgentControlService): McpServer {
  const server = new McpServer({
    name: 'spawnea-control',
    version: '1.0.0',
  });

  server.registerTool(
    'spawnea_close_shared_child',
    {
      title: 'Close a same-project child',
      description: 'Stop and remove a direct same-project child while preserving shared files. Working or starting children require force=true. Managed worktrees use spawnea_request_finalization instead.',
      inputSchema: z.object({ sessionId: z.string().min(1).max(200), force: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ sessionId, force }) => safeTool(() => control.closeSharedChildSession(sessionId, force))()
  );

  server.registerTool(
    'spawnea_preflight_integration',
    {
      title: 'Preflight child integration',
      description: 'Check an eligible local managed child worktree before requesting human-approved integration. Returns parent commits and predicted conflicting files without merging either checkout.',
      inputSchema: z.object({ sessionId: z.string().min(1).max(200) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ sessionId }) => safeTool(() => control.preflightIntegration(sessionId))()
  );

  server.registerTool(
    'spawnea_get_state',
    {
      title: 'Get Spawnea state',
      description: 'List current sessions, hosts, projects, harnesses, worktrees, statuses, active session/tab, and recent control errors.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    safeTool(() => control.getState())
  );

  server.registerTool(
    'spawnea_inspect_worktree',
    {
      title: 'Inspect one managed worktree',
      description: 'Run a non-destructive worktree inspection for one Spawnea session.',
      inputSchema: z.object({ sessionId: z.string().min(1).max(200) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ sessionId }) => safeTool(() => control.inspectWorktree(sessionId))()
  );

  server.registerTool(
    'spawnea_rename_session',
    {
      title: 'Rename an Spawnea session',
      description: 'Update only the operator-facing display title for a known session. The task, tmux session, branch, and worktree identity are preserved.',
      inputSchema: z.object({
        sessionId: z.string().min(1).max(200),
        title: z.string().trim().min(1).max(120),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => safeTool(() => control.renameSession(input))()
  );

  server.registerTool(
    'spawnea_activate',
    {
      title: 'Activate an Spawnea session or tab',
      description: 'Select a known session and optionally open one of its workspace tabs. This does not execute host or Git commands.',
      inputSchema: z.object({
        sessionId: z.string().min(1).max(200),
        tab: workspaceTabSchema.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => safeTool(() => control.navigate(input))()
  );

  server.registerTool(
    'spawnea_request_finalization',
    {
      title: 'Request guarded worktree finalization',
      description: "Request guarded child worktree finalization. Integration and dirtyChanges='discard' always require human approval. Close with dirtyChanges='stash' may include confirmation='llm-validated' to execute through existing finalization guards. Working children require force=true. Query the returned request ID for its actual result.",
      inputSchema: z.object({
        clientRequestId: z.string().min(1).max(120),
        sessionId: z.string().min(1).max(200),
        action: z.enum(['integrate', 'close']),
        dirtyChanges: z.enum(['stash', 'discard']).optional(),
        confirmation: z.literal('llm-validated').optional(),
        force: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (input) => safeTool(() => control.requestFinalization(input))()
  );

  server.registerTool(
    'spawnea_get_finalization_request',
    {
      title: 'Get finalization request status',
      description: 'Return pending, rejected, executing, completed, or failed status and the truthful finalization result.',
      inputSchema: z.object({ requestId: z.string().uuid() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ requestId }) => safeTool(() => control.getFinalizationRequest(requestId))()
  );

  server.registerTool(
    'spawnea_create_child_session',
    {
      title: 'Create a child session',
      description: 'Create one authorized direct child on a configured host/project with an optional harness model and initial prompt. Multiline prompts are submitted through the harness-specific launch/delivery contract.',
      inputSchema: z.object({
        clientRequestId: z.string().min(1).max(120).optional(),
        parentSession: z.string().min(1).max(200),
        name: z.string().trim().min(1).max(120).optional(),
        task: z.string().trim().min(1).max(4_000),
        workspace: z.enum(['same-project', 'new-worktree']),
        agentId: z.string().min(1).max(240).optional(),
        serverId: z.string().min(1).max(200).optional(),
        projectId: z.string().min(1).max(240).optional(),
        model: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,239}$/).optional(),
        initialPrompt: z.string().min(1).max(32_000).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => safeTool(() => control.createChildSession(input))()
  );

  server.registerTool(
    'spawnea_list_sessions',
    {
      title: 'List Spawnea sessions',
      description: 'List the authenticated root and its direct children with relationship metadata (parentSessionId and childAlias).',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    safeTool(() => control.listSessions())
  );

  server.registerTool(
    'spawnea_send_prompt',
    {
      title: 'Send prompt to session',
      description: 'Submit one prompt to a direct child. Spawnea sends the text and a separate Enter automatically; do not send an Enter key or a second prompt to submit it. Reuse clientRequestId for an exact retry. Read the response with spawnea_get_turn.',
      inputSchema: z.object({
        target: z.string().min(1).max(200),
        parentSession: z.string().min(1).max(200).optional(),
        clientRequestId: z.string().min(1).max(120).optional(),
        prompt: z.string().min(1).max(32_000),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => safeTool(() => control.sendPrompt(input))()
  );

  server.registerTool(
    'spawnea_get_turn',
    {
      title: 'Read or wait for a child turn',
      description: 'Read bounded terminal output produced after a tracked prompt. Supports opaque cursors and bounded long polling; reports truncation and expired context explicitly.',
      inputSchema: z.object({
        turnId: z.string().uuid(),
        cursor: z.string().min(1).max(240).optional(),
        afterVersion: z.number().int().nonnegative().optional(),
        waitMs: z.number().int().min(0).max(30_000).optional(),
        outputMode: z.enum(['compact', 'raw']).optional(),
        maxBytes: z.number().int().min(1).max(131_072).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => safeTool(() => control.getTurn(input))()
  );

  server.registerTool(
    'spawnea_list_child_files',
    {
      title: 'List child workspace files',
      description: 'List at most 500 entries inside an authorized direct child workspace.',
      inputSchema: z.object({ sessionId: z.string().min(1).max(200), subPath: z.string().max(2_000).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ sessionId, subPath }) => safeTool(() => control.listChildFiles(sessionId, subPath))()
  );

  server.registerTool(
    'spawnea_read_child_file',
    {
      title: 'Read a child workspace file',
      description: 'Read bounded content from a file inside an authorized direct child workspace.',
      inputSchema: z.object({
        sessionId: z.string().min(1).max(200),
        path: z.string().min(1).max(2_000),
        maxBytes: z.number().int().min(1).max(131_072).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ sessionId, path, maxBytes }) => safeTool(() => control.readChildFile(sessionId, path, maxBytes))()
  );

  server.registerTool(
    'spawnea_get_child_git_status',
    {
      title: 'Inspect child Git status',
      description: 'Return Git status for an authorized direct child workspace.',
      inputSchema: z.object({ sessionId: z.string().min(1).max(200) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ sessionId }) => safeTool(() => control.getChildGitStatus(sessionId))()
  );

  server.registerTool(
    'spawnea_get_child_git_diff',
    {
      title: 'Inspect child Git diff',
      description: 'Return a bounded Git diff for an authorized direct child workspace.',
      inputSchema: z.object({
        sessionId: z.string().min(1).max(200),
        filePath: z.string().min(1).max(2_000).optional(),
        maxLines: z.number().int().min(1).max(10_000).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ sessionId, filePath, maxLines }) => safeTool(() => control.getChildGitDiff(sessionId, filePath, maxLines))()
  );

  server.registerTool(
    'spawnea_list_child_artifacts',
    {
      title: 'List child artifacts',
      description: 'List at most 200 detected artifacts for an authorized direct child session.',
      inputSchema: z.object({ sessionId: z.string().min(1).max(200) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ sessionId }) => safeTool(() => control.listChildArtifacts(sessionId))()
  );

  return server;
}
