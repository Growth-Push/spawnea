import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, createRepositories, type Repositories } from '@spawnea/db';
import { createLogger, type Session } from '@spawnea/domain';
import { AgentControlService } from './agent-control-service.js';
import type { SessionManager } from './session-manager.js';

describe('AgentControlService', () => {
  let database: ReturnType<typeof createDatabase>;
  let repositories: Repositories;
  let createdCount: number;
  let sessionManager: {
    createSession: ReturnType<typeof vi.fn>;
    renameSession: ReturnType<typeof vi.fn>;
    inspectManagedWorktree: ReturnType<typeof vi.fn>;
    finishSession: ReturnType<typeof vi.fn>;
  };
  let service: AgentControlService;

  const session = (id: string, overrides: Partial<Session> = {}): Session => ({
    id,
    name: `Session ${id}`,
    serverId: 'host-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    task: `Task ${id}`,
    worktreePath: `/repo/worktrees/${id}`,
    branch: `spawnea/${id}`,
    baseBranch: 'main',
    managedWorktree: true,
    tmuxSessionName: `spawnea-${id}`,
    status: 'working',
    createdAt: new Date('2026-08-27T10:00:00.000Z'),
    lastActivityAt: new Date('2026-08-27T10:01:00.000Z'),
    ...overrides,
  });

  beforeEach(async () => {
    database = createDatabase({ path: ':memory:', migrate: true });
    repositories = createRepositories(database.db);
    await repositories.servers.save({
      id: 'host-1', name: 'Local host', host: 'user:secret@example.test', sshPort: 22, enabled: true,
    });
    await repositories.projects.save({
      id: 'project-1', serverId: 'host-1', name: 'Spawnea', rootPath: '/repo', baseBranch: 'main',
    });
    await repositories.agents.save({
      id: 'agent-1', name: 'Codex', harness: 'codex', command: 'codex',
    });
    await repositories.sessions.save(session('existing'));
    createdCount = 0;
    sessionManager = {
      createSession: vi.fn(async (input) => {
        if (input.task === 'fail') throw new Error('Host unavailable');
        createdCount += 1;
        return session(`created-${createdCount}`, { task: input.task, name: input.task });
      }),
      renameSession: vi.fn(async (sessionId: string, title: string) => {
        const existing = await repositories.sessions.findById(sessionId);
        if (!existing) throw new Error(`Session '${sessionId}' not found`);
        return { ...existing, name: title.trim() };
      }),
      inspectManagedWorktree: vi.fn().mockResolvedValue({
        state: 'active', currentBranch: 'spawnea/existing', message: 'Ready',
      }),
      finishSession: vi.fn().mockResolvedValue({ action: 'integrate', removed: true }),
    };
    service = new AgentControlService({
      repositories,
      sessionManager: sessionManager as unknown as SessionManager,
      logger: createLogger('AgentControlServiceTest'),
    });
  });

  afterEach(() => database.close());

  it('lists versioned state without exposing host connection targets or credentials', async () => {
    service.setUiState({ activeSessionId: 'existing', activeTab: 'diff' });
    const state = await service.getState();

    expect(state.apiVersion).toBe('v1');
    expect(state.sessions[0]).toMatchObject({
      id: 'existing',
      host: { id: 'host-1', name: 'Local host' },
      project: { id: 'project-1', name: 'Spawnea' },
      active: true,
      activeTab: 'diff',
      creationSource: 'ui',
    });
    expect(JSON.stringify(state)).not.toContain('example.test');
    expect(JSON.stringify(state)).not.toContain('secret');
  });

  it('returns per-item partial results and makes exact correlation retries idempotent', async () => {
    const request = {
      correlationId: 'batch-1',
      sessions: [
        { clientRequestId: 'one', serverId: 'host-1', projectId: 'project-1', agentId: 'agent-1', task: 'works' },
        { clientRequestId: 'two', serverId: 'host-1', projectId: 'project-1', agentId: 'agent-1', task: 'fail' },
      ],
    };

    const first = await service.createSessions(request);
    const replay = await service.createSessions(request);

    expect(first.replayed).toBe(false);
    expect(first.results).toEqual([
      expect.objectContaining({ clientRequestId: 'one', success: true }),
      expect.objectContaining({ clientRequestId: 'two', success: false }),
    ]);
    expect(replay.replayed).toBe(true);
    expect(sessionManager.createSession).toHaveBeenCalledTimes(2);
    expect(sessionManager.createSession.mock.calls[0][1]).toBe('mcp');
    expect(sessionManager.createSession.mock.calls[1][1]).toBe('mcp');
    await expect(service.createSessions({ ...request, sessions: [request.sessions[0]] }))
      .rejects.toThrow('different payload');
  });

  it('renames through SessionManager and reports whether the renderer was notified', async () => {
    const notifyDataChanged = vi.fn().mockReturnValue(true);
    service = new AgentControlService({
      repositories,
      sessionManager: sessionManager as unknown as SessionManager,
      logger: createLogger('AgentControlServiceTest'),
      notifyDataChanged,
    });

    const result = await service.renameSession({ sessionId: 'existing', title: '  Clear title  ' });

    expect(sessionManager.renameSession).toHaveBeenCalledWith('existing', '  Clear title  ');
    expect(result).toMatchObject({
      apiVersion: 'v1',
      deliveredToRenderer: true,
      session: {
        id: 'existing',
        name: 'Clear title',
        task: 'Task existing',
        tmuxSessionName: 'spawnea-existing',
        worktree: {
          path: '/repo/worktrees/existing',
          branch: 'spawnea/existing',
          baseBranch: 'main',
        },
      },
    });
    expect(notifyDataChanged).toHaveBeenCalledOnce();
  });

  it('returns an unequivocal missing-session error and does not notify the renderer', async () => {
    const notifyDataChanged = vi.fn();
    service = new AgentControlService({
      repositories,
      sessionManager: sessionManager as unknown as SessionManager,
      logger: createLogger('AgentControlServiceTest'),
      notifyDataChanged,
    });

    await expect(service.renameSession({ sessionId: 'missing', title: 'Title' }))
      .rejects.toThrow("Session 'missing' not found");
    expect(notifyDataChanged).not.toHaveBeenCalled();
    expect((await service.getState()).recentErrors[0]).toMatchObject({
      operation: 'rename_session',
      message: "Session 'missing' not found",
    });
  });

  it('never finalizes until the renderer explicitly approves the pending request', async () => {
    const pending = await service.requestFinalization({
      clientRequestId: 'finalize-1', sessionId: 'existing', action: 'integrate',
    });

    expect(pending.status).toBe('pending');
    expect(pending.mode).toBe('ui-confirmation');
    expect(sessionManager.finishSession).not.toHaveBeenCalled();

    const completed = await service.resolveFinalizationRequest(pending.id, 'approve');
    expect(completed.status).toBe('completed');
    expect(sessionManager.finishSession).toHaveBeenCalledWith('existing', 'integrate', undefined);
    await expect(service.resolveFinalizationRequest(pending.id, 'approve')).rejects.toThrow('already completed');
  });

  it('executes an explicitly LLM-validated MCP close without notifying the renderer', async () => {
    const notifyFinalizationRequested = vi.fn();
    const notifyDataChanged = vi.fn();
    sessionManager.finishSession.mockResolvedValueOnce({ action: 'close', removed: true });
    service = new AgentControlService({
      repositories,
      sessionManager: sessionManager as unknown as SessionManager,
      logger: createLogger('AgentControlServiceTest'),
      notifyFinalizationRequested,
      notifyDataChanged,
    });

    const result = await service.requestFinalization({
      clientRequestId: 'validated-close',
      sessionId: 'existing',
      action: 'close',
      dirtyChanges: 'stash',
      confirmation: 'llm-validated',
    });

    expect(result).toMatchObject({
      mode: 'mcp-validated',
      status: 'completed',
      result: { action: 'close', removed: true },
    });
    expect(sessionManager.finishSession).toHaveBeenCalledWith(
      'existing',
      'close',
      { stashChanges: true },
      'mcp-validated'
    );
    expect(notifyFinalizationRequested).not.toHaveBeenCalled();
    expect(notifyDataChanged).toHaveBeenCalledOnce();
  });

  it('keeps MCP validation failures truthful and does not hide finalization guards', async () => {
    const guardError = new Error('Managed worktree is not checked out on recorded branch');
    sessionManager.finishSession.mockRejectedValueOnce(guardError);
    service = new AgentControlService({
      repositories,
      sessionManager: sessionManager as unknown as SessionManager,
      logger: createLogger('AgentControlServiceTest'),
    });

    const result = await service.requestFinalization({
      clientRequestId: 'guarded-close',
      sessionId: 'existing',
      action: 'close',
      dirtyChanges: 'discard',
      confirmation: 'llm-validated',
    });

    expect(result).toMatchObject({
      mode: 'mcp-validated',
      status: 'failed',
      error: guardError.message,
    });
    expect((await service.getState()).recentErrors[0]).toMatchObject({
      operation: `finalize_session:${result.id}`,
      message: guardError.message,
    });
  });

  it('rejects without mutations and requires an explicit dirty-change policy for close', async () => {
    await expect(service.requestFinalization({
      clientRequestId: 'unsafe-close', sessionId: 'existing', action: 'close',
    })).rejects.toThrow("dirtyChanges 'stash' or 'discard'");

    const pending = await service.requestFinalization({
      clientRequestId: 'safe-close', sessionId: 'existing', action: 'close', dirtyChanges: 'discard',
    });
    expect(pending.mode).toBe('ui-confirmation');
    const rejected = await service.resolveFinalizationRequest(pending.id, 'reject');
    expect(rejected.status).toBe('rejected');
    expect(sessionManager.finishSession).not.toHaveBeenCalled();
  });
});
