import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, createRepositories, type Repositories } from '@spawnea/db';
import { createLogger, type Session } from '@spawnea/domain';
import { AgentControlService } from './agent-control-service.js';
import type { SessionManager } from './session-manager.js';
import { PromptSubmissionError } from '@spawnea/hosts';

describe('AgentControlService', () => {
  let database: ReturnType<typeof createDatabase>;
  let repositories: Repositories;
  let createdCount: number;
  let sessionManager: {
    createSession: ReturnType<typeof vi.fn>;
    renameSession: ReturnType<typeof vi.fn>;
    inspectManagedWorktree: ReturnType<typeof vi.fn>;
    finishSession: ReturnType<typeof vi.fn>;
    createChildSession: ReturnType<typeof vi.fn>;
    sendPrompt: ReturnType<typeof vi.fn>;
    captureSessionTerminal: ReturnType<typeof vi.fn>;
    getGitStatus: ReturnType<typeof vi.fn>;
  };
  let service: AgentControlService;
  let terminalOutput: string;

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
    terminalOutput = 'Codex ready';
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
      createChildSession: vi.fn(async (input, source) => {
        createdCount += 1;
        return session(`child-${createdCount}`, {
          task: input.task,
          name: input.name || input.task,
          parentSessionId: input.parentSessionId,
          childAlias: `child-${createdCount}`,
          status: 'starting',
          creationSource: source,
        });
      }),
      sendPrompt: vi.fn(async (_sessionId: string, _prompt: string) => ({
        delivered: true,
        deliveryMethod: 'pty' as const,
      })),
      captureSessionTerminal: vi.fn(async () => terminalOutput),
      getGitStatus: vi.fn().mockResolvedValue({ isClean: true }),
    };
    service = new AgentControlService({
      repositories,
      sessionManager: sessionManager as unknown as SessionManager,
      logger: createLogger('AgentControlServiceTest'),
    });
  });

  afterEach(() => database.close());

  it('retains partial delivery and prevents both retry duplication and a new overlapping prompt', async () => {
    sessionManager.sendPrompt.mockRejectedValueOnce(new PromptSubmissionError('pty'));
    const input = { target: 'existing', clientRequestId: 'partial', prompt: 'Review' };
    const first = await service.sendPrompt(input);
    expect(first).toMatchObject({ delivered: false, status: 'unknown' });
    expect(first.message).toContain('do not resend');
    await expect(service.sendPrompt(input)).resolves.toMatchObject({ turnId: first.turnId, replayed: true, delivered: false });
    await repositories.sessions.updateStatus('existing', 'working');
    await expect(service.sendPrompt({ ...input, clientRequestId: 'new' })).rejects.toThrow('open turn');
    expect(sessionManager.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('allows confirmed terminal evidence to resolve an uncertain submission', async () => {
    sessionManager.sendPrompt.mockRejectedValueOnce(new PromptSubmissionError('pty'));
    const sent = await service.sendPrompt({ target: 'existing', clientRequestId: 'uncertain-response', prompt: 'Review' });
    terminalOutput += '\n<<<SPAWNEA_RESPONSE_BEGIN>>>Done<<<SPAWNEA_RESPONSE_END>>>';
    await expect(service.getTurn({ turnId: sent.turnId })).resolves.toMatchObject({ status: 'completed', extraction: 'delimited' });
  });

  it('reads Agent Context without refreshing live turn state', async () => {
    const sent = await service.sendPrompt({ target: 'existing', prompt: 'Review' });
    terminalOutput += '\nCaptured result';
    const captured = await service.getTurn({ turnId: sent.turnId, outputMode: 'raw' });
    sessionManager.captureSessionTerminal.mockClear();
    terminalOutput += '\nNot captured yet';
    const viewed = await service.getAgentContextTurn('existing', sent.turnId, 'raw');
    expect(viewed.output).toBe(captured.output);
    expect(viewed.version).toBe(captured.version);
    expect(sessionManager.captureSessionTerminal).not.toHaveBeenCalled();
  });

  it('resolves a child alias within the authenticated root and rejects self-prompting', async () => {
    await repositories.servers.save({ id: 'host-1', name: 'Local', host: 'localhost', sshPort: 22, enabled: true });
    await repositories.sessions.save(session('child', { parentSessionId: 'existing', childAlias: 'child-1' }));
    const scoped = await service.createScopedControl('existing');
    await expect(scoped.sendPrompt({ target: 'child-1', prompt: 'Review', clientRequestId: 'alias' })).resolves.toMatchObject({ sessionId: 'child' });
    await expect(scoped.sendPrompt({ target: 'existing', prompt: 'Review' })).rejects.toThrow('outside');
    await expect(scoped.sendPrompt({ target: 'child', parentSession: 'other', prompt: 'Review' })).rejects.toThrow('outside');
    await expect(service.createScopedControl('child')).rejects.toThrow('not an active local root');
  });

  it('revokes an existing MCP connection when its root is no longer active', async () => {
    await repositories.servers.save({ id: 'host-1', name: 'Local', host: 'localhost', sshPort: 22, enabled: true });
    const scoped = await service.createScopedControl('existing');
    await repositories.sessions.save(session('existing', { status: 'done' }));
    await expect(scoped.getState()).rejects.toThrow('not an active local root');
    await expect(scoped.listSessions()).rejects.toThrow('not an active local root');
    await expect(scoped.inspectWorktree('existing')).rejects.toThrow('not an active local root');
  });

  it('keeps a successful close queryable after the child is removed', async () => {
    await repositories.servers.save({ id: 'host-1', name: 'Local', host: 'localhost', sshPort: 22, enabled: true });
    await repositories.sessions.save(session('child', { parentSessionId: 'existing', status: 'idle' }));
    sessionManager.finishSession.mockImplementationOnce(async () => {
      await repositories.sessions.delete('child');
      return { action: 'close', removed: true };
    });
    const scoped = await service.createScopedControl('existing');
    const result = await scoped.requestFinalization({ clientRequestId: 'close', sessionId: 'child', action: 'close', dirtyChanges: 'stash', confirmation: 'llm-validated' });
    await expect(scoped.getFinalizationRequest(result.id)).resolves.toMatchObject({ status: 'completed', result: { removed: true } });
  });

  it('requires human approval for scoped discard even with LLM validation', async () => {
    await repositories.servers.save({ id: 'host-1', name: 'Local', host: 'localhost', sshPort: 22, enabled: true });
    await repositories.sessions.save(session('child', { parentSessionId: 'existing', status: 'idle' }));
    const scoped = await service.createScopedControl('existing');
    await expect(scoped.requestFinalization({ clientRequestId: 'discard', sessionId: 'child', action: 'close', dirtyChanges: 'discard', confirmation: 'llm-validated' }))
      .resolves.toMatchObject({ mode: 'ui-confirmation', status: 'pending' });
    expect(sessionManager.finishSession).not.toHaveBeenCalled();
  });

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

  it.each([
    'Managed worktree is not checked out on recorded branch',
    'Cannot finalize session: worktree is still in use by another session. Close that session first.',
    'Failed to verify termination of persistent session. Execution may still be active.',
  ])('keeps MCP validation failures truthful: %s', async (message) => {
    const guardError = new Error(message);
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

  describe('Session Hierarchy and Child Sessions via Control API', () => {
    it('creates a child session and returns ControlCreateChildSessionResult with starting status and alias', async () => {
      const result = await service.createChildSession({
        parentSession: 'existing',
        task: 'Refactor child subtask',
        name: 'Child Task',
        workspace: 'same-project',
      });

      expect(result.sessionId).toBe('child-1');
      expect(result.childAlias).toBe('child-1');
      expect(result.parentSessionId).toBe('existing');
      expect(result.status).toBe('starting');
      expect(result).toMatchObject({ startupStatus: 'starting', promptStatus: 'not_requested', replayed: false });
      expect(sessionManager.createChildSession).toHaveBeenCalledWith(
        {
          parentSessionId: 'existing',
          task: 'Refactor child subtask',
          name: 'Child Task',
          workspace: 'same-project',
          agentId: undefined,
          serverId: undefined,
          projectId: undefined,
          model: undefined,
        },
        'mcp'
      );
    });

    it('makes child creation idempotent by client request ID', async () => {
      const request = {
        clientRequestId: 'child-review-1',
        parentSession: 'existing',
        task: 'Review changes',
        workspace: 'same-project' as const,
      };
      const first = await service.createChildSession(request);
      const replay = await service.createChildSession(request);

      expect(replay).toMatchObject({ sessionId: first.sessionId, replayed: true });
      expect(sessionManager.createChildSession).toHaveBeenCalledTimes(1);
    });

    it('lists sessions including parentSessionId and childAlias metadata', async () => {
      await repositories.sessions.save(
        session('child-1', {
          parentSessionId: 'existing',
          childAlias: 'child-1',
          name: 'Child One',
        })
      );

      const listResult = await service.listSessions();
      expect(listResult.sessions).toHaveLength(2);

      const parentView = listResult.sessions.find((s) => s.id === 'existing');
      const childView = listResult.sessions.find((s) => s.id === 'child-1');

      expect(parentView?.parentSessionId).toBeUndefined();
      expect(childView?.parentSessionId).toBe('existing');
      expect(childView?.childAlias).toBe('child-1');
    });

    it('sends prompt to session via sendPrompt', async () => {
      const result = await service.sendPrompt({
        target: 'existing',
        prompt: 'Run tests',
      });

      expect(result).toMatchObject({
        apiVersion: 'v1',
        sessionId: 'existing',
        delivered: true,
        deliveryMethod: 'pty',
        status: 'working',
        replayed: false,
      });
      expect(sessionManager.sendPrompt).toHaveBeenCalledWith('existing', 'Run tests');
    });

    it('reads only terminal output produced after the prompt cursor', async () => {
      const sent = await service.sendPrompt({
        target: 'existing',
        clientRequestId: 'review-1',
        prompt: '/review',
      });
      terminalOutput = 'Codex ready\nReview finding one';

      const first = await service.getTurn({ turnId: sent.turnId });
      const unchanged = await service.getTurn({
        turnId: sent.turnId,
        cursor: first.cursor,
        afterVersion: first.version,
      });

      expect(first).toMatchObject({ output: '\nReview finding one', cursorExpired: false });
      expect(unchanged).toMatchObject({ status: 'unchanged', output: '' });
    });

    it('does not append repeated TUI redraws to the retained turn output', async () => {
      const sent = await service.sendPrompt({ target: 'existing', prompt: '/review' });
      terminalOutput = 'Codex ready\nReviewing files…';

      const first = await service.getTurn({ turnId: sent.turnId, outputMode: 'raw' });
      const redraw = await service.getTurn({ turnId: sent.turnId, outputMode: 'raw' });

      expect(first.output).toBe('\nReviewing files…');
      expect(redraw.output).toBe('\nReviewing files…');
      expect(redraw.version).toBe(first.version);
    });

    it('replays identical prompt request IDs without writing twice', async () => {
      const request = { target: 'existing', clientRequestId: 'review-retry', prompt: '/review' };
      const first = await service.sendPrompt(request);
      const replay = await service.sendPrompt(request);

      expect(replay).toMatchObject({ turnId: first.turnId, replayed: true });
      expect(sessionManager.sendPrompt).toHaveBeenCalledTimes(1);
    });

    it('blocks a second prompt while the child turn is working', async () => {
      await service.sendPrompt({ target: 'existing', clientRequestId: 'turn-one', prompt: '/review' });
      await expect(service.sendPrompt({
        target: 'existing', clientRequestId: 'turn-two', prompt: 'Another request',
      })).rejects.toThrow('already has an open turn');
      expect(sessionManager.sendPrompt).toHaveBeenCalledTimes(1);
    });

    it('accepts an answer when the tracked turn needs input', async () => {
      const first = await service.sendPrompt({ target: 'existing', clientRequestId: 'turn-question', prompt: '/review' });
      await repositories.sessions.updateStatus('existing', 'needs_input');
      terminalOutput = 'Codex ready\nShould I include docs?';
      await expect(service.getTurn({ turnId: first.turnId })).resolves.toMatchObject({ status: 'needs_input' });

      const answer = await service.sendPrompt({
        target: 'existing', clientRequestId: 'turn-answer', prompt: 'Yes, include docs.',
      });
      expect(answer).toMatchObject({ turnId: first.turnId, status: 'working' });
      expect(sessionManager.sendPrompt).toHaveBeenCalledTimes(2);
    });

    it('discloses expired cursor context when the terminal snapshot no longer overlaps', async () => {
      const sent = await service.sendPrompt({ target: 'existing', prompt: '/review' });
      terminalOutput = 'x'.repeat(300_000);

      const result = await service.getTurn({
        turnId: sent.turnId,
        cursor: `${sent.turnId}:0`,
        outputMode: 'raw',
      });
      expect(result.cursorExpired).toBe(true);
      expect(result.output.length).toBeLessThanOrEqual(131_072);
      const next = await service.getTurn({ turnId: sent.turnId, cursor: result.cursor, outputMode: 'raw' });
      expect(next.cursorExpired).toBe(false);
      expect(next.version).toBe(result.version);
    });

    it('freezes a completed turn before later terminal activity', async () => {
      const sent = await service.sendPrompt({ target: 'existing', prompt: 'Review' });
      terminalOutput += '\n<<<SPAWNEA_RESPONSE_BEGIN>>>Done<<<SPAWNEA_RESPONSE_END>>>';
      const first = await service.getTurn({ turnId: sent.turnId });
      terminalOutput += '\nLater unrelated activity';
      const later = await service.getTurn({ turnId: sent.turnId });
      expect(first.status).toBe('completed');
      expect(later).toEqual(first);
    });

    it('does not infer completion from an idle prompt echo', async () => {
      await repositories.sessions.updateStatus('existing', 'idle');
      const sent = await service.sendPrompt({ target: 'existing', prompt: 'Review' });
      terminalOutput += '\nReview';
      await service.getTurn({ turnId: sent.turnId });
      await expect(service.getTurn({ turnId: sent.turnId })).resolves.toMatchObject({ status: 'unknown' });
    });

    it('completes an idle turn when the first refresh contains response output', async () => {
      await repositories.sessions.updateStatus('existing', 'idle');
      const sent = await service.sendPrompt({ target: 'existing', prompt: 'Review' });
      terminalOutput += '\nReview\nCompleted response';

      await expect(service.getTurn({ turnId: sent.turnId })).resolves.toMatchObject({
        status: 'completed',
        output: '\nReview\nCompleted response',
      });
      await expect(service.sendPrompt({ target: 'existing', prompt: 'Follow-up' })).resolves.toMatchObject({
        status: 'working',
      });
    });

    it('does not mistake response markers echoed from the prompt for child completion', async () => {
      const prompt = 'Use this format:\n<<<SPAWNEA_RESPONSE_BEGIN>>>\nexample\n<<<SPAWNEA_RESPONSE_END>>>';
      const sent = await service.sendPrompt({ target: 'existing', prompt });
      terminalOutput = `Codex ready\n${prompt}`;

      const echoed = await service.getTurn({ turnId: sent.turnId });
      expect(echoed).toMatchObject({ status: 'working', extraction: 'none' });

      terminalOutput += '\n<<<SPAWNEA_RESPONSE_BEGIN>>>\nactual result\n<<<SPAWNEA_RESPONSE_END>>>';
      const response = await service.getTurn({ turnId: sent.turnId, cursor: echoed.cursor });
      expect(response).toMatchObject({ output: 'actual result', extraction: 'delimited', confidence: 'high' });
    });

    it('navigates to session by child alias when parentSessionId is provided', async () => {
      await repositories.sessions.save(
        session('child-sess-id', {
          parentSessionId: 'existing',
          childAlias: 'child-1',
        })
      );

      const navResult = await service.navigate({
        sessionId: 'child-1',
        parentSessionId: 'existing',
        tab: 'terminal',
      });

      expect(navResult.activeSessionId).toBe('child-sess-id');
      expect(navResult.activeTab).toBe('terminal');
    });
  });
});
