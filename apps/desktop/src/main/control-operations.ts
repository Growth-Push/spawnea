import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { MODEL_ID_PATTERN, SPAWNEA_CONTROL_API_VERSION } from '@spawnea/domain';
import type {
  AgentControlService,
  ScopedAgentControlService,
} from './agent-control-service.js';

const workspaceTabSchema = z.enum(['terminal', 'files', 'diff', 'artifacts', 'details', 'agent-context']);

export type ControlErrorCode =
  | 'not_found'
  | 'unauthorized'
  | 'conflict'
  | 'needs_human'
  | 'invalid_request'
  | 'operation_failed';

export type ControlOperationResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: ControlErrorCode; message: string } };

export interface ControlOperation {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  run(input: any): Promise<unknown> | unknown;
}

export function classifyControlError(error: unknown): { code: ControlErrorCode; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const code: ControlErrorCode = normalized.includes('not found')
    ? 'not_found'
    : normalized.includes('outside the authenticated control scope') || normalized.includes('identity is not an active local root')
      ? 'unauthorized'
      : normalized.includes('already has an open turn') || normalized.includes('already used with a different') || normalized.includes('already bound')
        ? 'conflict'
        : normalized.includes('did not become ready') || normalized.includes('not available for prompt delivery')
          ? 'needs_human'
          : normalized.includes('cannot be empty') || normalized.includes('must be 120 characters or fewer') || normalized.includes('does not support explicit model selection')
            ? 'invalid_request'
            : 'operation_failed';
  return { code, message };
}

/** A fixed set of named control operations with schema validation and typed errors. */
export class ControlOperations {
  private readonly byName = new Map<string, ControlOperation>();

