import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createSpawneaMcpServer } from './control-mcp-server.js';
import type { AgentControlService } from './agent-control-service.js';

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

  afterEach(async () => {
    await Promise.allSettled(connected.splice(0).flatMap(({ client, server }) => [client.close(), server.close()]));
  });

  it('publishes exactly the documented canonical tools without legacy aliases', async () => {
    const client = await connect({});
    const result = await client.listTools();
    const toolNames = result.tools.map((tool) => tool.name);
    expect(toolNames).toEqual([
      'spawnea_get_state',
      'spawnea_inspect_worktree',
      'spawnea_rename_session',
      'spawnea_create_sessions',
      'spawnea_activate',
      'spawnea_request_finalization',
      'spawnea_get_finalization_request',
    ]);
    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(toolNames.every((name) => name.startsWith('spawnea_'))).toBe(true);
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

  it('rejects malformed batch input before any session can be created', async () => {
    const createSessions = vi.fn();
    const client = await connect({ createSessions } as Partial<AgentControlService>);

    const result = await client.callTool({
      name: 'spawnea_create_sessions',
      arguments: { correlationId: 'batch', sessions: [] },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('sessions') }),
    ]));
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
});
