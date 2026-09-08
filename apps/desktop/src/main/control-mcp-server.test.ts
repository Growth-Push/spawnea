import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createBootstrapSpawneaMcpServer, createSpawneaMcpServer } from './control-mcp-server.js';
import type {
  AgentControlService,
  BootstrapAgentControlService,
  ScopedAgentControlService,
} from './agent-control-service.js';
import type { ControlListSessionsResult, ControlSendPromptResult } from '@spawnea/domain';

describe('Spawnea MCP v1 contract', () => {
  const connected: Array<{ client: Client; server: ReturnType<typeof createSpawneaMcpServer> }> = [];

  async function connect(control: Partial<AgentControlService>) {
    const server = createSpawneaMcpServer(control as AgentControlService);
    const client = new Client({ name: 'spawnea-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    connected.push({ client, server });
    return client;
  }

  async function connectBootstrap(
    bootstrap: BootstrapAgentControlService,
    bindRoot: (rootSessionId: string) => Promise<ScopedAgentControlService>,
  ) {
    const server = createBootstrapSpawneaMcpServer(bootstrap, bindRoot);
    const client = new Client({ name: 'spawnea-bootstrap-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    connected.push({ client, server });
    return client;
  }

  afterEach(async () => {
    await Promise.allSettled(connected.splice(0).flatMap(({ client, server }) => [client.close(), server.close()]));
  });

  it('exposes bounded integration preflight results', async () => {
    const preflightIntegration = vi.fn().mockResolvedValue({ apiVersion: 'v1', sessionId: 'child', conflictingFiles: ['shared.txt'], parentCommits: [], truncated: false });
    const client = await connect({ preflightIntegration });
    const result = await client.callTool({ name: 'spawnea_preflight_integration', arguments: { sessionId: 'child' } });
    expect(result.structuredContent).toMatchObject({ conflictingFiles: ['shared.txt'] });
    expect(preflightIntegration).toHaveBeenCalledWith('child');
  });

  it('exposes the shared-child close without a workspace deletion policy', async () => {
    const closeSharedChildSession = vi.fn().mockResolvedValue({ apiVersion: 'v1', sessionId: 'child', removed: true, workspacePreserved: true });
    const client = await connect({ closeSharedChildSession });
    const result = await client.callTool({ name: 'spawnea_close_shared_child', arguments: { sessionId: 'child', force: true } });
    expect(result.structuredContent).toMatchObject({ workspacePreserved: true });
    expect(closeSharedChildSession).toHaveBeenCalledWith('child', true);
  });

  it('publishes exactly the documented canonical tools without legacy aliases', async () => {
    const client = await connect({});
    const result = await client.listTools();
    const toolNames = result.tools.map((tool) => tool.name);
    expect(toolNames).toEqual([
      'spawnea_close_shared_child',
      'spawnea_preflight_integration',
      'spawnea_get_state',
      'spawnea_inspect_worktree',
      'spawnea_rename_session',
      'spawnea_activate',
      'spawnea_request_finalization',
      'spawnea_get_finalization_request',
      'spawnea_create_child_session',
      'spawnea_list_sessions',
      'spawnea_send_prompt',
      'spawnea_get_turn',
      'spawnea_list_child_files',
      'spawnea_read_child_file',
      'spawnea_get_child_git_status',
      'spawnea_get_child_git_diff',
      'spawnea_list_child_artifacts',
    ]);
    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(toolNames.every((name) => name.startsWith('spawnea_'))).toBe(true);
  });

  it('exposes a minimal bootstrap surface, creates one root, and binds the connection', async () => {
    const bootstrapState = {
      apiVersion: 'v1' as const,
      mode: 'bootstrap' as const,
      hosts: [{ id: 'local', name: 'Local' }],
      projects: [{ id: 'project', name: 'Project', hostId: 'local' }],
      harnesses: [{ id: 'codex', name: 'Codex' }],
    };
    const scopedState = { apiVersion: 'v1' as const, sessions: [{ id: 'root-1' }] };
    const request = {
      clientRequestId: 'create-root-1',
      serverId: 'local',
      projectId: 'project',
      agentId: 'codex',
      task: 'Root task',
    };
    const createSession = vi.fn().mockResolvedValue({
      apiVersion: 'v1', sessionCreated: true, rootSessionId: 'root-1', sessionId: 'root-1',
      session: { id: 'root-1' }, replayed: false,
    });
    const bootstrap = { getState: vi.fn().mockResolvedValue(bootstrapState), createSession } as BootstrapAgentControlService;
    const scoped = { getState: vi.fn().mockResolvedValue(scopedState) } as unknown as ScopedAgentControlService;
    const bindRoot = vi.fn().mockResolvedValue(scoped);
    const client = await connectBootstrap(bootstrap, bindRoot);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'spawnea_get_state', 'spawnea_create_session',
    ]);
    await expect(client.callTool({ name: 'spawnea_get_state', arguments: {} }))
      .resolves.toMatchObject({ structuredContent: bootstrapState });

    const created = await client.callTool({ name: 'spawnea_create_session', arguments: request });
    expect(created.structuredContent).toMatchObject({ rootSessionId: 'root-1', replayed: false });
    expect(bindRoot).toHaveBeenCalledWith('root-1');
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('spawnea_send_prompt');
    await expect(client.callTool({ name: 'spawnea_get_state', arguments: {} }))
      .resolves.toMatchObject({ structuredContent: scopedState });

    const replay = await client.callTool({ name: 'spawnea_create_session', arguments: request });
    expect(replay.structuredContent).toMatchObject({ rootSessionId: 'root-1', replayed: true });
    expect(createSession).toHaveBeenCalledOnce();
    const rejected = await client.callTool({
      name: 'spawnea_create_session', arguments: { ...request, clientRequestId: 'create-root-2', task: 'Other root' },
    });
    expect(rejected).toMatchObject({ isError: true, structuredContent: { error: { code: 'conflict' } } });
    expect(createSession).toHaveBeenCalledOnce();
  });

  it('keeps a created root locked to the connection when the first bind attempt fails', async () => {
    const request = {
      clientRequestId: 'create-root-1', serverId: 'local', projectId: 'project', agentId: 'codex', task: 'Root task',
    };
    const result = {
      apiVersion: 'v1' as const, sessionCreated: true as const, rootSessionId: 'root-1', sessionId: 'root-1',
      session: { id: 'root-1' }, replayed: false,
    };
    const createSession = vi.fn().mockResolvedValue(result);
    const bootstrap = {
      getState: vi.fn().mockResolvedValue({ apiVersion: 'v1', mode: 'bootstrap', hosts: [], projects: [], harnesses: [] }),
      createSession,
    } as unknown as BootstrapAgentControlService;
    const scoped = { getState: vi.fn() } as unknown as ScopedAgentControlService;
    const bindRoot = vi.fn()
      .mockRejectedValueOnce(new Error('Root scope was not ready'))
      .mockResolvedValue(scoped);
    const client = await connectBootstrap(bootstrap, bindRoot);

    await expect(client.callTool({ name: 'spawnea_create_session', arguments: request }))
      .resolves.toMatchObject({ isError: true });
    const unrelated = await client.callTool({
      name: 'spawnea_create_session', arguments: { ...request, clientRequestId: 'create-root-2', task: 'Other root' },
    });
    expect(unrelated).toMatchObject({ isError: true, structuredContent: { error: { code: 'conflict' } } });

    const replay = await client.callTool({ name: 'spawnea_create_session', arguments: request });
    expect(replay.structuredContent).toMatchObject({ rootSessionId: 'root-1', replayed: true });
    expect(createSession).toHaveBeenCalledOnce();
    expect(bindRoot).toHaveBeenCalledTimes(2);
  });

  it('preserves a service-level replay marker on a replacement bootstrap connection', async () => {
    const request = {
      clientRequestId: 'create-root-1', serverId: 'local', projectId: 'project', agentId: 'codex', task: 'Root task',
    };
    const createSession = vi.fn().mockResolvedValue({
      apiVersion: 'v1', sessionCreated: true, rootSessionId: 'root-1', sessionId: 'root-1',
      session: { id: 'root-1' }, replayed: true,
    });
    const bootstrap = {
      getState: vi.fn(), createSession,
    } as unknown as BootstrapAgentControlService;
    const scoped = { getState: vi.fn() } as unknown as ScopedAgentControlService;
    const client = await connectBootstrap(bootstrap, vi.fn().mockResolvedValue(scoped));

    const replay = await client.callTool({ name: 'spawnea_create_session', arguments: request });
    expect(replay.structuredContent).toMatchObject({ rootSessionId: 'root-1', replayed: true });
  });

  it('preserves the creation error for concurrent exact retries and allows a later retry', async () => {
    const request = {
      clientRequestId: 'create-root-1', serverId: 'local', projectId: 'project', agentId: 'codex', task: 'Root task',
    };
    const result = {
      apiVersion: 'v1' as const, sessionCreated: true as const, rootSessionId: 'root-1', sessionId: 'root-1',
      session: { id: 'root-1' }, replayed: false,
    };
    let rejectCreation!: (error: Error) => void;
    const createSession = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectCreation = reject; }))
      .mockResolvedValueOnce(result);
    const bootstrap = {
      getState: vi.fn().mockResolvedValue({ apiVersion: 'v1', mode: 'bootstrap', hosts: [], projects: [], harnesses: [] }),
      createSession,
    } as unknown as BootstrapAgentControlService;
    const scoped = { getState: vi.fn() } as unknown as ScopedAgentControlService;
    const bindRoot = vi.fn().mockResolvedValue(scoped);
    const client = await connectBootstrap(bootstrap, bindRoot);

    const first = client.callTool({ name: 'spawnea_create_session', arguments: request });
    const concurrentRetry = client.callTool({ name: 'spawnea_create_session', arguments: request });
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledOnce());
    rejectCreation(new Error('Root creation failed'));

    const failures = await Promise.all([first, concurrentRetry]);
    expect(failures).toEqual([
      expect.objectContaining({ isError: true, structuredContent: { apiVersion: 'v1', error: { code: 'operation_failed', message: 'Root creation failed' } } }),
      expect.objectContaining({ isError: true, structuredContent: { apiVersion: 'v1', error: { code: 'operation_failed', message: 'Root creation failed' } } }),
    ]);
    expect(bindRoot).not.toHaveBeenCalled();

    const retry = await client.callTool({ name: 'spawnea_create_session', arguments: request });
    expect(retry.structuredContent).toMatchObject({ rootSessionId: 'root-1', replayed: false });
    expect(createSession).toHaveBeenCalledTimes(2);
  });


  it('renames a session and returns the updated session view', async () => {
    const renameSession = vi.fn().mockResolvedValue({
      apiVersion: 'v1',
      deliveredToRenderer: true,
      session: {
        id: 'session-1',
        name: 'Focused title',
        task: 'Original task',
        tmuxSessionName: 'spawnea-original-task',
        worktree: {
          managed: true,
          path: '/repo/worktrees/original-task',
          branch: 'spawnea/original-task',
          baseBranch: 'main',
        },
      },
    });
    const client = await connect({ renameSession } as Partial<AgentControlService>);

    const result = await client.callTool({
      name: 'spawnea_rename_session',
      arguments: { sessionId: 'session-1', title: '  Focused title  ' },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      apiVersion: 'v1',
      deliveredToRenderer: true,
      session: {
        id: 'session-1',
        name: 'Focused title',
        task: 'Original task',
        tmuxSessionName: 'spawnea-original-task',
      },
    });
    expect(renameSession).toHaveBeenCalledWith({ sessionId: 'session-1', title: 'Focused title' });
  });

  it('rejects blank and oversized titles at the MCP schema boundary', async () => {
    const renameSession = vi.fn();
    const client = await connect({ renameSession } as Partial<AgentControlService>);

    for (const title of ['   ', 'x'.repeat(121)]) {
      const result = await client.callTool({
        name: 'spawnea_rename_session',
        arguments: { sessionId: 'session-1', title },
      });
      expect(result.isError).toBe(true);
    }
    expect(renameSession).not.toHaveBeenCalled();
  });

  it('returns a typed not-found error when rename fails', async () => {
    const renameSession = vi.fn().mockRejectedValue(new Error("Session 'missing' not found"));
    const client = await connect({ renameSession } as Partial<AgentControlService>);

    const result = await client.callTool({
      name: 'spawnea_rename_session',
      arguments: { sessionId: 'missing', title: 'Title' },
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        apiVersion: 'v1',
        error: { code: 'not_found', message: "Session 'missing' not found" },
      },
    });
  });

  it('does not expose unsupported batch creation', async () => {
    const createSessions = vi.fn();
    const client = await connect({ createSessions } as Partial<AgentControlService>);

    await expect(client.callTool({
      name: 'spawnea_create_sessions',
      arguments: { correlationId: 'batch', sessions: [] },
    })).rejects.toThrow();
    expect(createSessions).not.toHaveBeenCalled();
  });

  it('turns finalization into a pending request and reports its status', async () => {
    const pending = {
      id: '3d47ca17-70c0-43ac-96e9-464ddc1f28a4',
      clientRequestId: 'request-1',
      sessionId: 'session-1',
      sessionName: 'Session 1',
      branch: 'spawnea/task',
      baseBranch: 'main',
      worktreePath: '/repo/worktrees/task',
      action: 'close' as const,
      dirtyChanges: 'stash' as const,
      mode: 'ui-confirmation' as const,
      status: 'pending' as const,
      createdAt: '2026-08-27T10:00:00.000Z',
    };
    const requestFinalization = vi.fn().mockResolvedValue(pending);
    const getFinalizationRequest = vi.fn().mockReturnValue(pending);
    const client = await connect({ requestFinalization, getFinalizationRequest } as Partial<AgentControlService>);

    const requested = await client.callTool({
      name: 'spawnea_request_finalization',
      arguments: {
        clientRequestId: 'request-1', sessionId: 'session-1', action: 'close', dirtyChanges: 'stash',
      },
    });
    expect(requested.structuredContent).toMatchObject({ status: 'pending' });
    expect(requestFinalization).toHaveBeenCalledOnce();

    const observed = await client.callTool({
      name: 'spawnea_get_finalization_request', arguments: { requestId: pending.id },
    });
    expect(observed.structuredContent).toMatchObject({ id: pending.id, status: 'pending' });
  });

  it('exposes the explicit LLM validation signal for a direct MCP close', async () => {
    const completed = {
      id: '3d47ca17-70c0-43ac-96e9-464ddc1f28a4',
      clientRequestId: 'validated-close-1',
      sessionId: 'session-1',
      sessionName: 'Session 1',
      branch: 'spawnea/task',
      baseBranch: 'main',
      worktreePath: '/repo/worktrees/task',
      action: 'close' as const,
      dirtyChanges: 'discard' as const,
      mode: 'mcp-validated' as const,
      status: 'completed' as const,
      createdAt: '2026-08-27T10:00:00.000Z',
      resolvedAt: '2026-08-27T10:00:01.000Z',
      result: { action: 'close' as const, removed: true },
    };
    const requestFinalization = vi.fn().mockResolvedValue(completed);
    const client = await connect({ requestFinalization } as Partial<AgentControlService>);

    const result = await client.callTool({
      name: 'spawnea_request_finalization',
      arguments: {
        clientRequestId: 'validated-close-1',
        sessionId: 'session-1',
        action: 'close',
        dirtyChanges: 'discard',
        confirmation: 'llm-validated',
      },
    });

    expect(result.structuredContent).toMatchObject({
      mode: 'mcp-validated',
      status: 'completed',
      result: { action: 'close', removed: true },
    });
    expect(requestFinalization).toHaveBeenCalledWith(expect.objectContaining({
      action: 'close',
      confirmation: 'llm-validated',
    }));
  });

  it('handles spawnea_create_child_session tool call', async () => {
    const childResult = {
      apiVersion: 'v1' as const,
      parentSessionId: 'parent-1',
      childAlias: 'child-1',
      sessionId: 'session-child-1',
      childSessionId: 'session-child-1',
      name: 'Child task',
      displayName: 'Child task',
      workspace: 'same-project' as const,
      workspaceMode: 'same-project' as const,
      status: 'starting' as const,
      initialStatus: 'starting' as const,
    };
    const createChildSession = vi.fn().mockResolvedValue(childResult);
    const client = await connect({ createChildSession } as Partial<AgentControlService>);

    const result = await client.callTool({
      name: 'spawnea_create_child_session',
      arguments: {
        parentSession: 'parent-1',
        task: 'Child task',
        workspace: 'same-project',
      },
    });

    expect(result.structuredContent).toMatchObject({
      sessionId: 'session-child-1',
      parentSessionId: 'parent-1',
      childAlias: 'child-1',
    });
    expect(createChildSession).toHaveBeenCalledWith({
      parentSession: 'parent-1',
      task: 'Child task',
      workspace: 'same-project',
    });
  });

  it('handles spawnea_list_sessions tool call', async () => {
    const listResult: ControlListSessionsResult = {
      apiVersion: 'v1' as const,
      sessions: [
        {
          id: 'parent-1',
          name: 'Parent',
          task: 'Parent task',
          tmuxSessionName: 'spawnea-parent-1',
          status: 'working' as const,
          host: { id: 'srv-1', name: 'Dev Server' },
          project: { id: 'proj-1', name: 'Spawnea' },
          harness: { id: 'agent-1', name: 'Claude', command: 'claude' },
          creationSource: 'ui',
          worktree: { managed: false, path: '/repo', branch: 'main', baseBranch: 'main' },
          active: false,
          createdAt: '2026-09-03T00:00:00.000Z',
          lastActivityAt: '2026-09-03T00:00:00.000Z',
        },
      ],
    };
    const listSessions = vi.fn().mockResolvedValue(listResult);
    const client = await connect({ listSessions } as Partial<AgentControlService>);

    const result = await client.callTool({
      name: 'spawnea_list_sessions',
      arguments: {},
    });

    const response = result.structuredContent as ControlListSessionsResult;
    expect(response.apiVersion).toBe('v1');
    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0]?.id).toBe('parent-1');
    expect(response.sessions[0]?.harness.command).toBe('claude');
  });

  it('handles spawnea_send_prompt tool call', async () => {
    const sendResult: ControlSendPromptResult = {
      apiVersion: 'v1' as const,
      sessionId: 'session-child-1',
      delivered: true,
      deliveryMethod: 'pty',
      acceptedAt: '2026-09-03T00:00:01.000Z',
      turnId: '00000000-0000-4000-8000-000000000001',
      version: 2,
      status: 'working',
      replayed: false,
      message: 'Prompt submitted. Use spawnea_get_turn to read or wait for the response.',
    };
    const sendPrompt = vi.fn().mockResolvedValue(sendResult);
    const client = await connect({ sendPrompt } as Partial<AgentControlService>);

    const result = await client.callTool({
      name: 'spawnea_send_prompt',
      arguments: {
        target: 'session-child-1',
        prompt: 'Run test suite',
      },
    });

    expect(result.structuredContent).toMatchObject({
      delivered: true,
      deliveryMethod: 'pty',
      turnId: '00000000-0000-4000-8000-000000000001',
      message: 'Prompt submitted. Use spawnea_get_turn to read or wait for the response.',
    });
    expect(sendPrompt).toHaveBeenCalledWith({
      target: 'session-child-1',
      prompt: 'Run test suite',
    });
  });

  it('reads a tracked turn with bounded cursor options', async () => {
    const getTurn = vi.fn().mockResolvedValue({
      apiVersion: 'v1',
      turnId: '00000000-0000-4000-8000-000000000001',
      sessionId: 'session-child-1',
      status: 'needs_input',
      version: 3,
      cursor: '00000000-0000-4000-8000-000000000001:42',
      output: 'Should I update the documentation?',
      outputMode: 'compact',
      truncated: false,
      cursorExpired: false,
      extraction: 'none',
      confidence: 'low',
      omitted: [],
      changedAt: '2026-09-05T20:00:00.000Z',
    });
    const client = await connect({ getTurn } as Partial<AgentControlService>);

    const result = await client.callTool({
      name: 'spawnea_get_turn',
      arguments: {
        turnId: '00000000-0000-4000-8000-000000000001',
        afterVersion: 2,
        waitMs: 5_000,
        maxBytes: 16_384,
      },
    });

    expect(result.structuredContent).toMatchObject({
      status: 'needs_input',
      output: 'Should I update the documentation?',
      cursorExpired: false,
    });
    expect(getTurn).toHaveBeenCalledWith({
      turnId: '00000000-0000-4000-8000-000000000001',
      afterVersion: 2,
      waitMs: 5_000,
      maxBytes: 16_384,
    });
  });
});