  constructor(operations: readonly ControlOperation[]) {
    for (const operation of operations) {
      if (this.byName.has(operation.name)) throw new Error(`Duplicate control operation: ${operation.name}`);
      this.byName.set(operation.name, operation);
    }
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  async call(name: string, rawArguments: unknown): Promise<ControlOperationResult> {
    const operation = this.byName.get(name);
    if (!operation) {
      return { ok: false, error: { code: 'invalid_request', message: `Unknown control operation '${name}'` } };
    }
    const parsed = operation.inputSchema.safeParse(rawArguments ?? {});
    if (!parsed.success) {
      return { ok: false, error: { code: 'invalid_request', message: z.prettifyError(parsed.error) } };
    }
    try {
      return { ok: true, value: await operation.run(parsed.data) };
    } catch (error) {
      return { ok: false, error: classifyControlError(error) };
    }
  }
}

export function controlErrorEnvelope(error: { code: ControlErrorCode; message: string }) {
  return { apiVersion: SPAWNEA_CONTROL_API_VERSION, error };
}

function op<S extends z.ZodType>(
  name: string,
  description: string,
  inputSchema: S,
  run: (input: z.infer<S>) => Promise<unknown> | unknown,
): ControlOperation {
  return { name, description, inputSchema, run };
}

const sessionIdSchema = z.string().min(1).max(200);

/** Operations available only inside a session-scoped connection (root and its direct children). */
function scopedOperations(control: ScopedAgentControlService): ControlOperation[] {
  return [
    op(
      'spawnea_close_shared_child',
      'Stop and remove a direct same-project child while preserving shared files. Working or starting children require force=true.',
      z.object({ sessionId: sessionIdSchema, force: z.boolean().optional() }),
      ({ sessionId, force }) => control.closeSharedChildSession(sessionId, force),
    ),
    op(
      'spawnea_preflight_integration',
      'Check an eligible local managed child worktree before requesting human-approved integration.',
      z.object({ sessionId: sessionIdSchema }),
      ({ sessionId }) => control.preflightIntegration(sessionId),
    ),
    op(
      'spawnea_inspect_worktree',
      'Run a non-destructive worktree inspection for one Spawnea session.',
      z.object({ sessionId: sessionIdSchema }),
      ({ sessionId }) => control.inspectWorktree(sessionId),
    ),
    op(
      'spawnea_rename_session',
      'Update only the operator-facing display title for a known session.',
      z.object({ sessionId: sessionIdSchema, title: z.string().trim().min(1).max(120) }),
      (input) => control.renameSession(input),
    ),
    op(
      'spawnea_activate',
      'Select a known session and optionally open one of its workspace tabs.',
      z.object({ sessionId: sessionIdSchema, tab: workspaceTabSchema.optional() }),
      (input) => control.navigate(input),
    ),
    op(
      'spawnea_request_finalization',
      "Request guarded child worktree finalization. Integration and dirtyChanges='discard' always require human approval.",
      z.object({
        clientRequestId: z.string().min(1).max(120),
        sessionId: sessionIdSchema,
        action: z.enum(['integrate', 'close']),
        dirtyChanges: z.enum(['stash', 'discard']).optional(),
        confirmation: z.literal('llm-validated').optional(),
        force: z.boolean().optional(),
      }),
      (input) => control.requestFinalization(input),
    ),
    op(
      'spawnea_get_finalization_request',
      'Return the status and truthful result of a finalization request.',
      z.object({ requestId: z.string().uuid() }),
      ({ requestId }) => control.getFinalizationRequest(requestId),
    ),
    op(
      'spawnea_list_child_files',
      'List at most 500 entries inside an authorized direct child workspace.',
      z.object({ sessionId: sessionIdSchema, subPath: z.string().max(2_000).optional() }),
      ({ sessionId, subPath }) => control.listChildFiles(sessionId, subPath),
    ),
    op(
      'spawnea_read_child_file',
      'Read bounded content from a file inside an authorized direct child workspace.',
      z.object({
        sessionId: sessionIdSchema,
        path: z.string().min(1).max(2_000),
        maxBytes: z.number().int().min(1).max(131_072).optional(),
      }),
      ({ sessionId, path, maxBytes }) => control.readChildFile(sessionId, path, maxBytes),
    ),
    op(
      'spawnea_get_child_git_status',
      'Return Git status for an authorized direct child workspace.',
      z.object({ sessionId: sessionIdSchema }),
      ({ sessionId }) => control.getChildGitStatus(sessionId),
    ),
    op(
      'spawnea_get_child_git_diff',
      'Return a bounded Git diff for an authorized direct child workspace.',
      z.object({
        sessionId: sessionIdSchema,
        filePath: z.string().min(1).max(2_000).optional(),
        maxLines: z.number().int().min(1).max(10_000).optional(),
      }),
      ({ sessionId, filePath, maxLines }) => control.getChildGitDiff(sessionId, filePath, maxLines),
    ),
    op(
      'spawnea_list_child_artifacts',
      'List at most 200 detected artifacts for an authorized direct child session.',
      z.object({ sessionId: sessionIdSchema }),
      ({ sessionId }) => control.listChildArtifacts(sessionId),
    ),
  ];
}

export interface CreateControlOperationsOptions {
  /** True when the connection is bound to an existing session and may only act on it and its children. */
  isScoped?: boolean;
}

export function createControlOperations(
  control: AgentControlService | ScopedAgentControlService,
  options: CreateControlOperationsOptions = {},
): ControlOperations {
  const isScoped = options.isScoped ?? !('createRootSession' in control);

  const operations: ControlOperation[] = [
    op(
      'spawnea_list_sessions',
      'List all active sessions and their status.',
      z.object({}),
      async () => {
        if (isScoped && 'listSessions' in control) return control.listSessions();
        const state = await control.getState();
        return { apiVersion: state.apiVersion, sessions: state.sessions };
      },
    ),
    op(
      'spawnea_catalog',
      'Get configured projects, harnesses, and hosts in Spawnea.',
      z.object({}),
      async () => {
        const state = await control.getState();
        return {
          apiVersion: state.apiVersion,
          projects: (state.projects ?? []).map((p) => ({
            id: p.id,
            name: p.name,
            hostId: p.hostId,
            rootPath: p.rootPath,
            baseBranch: p.baseBranch,
          })),
          harnesses: (state.availableHarnesses ?? state.harnesses ?? []).map((h) => ({
            id: h.id,
            name: h.name,
            kind: h.kind,
            command: h.command,
          })),
          hosts: (state.hosts ?? []).map((h) => ({
            id: h.id,
            name: h.name,
            enabled: h.enabled,
          })),
        };
      },
    ),
    op(
      'spawnea_status',
      'Get detailed session information including worktree, requested model choice, and status.',
      z.object({ sessionId: sessionIdSchema }),
      async ({ sessionId }) => {
        const state = await control.getState();
        let session = state.sessions.find((s) => s.id === sessionId);
        if (!session) {
          const matches = state.sessions.filter(
            (s) => s.id.startsWith(sessionId) || s.name.toLowerCase() === sessionId.toLowerCase(),
          );
          if (matches.length > 1) {
            throw new Error(`Ambiguous session identifier '${sessionId}': matches ${matches.map((m) => m.id).join(', ')}`);
          }
          session = matches[0];
        }
        if (!session) {
          throw new Error(`Session '${sessionId}' not found`);
        }
        return { apiVersion: state.apiVersion, session };
      },
    ),
    op(
      'spawnea_create_session',
      'Create one independent root Spawnea session.',
      z.object({
        projectId: z.string().min(1).max(200),
        task: z.string().trim().min(1).max(10_000),
        agentId: z.string().min(1).max(200).optional(),
        serverId: z.string().min(1).max(200).optional(),
        baseBranch: z.string().trim().min(1).max(240).optional(),
        useWorktree: z.boolean().optional(),
        worktreePath: z.string().trim().min(1).optional(),
        clientRequestId: z.string().min(1).max(120).optional(),
        model: z.string().regex(MODEL_ID_PATTERN).optional(),
      }),
      async (request) => {
        if (isScoped || !('createRootSession' in control)) {
          throw new Error('Creating root sessions is not permitted from a scoped session context');
        }
        const state = await control.getState();
        const selectedProject = state.projects?.find((p) => p.id === request.projectId);
        const serverId = request.serverId ?? selectedProject?.hostId ?? state.hosts[0]?.id ?? 'local';
        const isAvailable = (h: { id: string }) => {
          if ('isHarnessAvailableForHost' in control && typeof (control as any).isHarnessAvailableForHost === 'function') {
            return (control as any).isHarnessAvailableForHost(h.id, serverId);
          }
          return !h.id.includes(':') || h.id.startsWith(`${serverId}:`);
        };
        const availableHarnesses = state.harnesses.filter((h) => {
          if (h.id.includes(':') && !h.id.startsWith(`${serverId}:`)) return false;
          return isAvailable(h);
        });
        let resolvedAgentId = request.agentId;
        if (resolvedAgentId && !availableHarnesses.some((h) => h.id === resolvedAgentId)) {
          const match = availableHarnesses.find(
            (h) => h.name.toLowerCase() === resolvedAgentId?.toLowerCase() ||
                   (h.harness && h.harness.toLowerCase() === resolvedAgentId?.toLowerCase()) ||
                   (h.kind && h.kind.toLowerCase() === resolvedAgentId?.toLowerCase()) ||
                   h.id.endsWith(`:${resolvedAgentId}`),
          );
          if (match) resolvedAgentId = match.id;
        }
        if (!resolvedAgentId) {
          const defaultHarness = availableHarnesses.find((h) => h.kind !== 'shell') ?? availableHarnesses[0];
          if (!defaultHarness) {
            throw new Error(`No harness available on server '${serverId}'`);
          }
          resolvedAgentId = defaultHarness.id;
        }

        return control.createRootSession({
          clientRequestId: request.clientRequestId ?? randomUUID(),
          serverId,
          projectId: request.projectId,
          agentId: resolvedAgentId,
          task: request.task,
          baseBranch: request.baseBranch,
          useWorktree: request.worktreePath ? false : (request.useWorktree ?? true),
          worktreePath: request.worktreePath,
          model: request.model,
        }, { allowRemoteHost: true });
      },
    ),
    op(
      'spawnea_create_child_session',
      'Create a child session under a parent session.',
      z.object({
        parentSession: z.string().min(1).max(200),
        task: z.string().trim().min(1).max(4_000),
        name: z.string().trim().min(1).max(120).optional(),
        workspace: z.enum(['same-project', 'new-worktree']).optional(),
        agentId: z.string().min(1).max(240).optional(),
        serverId: z.string().min(1).max(200).optional(),
        projectId: z.string().min(1).max(240).optional(),
        model: z.string().trim().regex(MODEL_ID_PATTERN).optional(),
        initialPrompt: z.string().min(1).max(32_000).optional(),
        clientRequestId: z.string().min(1).max(120).optional(),
        baseBranch: z.string().trim().min(1).max(240).optional(),
      }).refine((input) => input.baseBranch === undefined || input.workspace === 'new-worktree', {
        message: "baseBranch is only valid with workspace 'new-worktree'",
        path: ['baseBranch'],
      }),
      async (input) => {
        let agentId = input.agentId;
        if (agentId) {
          const state = await control.getState();
          const parent = state.sessions.find((s) => s.id === input.parentSession);
          const serverId = input.serverId ?? parent?.host?.id ?? 'local';
          const availableHarnesses = state.harnesses.filter((h) => !h.id.includes(':') || h.id.startsWith(`${serverId}:`));
          const match = availableHarnesses.find(
            (h) => h.id === agentId ||
                   h.name?.toLowerCase() === agentId?.toLowerCase() ||
                   h.harness?.toLowerCase() === agentId?.toLowerCase() ||
                   h.kind?.toLowerCase() === agentId?.toLowerCase() ||
                   h.id.endsWith(`:${agentId}`),
          );
          if (match) agentId = match.id;
        }
        return control.createChildSession({
          ...input,
          workspace: input.workspace ?? 'same-project',
          agentId,
        });
      },
    ),
    op(
      'spawnea_send_prompt',
      'Submit prompt text to a session or child terminal.',
      z.object({
        target: z.string().min(1).max(200),
        prompt: z.string().min(1).max(32_000),
        clientRequestId: z.string().min(1).max(120).optional(),
        parentSession: z.string().min(1).max(200).optional(),
      }),
      (input) => control.sendPrompt(input),
    ),
    op(
      'spawnea_get_turn',
      'Read terminal output produced after a prompt.',
      z.object({
        turnId: z.string().uuid(),
        cursor: z.string().min(1).max(240).optional(),
        afterVersion: z.number().int().nonnegative().optional(),
        waitMs: z.number().int().min(0).max(30_000).optional(),
        outputMode: z.enum(['compact', 'raw']).optional(),
        maxBytes: z.number().int().min(1).max(131_072).optional(),
      }),
      (input) => control.getTurn(input),
    ),
    op(
      'spawnea_close_session',
      'Close an active session or child.',
      z.object({ sessionId: sessionIdSchema, force: z.boolean().optional() }),
      async ({ sessionId, force }) => {
        if (isScoped) {
          return control.closeChildSession(sessionId, force);
        }
        if ('closeSession' in control) {
          return control.closeSession(sessionId, force);
        }
        return control.closeChildSession(sessionId, force);
      },
    ),
    op(
      'spawnea_get_state',
      'Get full Spawnea state including sessions, hosts, projects, harnesses.',
      z.object({}),
      () => control.getState(),
    ),
  ];

  if (isScoped) {
    operations.push(...scopedOperations(control as ScopedAgentControlService));
  }

  return new ControlOperations(operations);
}
