import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, createRepositories, type Repositories } from '@spawnea/db';
import { createLogger, type Session, type SessionHistoryQuery, type SessionHistoryResult } from '@spawnea/domain';
import { PromptSubmissionError } from '@spawnea/hosts';
import { ClaudeHistoryReader, CodexHistoryReader, encodeClaudeProjectPath } from '@spawnea/state';
import { AgentControlService } from './agent-control-service.js';
import { MobileApiServer } from './mobile-api-server.js';
import * as mobileAuth from './mobile-api-auth.js';
import { hashKey } from './mobile-api-auth.js';
import type { SessionManager } from './session-manager.js';

describe('MobileApiServer', () => {
  let database: ReturnType<typeof createDatabase>;
  let repositories: Repositories;
  let sessionManager: {
    repos: Repositories;
    captureSessionTerminal: ReturnType<typeof vi.fn>;
    getSessionHistory: ReturnType<typeof vi.fn>;
    sendPrompt: ReturnType<typeof vi.fn>;
  };
  let controlService: AgentControlService;
  let activeServers: MobileApiServer[] = [];
  let testKeyHash: string;
  const rawSecretKey = 'mobile-secret-auth-key-32-chars-long';

  const mockSession = (id: string, overrides: Partial<Session> = {}): Session => ({
    id,
    name: `Session ${id}`,
    serverId: 'host-1',
    projectId: 'proj-1',
    agentId: 'agent-1',
    task: `Task ${id}`,
    worktreePath: `/worktrees/${id}`,
    branch: `spawnea/${id}`,
    baseBranch: 'main',
    managedWorktree: true,
    tmuxSessionName: `tmux-${id}`,
    status: 'idle',
    createdAt: new Date('2026-11-04T12:00:00.000Z'),
    lastActivityAt: new Date('2026-11-04T12:00:00.000Z'),
    ...overrides,
  });

  const jsonBody = async (res: Response): Promise<any> => (await res.json()) as any;

  beforeEach(async () => {
    database = createDatabase({ path: ':memory:', migrate: true });
    repositories = createRepositories(database.db);

    await repositories.servers.save({
      id: 'host-1',
      name: 'Local Host',
      host: 'localhost',
      sshPort: 22,
      enabled: true,
    });
    await repositories.projects.save({
      id: 'proj-1',
      serverId: 'host-1',
      name: 'Project 1',
      rootPath: '/repo/project-1',
      baseBranch: 'main',
    });
    await repositories.agents.save({
      id: 'agent-1',
      name: 'Codex Agent',
      harness: 'codex',
      command: 'codex',
    });

    sessionManager = {
      repos: repositories,
      captureSessionTerminal: vi.fn(async () => '$ ready for prompt\n› '),
      getSessionHistory: vi.fn(async (sessionId: string): Promise<SessionHistoryResult> => ({
        sessionId,
        source: 'screen',
        items: [
          { id: '1', role: 'user', text: 'Hello', source: 'screen' },
          { id: '2', role: 'agent', text: 'Hi, how can I help?', source: 'screen' },
        ],
        cursor: 'line:2',
        hasMore: false,
      })),
      sendPrompt: vi.fn(async () => ({ delivered: true, deliveryMethod: 'tmux' })),
    };

    controlService = new AgentControlService({
      repositories,
      sessionManager: sessionManager as unknown as SessionManager,
      logger: createLogger('ControlServiceTest'),
      getActiveCatalog: () => ({
        version: 1,
        hosts: {
          'host-1': {
            id: 'host-1',
            name: 'Local Host',
            enabled: true,
            projects: {
              'proj-1': {
                id: 'proj-1',
                name: 'Project 1',
                path: '/repo/project-1',
                base_branch: 'main',
                enabled: true,
              },
            },
            harnesses: {
              'agent-1': {
                id: 'agent-1',
                name: 'Codex Agent',
                command: 'codex',
                args: [],
                enabled: true,
              },
            },
          },
        },
      }),
    });

    testKeyHash = await hashKey(rawSecretKey);
  });

  afterEach(async () => {
    for (const server of activeServers) {
      await server.close();
    }
    activeServers = [];
    database.close();
  });

  async function createAndStartServer(
    configOverrides: Record<string, unknown> = {},
    optionsOverrides: Record<string, unknown> = {}
  ): Promise<{ server: MobileApiServer; port: number; baseUrl: string }> {
    const config = {
      enabled: true,
      port: 0, // Ephemeral port for tests
      key_hash: testKeyHash,
      ...configOverrides,
    };
    const server = new MobileApiServer({
      control: controlService,
      sessionManager: sessionManager as unknown as SessionManager,
      logger: createLogger('MobileApiServerTest'),
      config: config as any,
      port: 0,
      ...optionsOverrides,
    });
    activeServers.push(server);
    const startResult = await server.start();
    if (!startResult) {
      return { server, port: 0, baseUrl: '' };
    }
    const port = startResult.port;
    return { server, port, baseUrl: `http://127.0.0.1:${port}` };
  }

  describe('Configuration & Listener Lifecycle', () => {
    it('is disabled by default and does not open a listener when enabled is false or missing', async () => {
      // 1. Omitted config
      const server1 = new MobileApiServer({
        control: controlService,
        sessionManager: sessionManager as unknown as SessionManager,
        logger: createLogger('Test'),
        config: undefined,
      });
      activeServers.push(server1);
      expect(await server1.start()).toBe(null);
      expect(server1.isListening()).toBe(false);

      // 2. enabled: false
      const server2 = new MobileApiServer({
        control: controlService,
        sessionManager: sessionManager as unknown as SessionManager,
        logger: createLogger('Test'),
        config: { enabled: false, key_hash: testKeyHash },
      });
      activeServers.push(server2);
      expect(await server2.start()).toBe(null);
      expect(server2.isListening()).toBe(false);
    });

    it('never opens a listener if key_hash is missing, empty, or invalid Argon2id hash', async () => {
      // Missing key_hash
      const { server: server1 } = await createAndStartServer({ key_hash: undefined });
      expect(server1.isListening()).toBe(false);

      // Empty key_hash
      const { server: server2 } = await createAndStartServer({ key_hash: '' });
      expect(server2.isListening()).toBe(false);

      // Plaintext string instead of Argon2id
      const { server: server3 } = await createAndStartServer({ key_hash: 'not-an-argon2-hash' });
      expect(server3.isListening()).toBe(false);

      // Wrong Argon2 variant (e.g. argon2d or argon2i)
      const { server: server4 } = await createAndStartServer({
        key_hash: '$argon2d$v=19$m=19456,t=2,p=1$sampleSalt$sampleHash',
      });
      expect(server4.isListening()).toBe(false);

      // Malformed Argon2id PHC parameters (version, m/t/p params, salt)
      const { server: server5 } = await createAndStartServer({
        key_hash: '$argon2id$v=garbage$m=nope,t=bad,p=x$someSalt$someHash',
      });
      expect(server5.isListening()).toBe(false);

      // Malformed base64 salt and digest rejected by native verifier at start()
      const { server: server6 } = await createAndStartServer({
        key_hash: '$argon2id$v=19$m=19456,t=2,p=1$a$a',
      });
      expect(server6.isListening()).toBe(false);
    });

    it('distinguishes native Argon2 load failure from an invalid hash, logging at error level without starting listener', async () => {
      const errorLogs: string[] = [];
      const testLogger = createLogger('Argon2LoadTest', {
        handlers: [
          (entry) => {
            if (entry.level === 'error') {
              errorLogs.push(entry.message);
            }
          },
        ],
      });

      const spy = vi.spyOn(mobileAuth, 'validateArgon2idConfigHashDetailed').mockResolvedValueOnce({
        ok: false,
        reason: 'native_load_failure',
        error: new Error('Failed to load @node-rs/argon2 native binary'),
      });

      const { server } = await createAndStartServer({}, { logger: testLogger });
      expect(server.isListening()).toBe(false);
      expect(errorLogs.some((msg) => msg.includes('native Argon2 module failed to load'))).toBe(true);
      spy.mockRestore();
    });

    it('listens only on loopback 127.0.0.1 with ephemeral port and isolated profile', async () => {
      const isolatedProfile = 'profile-isolated-mobile-test';
      const isolatedControlService = new AgentControlService({
        repositories,
        sessionManager: sessionManager as unknown as SessionManager,
        logger: createLogger('IsolatedControl'),
        getActiveCatalog: () => ({ version: 1, hosts: {} }),
      });

      const { server, port, baseUrl } = await createAndStartServer({}, {
        port: 0,
        control: isolatedControlService,
        profile: isolatedProfile,
      });
      expect(server.isListening()).toBe(true);
      expect(server.getProfile()).toBe(isolatedProfile);
      expect(port).toBeGreaterThan(0);
      expect(server.getAddress()?.address).toBe('127.0.0.1');
      expect(server.getAddress()?.port).toBe(port);
      expect(baseUrl).toBe(`http://127.0.0.1:${port}`);

      // Verify server responds strictly on 127.0.0.1
      const res = await fetch(`${baseUrl}/api/v1/sessions`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(res.status).toBe(200);

      await server.close();
      expect(server.isListening()).toBe(false);
    });
  });

  describe('Authentication & Key Privacy', () => {
    it('returns 401 Unauthorized when Authorization header is missing or malformed', async () => {
      const { baseUrl } = await createAndStartServer();

      // Missing header
      const res1 = await fetch(`${baseUrl}/api/v1/sessions`);
      expect(res1.status).toBe(401);
      const json1 = await jsonBody(res1);
      expect(json1).toEqual({
        apiVersion: 'v1',
        error: { code: 'unauthorized', message: 'Unauthorized' },
      });

      // Basic auth instead of Bearer
      const res2 = await fetch(`${baseUrl}/api/v1/sessions`, {
        headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      });
      expect(res2.status).toBe(401);

      // Empty Bearer token
      const res3 = await fetch(`${baseUrl}/api/v1/sessions`, {
        headers: { Authorization: 'Bearer ' },
      });
      expect(res3.status).toBe(401);
    });

    it('returns 401 without leaking or echoing the candidate key in the response or logs', async () => {
      const logMessages: string[] = [];
      const capturingLogger = createLogger('CapturingTest', {
        handlers: [
          (entry) => {
            logMessages.push(JSON.stringify(entry));
          },
        ],
      });

      const leakySecretKey = `candidate-probe-${randomBytes(16).toString('hex')}`;
      const { baseUrl } = await createAndStartServer(
        {},
        { logger: capturingLogger }
      );

      const res = await fetch(`${baseUrl}/api/v1/sessions`, {
        headers: { Authorization: `Bearer ${leakySecretKey}` },
      });
      expect(res.status).toBe(401);
      const responseText = await res.text();

      // Must not echo the key in the HTTP response
      expect(responseText).not.toContain(leakySecretKey);
      expect(JSON.parse(responseText)).toEqual({
        apiVersion: 'v1',
        error: { code: 'unauthorized', message: 'Unauthorized' },
      });

      // Must not echo or log the candidate key in any logger output
      for (const log of logMessages) {
        expect(log).not.toContain(leakySecretKey);
      }
    });

    it('authenticates successfully with valid Bearer key', async () => {
      const { baseUrl } = await createAndStartServer();
      const res = await fetch(`${baseUrl}/api/v1/sessions`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.apiVersion).toBe('v1');
      expect(Array.isArray(data.sessions)).toBe(true);
    });

    it('caches accepted token SHA-256 in memory so subsequent polls skip Argon2 verification', async () => {
      const { server, baseUrl } = await createAndStartServer();
      const verifySpy = vi.spyOn(mobileAuth, 'verifyKey');
      verifySpy.mockClear();

      // First request: uncached, calls Argon2 verifyKey
      const res1 = await fetch(`${baseUrl}/api/v1/sessions`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(res1.status).toBe(200);
      expect(verifySpy).toHaveBeenCalledTimes(1);

      // Second request with same valid token: cached in-memory SHA-256 matches, skips Argon2 verifyKey!
      const res2 = await fetch(`${baseUrl}/api/v1/sessions`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(res2.status).toBe(200);
      expect(verifySpy).toHaveBeenCalledTimes(1);

      // Third request with wrong token: fails authentication and calls verifyKey
      const res3 = await fetch(`${baseUrl}/api/v1/sessions`, {
        headers: { Authorization: 'Bearer wrong-token-123' },
      });
      expect(res3.status).toBe(401);
      expect(verifySpy).toHaveBeenCalledTimes(2);

      // Cache is cleared on server stop/close
      await server.close();
      verifySpy.mockRestore();
    });
  });

  describe('Contract & Endpoints', () => {
    it('GET /api/v1/sessions returns session list with expected DTO shape', async () => {
      await repositories.sessions.save(mockSession('sess-root-1', { task: 'Root Task' }));
      await repositories.sessions.save(mockSession('sess-child-1', {
        parentSessionId: 'sess-root-1',
        childAlias: 'child-a',
        task: 'Child Task',
      }));

      const { baseUrl } = await createAndStartServer();
      const res = await fetch(`${baseUrl}/api/v1/sessions`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.apiVersion).toBe('v1');
      expect(data.sessions).toHaveLength(2);
      expect(data.sessions[0].id).toBe('sess-root-1');
      expect(data.sessions[1].id).toBe('sess-child-1');
      expect(data.sessions[1].parentSessionId).toBe('sess-root-1');
    });

    it('GET /api/v1/sessions/:id returns detail or 404 for unknown session', async () => {
      await repositories.sessions.save(mockSession('sess-100', { task: 'Detail Task' }));

      const { baseUrl } = await createAndStartServer();

      // Found
      const res1 = await fetch(`${baseUrl}/api/v1/sessions/sess-100`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(res1.status).toBe(200);
      const data1 = await jsonBody(res1);
      expect(data1.apiVersion).toBe('v1');
      expect(data1.session.id).toBe('sess-100');
      expect(data1.session.task).toBe('Detail Task');

      // Not found
      const res2 = await fetch(`${baseUrl}/api/v1/sessions/unknown-session`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(res2.status).toBe(404);
      const data2 = await jsonBody(res2);
      expect(data2.error.code).toBe('not_found');
    });

    it('returns 400 invalid_request when session ID contains malformed percent-encoding', async () => {
      const { baseUrl } = await createAndStartServer();
      const res = await fetch(`${baseUrl}/api/v1/sessions/%E0%A4%A`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(res.status).toBe(400);
      const data = await jsonBody(res);
      expect(data.error.code).toBe('invalid_request');
      expect(data.error.message).toBe('Malformed session ID');

      // Also on sub-resource route
      const resSub = await fetch(`${baseUrl}/api/v1/sessions/%E0%A4%A/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'test', clientRequestId: 'req-malformed-id' }),
      });
      expect(resSub.status).toBe(400);
      const dataSub = await jsonBody(resSub);
      expect(dataSub.error.code).toBe('invalid_request');
      expect(dataSub.error.message).toBe('Malformed session ID');
    });

    it('GET /api/v1/sessions/:id/output returns live output or 404', async () => {
      await repositories.sessions.save(mockSession('sess-live', { status: 'idle' }));
      sessionManager.captureSessionTerminal.mockResolvedValueOnce('Live output line 1\nLive output line 2');

      const { baseUrl } = await createAndStartServer();
      const res = await fetch(`${baseUrl}/api/v1/sessions/sess-live/output?lines=50`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.apiVersion).toBe('v1');
      expect(data.available).toBe(true);
      expect(data.status).toBe('live');
      expect(data.output).toBe('Live output line 1\nLive output line 2');
      expect(sessionManager.captureSessionTerminal).toHaveBeenCalledWith('sess-live', 50);

      // Not found
      const resNotFound = await fetch(`${baseUrl}/api/v1/sessions/missing/output`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(resNotFound.status).toBe(404);
    });

    it('reports unavailable, never live, if terminal capture fails on an active session', async () => {
      await repositories.sessions.save(mockSession('sess-fail-capture', { status: 'idle' }));
      const customSessionManager = {
        ...sessionManager,
        captureSessionTerminalDetailed: vi.fn(async () => ({ success: false, output: '' })),
      };

      const { baseUrl } = await createAndStartServer({}, {
        sessionManager: customSessionManager as unknown as SessionManager,
      });

      const res = await fetch(`${baseUrl}/api/v1/sessions/sess-fail-capture/output`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.apiVersion).toBe('v1');
      expect(data.available).toBe(false);
      expect(data.status).toBe('unavailable');
      expect(data.output).toBe(null);
    });

    it('GET /api/v1/sessions/:id/history returns history exchanges or 404', async () => {
      await repositories.sessions.save(mockSession('sess-hist', { status: 'idle' }));

      const { baseUrl } = await createAndStartServer();
      const res = await fetch(`${baseUrl}/api/v1/sessions/sess-hist/history?limit=15`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.apiVersion).toBe('v1');
      expect(data.available).toBe(true);
      expect(data.items).toHaveLength(2);
      expect(sessionManager.getSessionHistory).toHaveBeenCalledWith('sess-hist', {
        limit: 15,
        cursor: undefined,
        mode: 'recent_exchanges',
        recentExchanges: 15,
      });

      // Not found
      const resNotFound = await fetch(`${baseUrl}/api/v1/sessions/missing/history`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(resNotFound.status).toBe(404);
    });

    it('preserves live terminal output for running sessions in error state', async () => {
      await repositories.sessions.save(mockSession('sess-error-status', { status: 'error' }));
      sessionManager.captureSessionTerminal.mockResolvedValueOnce('ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL Command failed');

      const { baseUrl } = await createAndStartServer();
      const res = await fetch(`${baseUrl}/api/v1/sessions/sess-error-status/output`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.available).toBe(true);
      expect(data.status).toBe('live');
      expect(data.output).toBe('ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL Command failed');
    });

    it('preserves screen history for running sessions in error state when terminal capture succeeds', async () => {
      await repositories.sessions.save(mockSession('sess-error-screen', { status: 'error' }));
      sessionManager.getSessionHistory.mockResolvedValueOnce({
        sessionId: 'sess-error-screen',
        source: 'screen',
        items: [{ id: 'item-1', role: 'user', text: 'pnpm test' }],
        hasMore: false,
        captureSuccess: true,
      });

      const { baseUrl } = await createAndStartServer();
      const res = await fetch(`${baseUrl}/api/v1/sessions/sess-error-screen/history`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.available).toBe(true);
      expect(data.source).toBe('screen');
      expect(data.items).toHaveLength(1);
      expect(data.items[0].text).toBe('pnpm test');
    });

    it('POST /api/v1/sessions/:id/message sends message to active session', async () => {
      await repositories.sessions.save(mockSession('sess-message', { status: 'idle' }));

      const { baseUrl } = await createAndStartServer();

      const res = await fetch(`${baseUrl}/api/v1/sessions/sess-message/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Test message via message endpoint', clientRequestId: 'req-msg-endpoint' }),
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.apiVersion).toBe('v1');
      expect(data.delivered).toBe(true);
      expect(data.status).toBe('working');
    });

    it('rejects removed /prompt route with 404 Not Found', async () => {
      await repositories.sessions.save(mockSession('sess-no-prompt', { status: 'idle' }));

      const { baseUrl } = await createAndStartServer();

      const res = await fetch(`${baseUrl}/api/v1/sessions/sess-no-prompt/prompt`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Test message' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('States, Blocking Rules & Idempotency', () => {
    it('supports sending to active child sessions', async () => {
      await repositories.sessions.save(mockSession('sess-parent', { status: 'idle' }));
      await repositories.sessions.save(mockSession('sess-child', {
        parentSessionId: 'sess-parent',
        childAlias: 'child-1',
        status: 'idle',
      }));

      const { baseUrl } = await createAndStartServer();
      const res = await fetch(`${baseUrl}/api/v1/sessions/sess-child/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Inspect workspace', clientRequestId: 'req-child-inspect' }),
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.sessionId).toBe('sess-child');
      expect(data.delivered).toBe(true);
    });

    it('rejects sending to a disconnected or done session with 422 Unprocessable Entity', async () => {
      await repositories.sessions.save(mockSession('sess-dead', { status: 'disconnected' }));

      const { baseUrl } = await createAndStartServer();
      const res = await fetch(`${baseUrl}/api/v1/sessions/sess-dead/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Are you there?', clientRequestId: 'req-dead-send' }),
      });
      expect(res.status).toBe(422);
      const data = await jsonBody(res);
      expect(data.error.code).toBe('needs_human');
      expect(data.error.message).toContain('not available for prompt delivery');
    });

    it('enforces idempotency via clientRequestId: replays exact match and conflicts on different prompt', async () => {
      await repositories.sessions.save(mockSession('sess-idem', { status: 'idle' }));

      const { baseUrl } = await createAndStartServer();

      // 1. First send with clientRequestId
      const res1 = await fetch(`${baseUrl}/api/v1/sessions/sess-idem/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Initial command', clientRequestId: 'req-unique-123' }),
      });
      expect(res1.status).toBe(200);
      const data1 = await jsonBody(res1);
      expect(data1.replayed).toBe(false);

      // 2. Replay with exact same clientRequestId and prompt
      const res2 = await fetch(`${baseUrl}/api/v1/sessions/sess-idem/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Initial command', clientRequestId: 'req-unique-123' }),
      });
      expect(res2.status).toBe(200);
      const data2 = await jsonBody(res2);
      expect(data2.replayed).toBe(true);
      expect(data2.turnId).toBe(data1.turnId);

      // 3. Reusing clientRequestId with different prompt returns 409 Conflict
      const res3 = await fetch(`${baseUrl}/api/v1/sessions/sess-idem/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Different command text', clientRequestId: 'req-unique-123' }),
      });
      expect(res3.status).toBe(409);
      const data3 = await jsonBody(res3);
      expect(data3.error.code).toBe('conflict');
      expect(data3.error.message).toContain('was already used with a different prompt');
    });

    it('blocks second prompt while a turn is already open and working', async () => {
      await repositories.sessions.save(mockSession('sess-busy', { status: 'idle' }));

      const { baseUrl } = await createAndStartServer();

      // 1. First prompt opens turn
      const res1 = await fetch(`${baseUrl}/api/v1/sessions/sess-busy/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'First turn', clientRequestId: 'req-busy-1' }),
      });
      expect(res1.status).toBe(200);

      // 2. Second prompt while first turn is still working
      const res2 = await fetch(`${baseUrl}/api/v1/sessions/sess-busy/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Second turn prematurely', clientRequestId: 'req-busy-2' }),
      });
      expect(res2.status).toBe(409);
      const data2 = await jsonBody(res2);
      expect(data2.error.code).toBe('conflict');
      expect(data2.error.message).toContain('already has an open turn');
    });

    it('requires a non-empty clientRequestId (400 invalid_request if missing or empty)', async () => {
      await repositories.sessions.save(mockSession('sess-missing-id', { status: 'idle' }));

      const { baseUrl } = await createAndStartServer();

      // Missing clientRequestId
      const resMissing = await fetch(`${baseUrl}/api/v1/sessions/sess-missing-id/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Hello without id' }),
      });
      expect(resMissing.status).toBe(400);
      const dataMissing = await jsonBody(resMissing);
      expect(dataMissing.error.code).toBe('invalid_request');
      expect(dataMissing.error.message).toContain('clientRequestId is required');

      // Whitespace-only clientRequestId
      const resEmpty = await fetch(`${baseUrl}/api/v1/sessions/sess-missing-id/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Hello with blank id', clientRequestId: '   ' }),
      });
      expect(resEmpty.status).toBe(400);
      const dataEmpty = await jsonBody(resEmpty);
      expect(dataEmpty.error.code).toBe('invalid_request');
      expect(dataEmpty.error.message).toContain('clientRequestId is required');
    });

    it('bounds clientRequestId length to 128 characters (400 invalid_request if exceeded)', async () => {
      await repositories.sessions.save(mockSession('sess-bound-id', { status: 'idle' }));

      const { baseUrl } = await createAndStartServer();

      // Exceeds 128 chars (129 chars)
      const longId = 'a'.repeat(129);
      const resTooLong = await fetch(`${baseUrl}/api/v1/sessions/sess-bound-id/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Valid prompt', clientRequestId: longId }),
      });
      expect(resTooLong.status).toBe(400);
      const dataTooLong = await jsonBody(resTooLong);
      expect(dataTooLong.error.code).toBe('invalid_request');
      expect(dataTooLong.error.message).toContain('clientRequestId must be 128 characters or fewer');

      // Exactly 128 chars succeeds
      const exactId = 'b'.repeat(128);
      const resExact = await fetch(`${baseUrl}/api/v1/sessions/sess-bound-id/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Valid prompt', clientRequestId: exactId }),
      });
      expect(resExact.status).toBe(200);
      const dataExact = await jsonBody(resExact);
      expect(dataExact.delivered).toBe(true);
    });

    it('rejects non-object JSON bodies with 400 invalid_request', async () => {
      await repositories.sessions.save(mockSession('sess-non-obj', { status: 'idle' }));

      const { baseUrl } = await createAndStartServer();

      // null body
      const resNull = await fetch(`${baseUrl}/api/v1/sessions/sess-non-obj/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: 'null',
      });
      expect(resNull.status).toBe(400);
      const dataNull = await jsonBody(resNull);
      expect(dataNull.error.code).toBe('invalid_request');
      expect(dataNull.error.message).toContain('JSON object');

      // Array body
      const resArray = await fetch(`${baseUrl}/api/v1/sessions/sess-non-obj/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['not', 'an', 'object']),
      });
      expect(resArray.status).toBe(400);
      const dataArray = await jsonBody(resArray);
      expect(dataArray.error.code).toBe('invalid_request');
      expect(dataArray.error.message).toContain('JSON object');

      // Primitive string body
      const resStr = await fetch(`${baseUrl}/api/v1/sessions/sess-non-obj/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify('plain-string'),
      });
      expect(resStr.status).toBe(400);
      const dataStr = await jsonBody(resStr);
      expect(dataStr.error.code).toBe('invalid_request');
      expect(dataStr.error.message).toContain('JSON object');
    });

    it('returns status "unknown" and delivered false when prompt submission is uncertain', async () => {
      await repositories.sessions.save(mockSession('sess-uncertain', { status: 'idle' }));
      sessionManager.sendPrompt.mockRejectedValueOnce(new PromptSubmissionError('tmux'));

      const { baseUrl } = await createAndStartServer();
      const res = await fetch(`${baseUrl}/api/v1/sessions/sess-uncertain/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Uncertain delivery', clientRequestId: 'req-uncert-delivery' }),
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.delivered).toBe(false);
      expect(data.status).toBe('unknown');
      expect(data.message).toContain('do not resend the prompt');
    });

    it('decodes request bodies cleanly when multibyte UTF-8 characters span chunk boundaries', async () => {
      await repositories.sessions.save(mockSession('sess-utf8', { status: 'idle' }));

      const { port } = await createAndStartServer();

      // 'café' in UTF-8: 'caf' (3 bytes: 0x63, 0x61, 0x66) + 'é' (2 bytes: 0xc3, 0xa9)
      const part1 = Buffer.concat([
        Buffer.from('{"clientRequestId":"req-utf8","message":"caf'),
        Buffer.from([0xc3]),
      ]);
      const part2 = Buffer.concat([
        Buffer.from([0xa9]),
        Buffer.from('"}'),
      ]);

      const postResult = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/v1/sessions/sess-utf8/message',
            method: 'POST',
            headers: {
              Authorization: `Bearer ${rawSecretKey}`,
              'Content-Type': 'application/json',
              'Content-Length': part1.length + part2.length,
            },
          },
          (res) => {
            let resData = '';
            res.on('data', (c) => { resData += c; });
            res.on('end', () => {
              resolve({ status: res.statusCode || 0, body: resData });
            });
          }
        );
        req.on('error', reject);
        req.write(part1);
        req.write(part2);
        req.end();
      });

      expect(postResult.status).toBe(200);
      const parsed = JSON.parse(postResult.body);
      expect(parsed.delivered).toBe(true);
      expect(sessionManager.sendPrompt).toHaveBeenCalledWith('sess-utf8', 'café');
    });
  });

  describe('No Persistence: Unavailable After Restart', () => {
    it('reports disconnected sessions as unavailable output after restart, never as live', async () => {
      // Simulate session after restart: status is 'disconnected'
      await repositories.sessions.save(mockSession('sess-restarted', { status: 'disconnected' }));

      const { baseUrl } = await createAndStartServer();

      // 1. Session detail reports disconnected, never live
      const detailRes = await fetch(`${baseUrl}/api/v1/sessions/sess-restarted`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(detailRes.status).toBe(200);
      const detail = await jsonBody(detailRes);
      expect(detail.session.status).toBe('disconnected');

      // 2. Output reports unavailable, never live
      const outputRes = await fetch(`${baseUrl}/api/v1/sessions/sess-restarted/output`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(outputRes.status).toBe(200);
      const outputData = await jsonBody(outputRes);
      expect(outputData.available).toBe(false);
      expect(outputData.status).toBe('unavailable');
      expect(outputData.output).toBe(null);
      expect(sessionManager.captureSessionTerminal).not.toHaveBeenCalled();
    });

    it('reports screen history as unavailable after restart, while transcript history remains available', async () => {
      // 1. Session without agent files (screen history fallback) after restart
      await repositories.sessions.save(mockSession('sess-screen-only', { status: 'disconnected' }));
      sessionManager.getSessionHistory.mockResolvedValueOnce({
        sessionId: 'sess-screen-only',
        source: 'screen',
        items: [],
        hasMore: false,
      });

      const { baseUrl } = await createAndStartServer();
      const screenRes = await fetch(`${baseUrl}/api/v1/sessions/sess-screen-only/history`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(screenRes.status).toBe(200);
      const screenData = await jsonBody(screenRes);
      expect(screenData.available).toBe(false);
      expect(screenData.source).toBe('screen');
      expect(screenData.items).toEqual([]);

      // 2. Session with agent transcript files (Claude or Codex transcript) after restart
      await repositories.sessions.save(mockSession('sess-transcript', { status: 'disconnected' }));
      sessionManager.getSessionHistory.mockResolvedValueOnce({
        sessionId: 'sess-transcript',
        source: 'transcript',
        items: [
          { id: '1', role: 'user', text: 'Persistent user prompt', source: 'transcript' },
          { id: '2', role: 'agent', text: 'Persistent agent response', source: 'transcript' },
        ],
        cursor: 'offset:1024',
        hasMore: false,
      });

      const transcriptRes = await fetch(`${baseUrl}/api/v1/sessions/sess-transcript/history`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(transcriptRes.status).toBe(200);
      const transcriptData = await jsonBody(transcriptRes);
      expect(transcriptData.available).toBe(true);
      expect(transcriptData.source).toBe('transcript');
      expect(transcriptData.freshness).toBe('historical');
      expect(transcriptData.stale).toBe(true);
      expect(transcriptData.stored).toBe(false);
      expect(transcriptData.items).toHaveLength(2);
      expect(transcriptData.items[0].text).toBe('Persistent user prompt');
    });

    it('reports honest freshness and stale metadata on transcript /history for done, disconnected, and live sessions', async () => {
      await repositories.sessions.save(mockSession('sess-done-tx', { status: 'done' }));
      await repositories.sessions.save(mockSession('sess-live-tx', { status: 'working' }));

      sessionManager.getSessionHistory.mockImplementation(async (sessionId: string) => ({
        sessionId,
        source: 'transcript',
        items: [{ id: `${sessionId}-1`, role: 'agent', text: 'Transcript message', source: 'transcript' }],
        cursor: 'offset:64',
        hasMore: false,
      }));

      const { baseUrl } = await createAndStartServer();

      const doneRes = await fetch(`${baseUrl}/api/v1/sessions/sess-done-tx/history`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      const doneData = await jsonBody(doneRes);
      expect(doneData.available).toBe(true);
      expect(doneData.source).toBe('transcript');
      expect(doneData.freshness).toBe('historical');
      expect(doneData.stale).toBe(true);
      expect(doneData.stored).toBe(false);

      const liveRes = await fetch(`${baseUrl}/api/v1/sessions/sess-live-tx/history`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      const liveData = await jsonBody(liveRes);
      expect(liveData.available).toBe(true);
      expect(liveData.source).toBe('transcript');
      expect(liveData.freshness).toBe('live');
      expect(liveData.stale).toBe(false);
      expect(liveData.stored).toBe(false);
    });

    it('keeps successful empty screen history pages from live sessions available', async () => {
      await repositories.sessions.save(mockSession('sess-live-empty-screen', { status: 'idle' }));
      sessionManager.getSessionHistory.mockResolvedValueOnce({
        sessionId: 'sess-live-empty-screen',
        source: 'screen',
        items: [],
        cursor: 'line:10:fp:abc',
        hasMore: false,
        captureSuccess: true,
      });

      const { baseUrl } = await createAndStartServer();
      const res = await fetch(`${baseUrl}/api/v1/sessions/sess-live-empty-screen/history?cursor=line:10:fp:abc`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.available).toBe(true);
      expect(data.source).toBe('screen');
      expect(data.items).toEqual([]);
      expect(data.hasMore).toBe(false);
    });

    it('reports screen history as unavailable when terminal capture fails (captureSuccess is false) even if session is live', async () => {
      await repositories.sessions.save(mockSession('sess-live-capture-failed', { status: 'idle' }));
      sessionManager.getSessionHistory.mockResolvedValueOnce({
        sessionId: 'sess-live-capture-failed',
        source: 'screen',
        items: [],
        cursor: 'line:0',
        hasMore: false,
        captureSuccess: false,
      });

      const { baseUrl } = await createAndStartServer();
      const res = await fetch(`${baseUrl}/api/v1/sessions/sess-live-capture-failed/history`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.available).toBe(false);
      expect(data.source).toBe('screen');
      expect(data.items).toEqual([]);
      expect(data.hasMore).toBe(false);
      expect(data.message).toContain('terminal capture failed');
    });
  });

  describe('Limits & Rate Limiting', () => {
    it('returns 413 Payload Too Large when request body exceeds maximum size', async () => {
      await repositories.sessions.save(mockSession('sess-big', { status: 'idle' }));

      // Set maxBodyBytes to small value (1 KiB) for testing
      const { baseUrl } = await createAndStartServer({}, { maxBodyBytes: 1024 });

      const oversizedBody = JSON.stringify({ message: 'A'.repeat(2048) });
      const res = await fetch(`${baseUrl}/api/v1/sessions/sess-big/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: oversizedBody,
      });

      expect(res.status).toBe(413);
      const data = await jsonBody(res);
      expect(data.error.code).toBe('payload_too_large');
    });

    it('sends 413 JSON response on oversized chunked bodies without Content-Length before closing connection', async () => {
      await repositories.sessions.save(mockSession('sess-chunked-big', { status: 'idle' }));

      const { port } = await createAndStartServer({}, { maxBodyBytes: 1024 });

      const res = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/v1/sessions/sess-chunked-big/message',
            method: 'POST',
            headers: {
              Authorization: `Bearer ${rawSecretKey}`,
              'Content-Type': 'application/json',
              'Transfer-Encoding': 'chunked',
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              resolve({
                statusCode: res.statusCode || 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
              });
            });
          }
        );
        req.on('error', reject);

        // Write a chunk larger than maxBodyBytes (1024 bytes) without declaring Content-Length
        req.write(JSON.stringify({ prompt: 'B'.repeat(2048) }));
        req.end();
      });

      expect(res.statusCode).toBe(413);
      expect(res.headers['connection']).toBe('close');
      const data = JSON.parse(res.body);
      expect(data.apiVersion).toBe('v1');
      expect(data.error.code).toBe('payload_too_large');
      expect(data.error.message).toContain('1024 bytes');
    });

    it('enforces separate authenticated rate limit sized for polling and returns 429 with Retry-After header', async () => {
      // Configure authenticated rate limit of 3 requests per 60s
      const { baseUrl } = await createAndStartServer({}, {
        authenticatedRateLimitMax: 3,
        rateLimitWindowMs: 60_000,
      });

      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${baseUrl}/api/v1/sessions`, {
          headers: { Authorization: `Bearer ${rawSecretKey}` },
        });
        expect(res.status).toBe(200);
      }

      // 4th request exceeds authenticated rate limit
      const rateLimitedRes = await fetch(`${baseUrl}/api/v1/sessions`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(rateLimitedRes.status).toBe(429);
      expect(rateLimitedRes.headers.get('Retry-After')).toBeDefined();
      const data = await jsonBody(rateLimitedRes);
      expect(data.error.code).toBe('rate_limited');
    });

    it('enforces strict failed auth rate limit checked before Argon2 and does not lock out authenticated client', async () => {
      // Configure strict failed auth limit of 2 requests per 60s
      const { baseUrl } = await createAndStartServer({}, {
        failedAuthRateLimitMax: 2,
        rateLimitWindowMs: 60_000,
      });

      // 2 failed attempts
      const fail1 = await fetch(`${baseUrl}/api/v1/sessions`, {
        headers: { Authorization: 'Bearer bad-key-1' },
      });
      expect(fail1.status).toBe(401);

      const fail2 = await fetch(`${baseUrl}/api/v1/sessions`, {
        headers: { Authorization: 'Bearer bad-key-2' },
      });
      expect(fail2.status).toBe(401);

      // 3rd unauthenticated attempt is blocked by failed-auth limiter with 429
      const fail3 = await fetch(`${baseUrl}/api/v1/sessions`, {
        headers: { Authorization: 'Bearer bad-key-3' },
      });
      expect(fail3.status).toBe(429);
      expect(fail3.headers.get('Retry-After')).toBeDefined();
      const failData = await jsonBody(fail3);
      expect(failData.error.code).toBe('rate_limited');
    });
  });

  describe('Persisted Snapshot Fallback & Honest Freshness Metadata', () => {
    it('exposes lastOutput additively on /output after restart without masquerading as live, and preserves legacy unavailable shape', async () => {
      await repositories.sessions.save(mockSession('sess-persisted-out', { status: 'disconnected' }));
      const snapshot = await repositories.sessionHistory!.upsertSnapshot({
        sessionId: 'sess-persisted-out',
        output: 'build finished with 0 warnings',
        items: [{ id: 'i1', role: 'agent', text: 'Done building', source: 'screen' }],
        capturedAt: Date.now() - 5_000,
      });

      const { baseUrl } = await createAndStartServer();
      const res = await fetch(`${baseUrl}/api/v1/sessions/sess-persisted-out/output`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      expect(res.status).toBe(200);
      const data = await jsonBody(res);
      expect(data.available).toBe(false);
      expect(data.status).toBe('unavailable');
      expect(data.output).toBe(null);
      expect(data.freshness).toBe('historical');
      expect(data.stale).toBe(true);
      expect(data.stored).toBe(true);
      expect(data.version).toBe(snapshot.version);
      expect(data.lastOutput).toEqual({
        output: 'build finished with 0 warnings',
        updatedAt: new Date(snapshot.updatedAt).toISOString(),
        capturedAt: new Date(snapshot.capturedAt).toISOString(),
        stale: true,
        truncated: false,
        version: snapshot.version,
      });
    });

    it('exposes storedItems and explicit pagination/restarted/invalid/eof cursors on /history while keeping items empty for disconnected screen sessions', async () => {
      await repositories.sessions.save(mockSession('sess-persisted-hist', { status: 'disconnected' }));
      await repositories.sessionHistory!.upsertSnapshot({
        sessionId: 'sess-persisted-hist',
        output: '› cmd 1\nans 1\n› cmd 2\nans 2',
        items: [
          { id: 's1', role: 'user', text: 'cmd 1', source: 'screen' },
          { id: 's2', role: 'agent', text: 'ans 1', source: 'screen' },
          { id: 's3', role: 'user', text: 'cmd 2', source: 'screen' },
        ],
      });
      sessionManager.getSessionHistory.mockResolvedValue({
        sessionId: 'sess-persisted-hist',
        source: 'screen',
        items: [],
        cursor: 'line:0',
        hasMore: false,
        captureSuccess: false,
      });

      const { baseUrl } = await createAndStartServer();

      const page1Res = await fetch(`${baseUrl}/api/v1/sessions/sess-persisted-hist/history?limit=2`, {
        headers: { Authorization: `Bearer ${rawSecretKey}` },
      });
      const page1 = await jsonBody(page1Res);
      expect(page1.available).toBe(false);
      expect(page1.source).toBe('screen');
      expect(page1.items).toEqual([]);
      expect(page1.hasMore).toBe(false);
      expect(page1.freshness).toBe('historical');
      expect(page1.stale).toBe(true);
      expect(page1.stored).toBe(true);
      expect(page1.storedItems.map((i: any) => i.id)).toEqual(['s1', 's2']);
      expect(page1.storedHasMore).toBe(true);
      expect(page1.cursorStatus).toBe('initial');
      expect(page1.cursorExpired).toBe(false);

      const page2Res = await fetch(
        `${baseUrl}/api/v1/sessions/sess-persisted-hist/history?limit=2&cursor=${encodeURIComponent(page1.cursor)}`,
        { headers: { Authorization: `Bearer ${rawSecretKey}` } }
      );
      const page2 = await jsonBody(page2Res);
      expect(page2.storedItems.map((i: any) => i.id)).toEqual(['s3']);
      expect(page2.storedHasMore).toBe(false);
      expect(page2.cursorStatus).toBe('valid');
      expect(page2.cursorExpired).toBe(false);

      const eofRes = await fetch(
        `${baseUrl}/api/v1/sessions/sess-persisted-hist/history?limit=2&cursor=${encodeURIComponent(page2.cursor)}`,
        { headers: { Authorization: `Bearer ${rawSecretKey}` } }
      );
      const eof = await jsonBody(eofRes);
      expect(eof.storedItems).toEqual([]);
      expect(eof.cursorStatus).toBe('eof');
      expect(eof.cursorExpired).toBe(false);

      const restartedRes = await fetch(
        `${baseUrl}/api/v1/sessions/sess-persisted-hist/history?cursor=${encodeURIComponent('line:3:fp:deadbeef')}`,
        { headers: { Authorization: `Bearer ${rawSecretKey}` } }
      );
      const restarted = await jsonBody(restartedRes);
      expect(restarted.storedItems).toEqual([]);
      expect(restarted.cursorStatus).toBe('restarted');
      expect(restarted.cursorExpired).toBe(true);

      const invalidRes = await fetch(
        `${baseUrl}/api/v1/sessions/sess-persisted-hist/history?cursor=malformed`,
        { headers: { Authorization: `Bearer ${rawSecretKey}` } }
      );
      const invalid = await jsonBody(invalidRes);
      expect(invalid.cursorStatus).toBe('invalid');
      expect(invalid.cursorExpired).toBe(true);

      // Foreign-session cursor with matching version=1 must report mismatched, never eof
      await repositories.sessions.save(mockSession('sess-other-v1', { status: 'disconnected' }));
      await repositories.sessionHistory!.upsertSnapshot({
        sessionId: 'sess-other-v1',
        output: 'other screen',
        items: [{ id: 'o1', role: 'user', text: 'other 1', source: 'screen' }],
      });
      await repositories.sessions.save(mockSession('sess-other-empty', { status: 'disconnected' }));

      const foreignWithSnapshotRes = await fetch(
        `${baseUrl}/api/v1/sessions/sess-other-v1/history?limit=2&cursor=${encodeURIComponent(page2.cursor)}`,
        { headers: { Authorization: `Bearer ${rawSecretKey}` } }
      );
      const foreignWithSnapshot = await jsonBody(foreignWithSnapshotRes);
      expect(foreignWithSnapshot.storedItems).toEqual([]);
      expect(foreignWithSnapshot.cursorStatus).toBe('mismatched');
      expect(foreignWithSnapshot.cursorExpired).toBe(true);

      const foreignNoSnapshotRes = await fetch(
        `${baseUrl}/api/v1/sessions/sess-other-empty/history?limit=2&cursor=${encodeURIComponent(page1.cursor)}`,
        { headers: { Authorization: `Bearer ${rawSecretKey}` } }
      );
      const foreignNoSnapshot = await jsonBody(foreignNoSnapshotRes);
      expect(foreignNoSnapshot.storedItems).toEqual([]);
      expect(foreignNoSnapshot.cursorStatus).toBe('mismatched');
      expect(foreignNoSnapshot.cursorExpired).toBe(true);

      // Pruned and recreated snapshot on same session resets version=1 but mints a new snapshotGeneration
      await repositories.sessionHistory!.pruneExpiredAndExcess(Date.now() + 8 * 24 * 60 * 60 * 1000);
      await repositories.sessionHistory!.upsertSnapshot({
        sessionId: 'sess-persisted-hist',
        output: 'recreated screen',
        items: [{ id: 'r1', role: 'user', text: 'recreated', source: 'screen' }],
      });

      const recreatedStaleRes = await fetch(
        `${baseUrl}/api/v1/sessions/sess-persisted-hist/history?limit=2&cursor=${encodeURIComponent(page1.cursor)}`,
        { headers: { Authorization: `Bearer ${rawSecretKey}` } }
      );
      const recreatedStale = await jsonBody(recreatedStaleRes);
      expect(recreatedStale.storedItems).toEqual([]);
      expect(recreatedStale.cursorStatus).toBe('expired');
      expect(recreatedStale.cursorExpired).toBe(true);
    });

    it('reports DB snapshot read errors honestly on unavailable /output and /history', async () => {
      await repositories.sessions.save(mockSession('sess-db-err', { status: 'disconnected' }));
      sessionManager.getSessionHistory.mockResolvedValue({
        sessionId: 'sess-db-err',
        source: 'screen',
        items: [],
        hasMore: false,
        captureSuccess: false,
      });
      const spy = vi.spyOn(repositories.sessionHistory!, 'findSnapshotBySessionId').mockRejectedValue(
        new Error('SQLITE_BUSY')
      );

      try {
        const { baseUrl } = await createAndStartServer();
        const outRes = await fetch(`${baseUrl}/api/v1/sessions/sess-db-err/output`, {
          headers: { Authorization: `Bearer ${rawSecretKey}` },
        });
        const outData = await jsonBody(outRes);
        expect(outData.available).toBe(false);
        expect(outData.lastOutput).toBe(null);
        expect(outData.message).toContain('Retained snapshot lookup failed');

        const histRes = await fetch(`${baseUrl}/api/v1/sessions/sess-db-err/history`, {
          headers: { Authorization: `Bearer ${rawSecretKey}` },
        });
        const histData = await jsonBody(histRes);
        expect(histData.available).toBe(false);
        expect(histData.stored).toBe(false);
        expect(histData.message).toContain('Retained snapshot lookup failed');
      } finally {
        spy.mockRestore();
      }
    });

    it('propagates transcript reader cursor resets (invalid, mismatched, expired, eof) over HTTP /history', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnea-mobile-cursor-'));
      try {
        // 1. Claude transcript session
        const claudeReader = new ClaudeHistoryReader();
        const claudeWorktree = '/ws/cursor-claude';
        const claudeDir = path.join(tempRoot, '.claude', 'projects', encodeClaudeProjectPath(claudeWorktree));
        fs.mkdirSync(claudeDir, { recursive: true });
        const claudeFile = path.join(claudeDir, 'sess-tr-claude.jsonl');
        fs.writeFileSync(
          claudeFile,
          [
            JSON.stringify({ type: 'user', uuid: 'cu1', message: { role: 'user', content: 'Claude Q1' } }),
            JSON.stringify({ type: 'assistant', uuid: 'ca1', message: { role: 'assistant', stop_reason: 'end_turn', content: 'Claude A1' } }),
            JSON.stringify({ type: 'user', uuid: 'cu2', message: { role: 'user', content: 'Claude Q2' } }),
            JSON.stringify({ type: 'assistant', uuid: 'ca2', message: { role: 'assistant', stop_reason: 'end_turn', content: 'Claude A2' } }),
          ].join('\n') + '\n'
        );

        // 2. Codex transcript session
        const codexReader = new CodexHistoryReader();
        const codexFile = path.join(tempRoot, 'rollout-cursor.jsonl');
        fs.writeFileSync(
          codexFile,
          [
            JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'Codex Q1' } }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Codex A1' } }),
          ].join('\n') + '\n'
        );

        await repositories.sessions.save(mockSession('sess-tr-claude', { status: 'working' }));
        await repositories.sessions.save(mockSession('sess-tr-codex', { status: 'working' }));

        sessionManager.getSessionHistory.mockImplementation(async (sessionId: string, query?: SessionHistoryQuery) => {
          if (sessionId === 'sess-tr-claude') {
            return (
              await claudeReader.readHistory(
                {
                  sessionId,
                  harness: 'claude',
                  worktreePath: claudeWorktree,
                  isLocal: true,
                  agentSessionId: 'sess-tr-claude',
                  homeDir: tempRoot,
                },
                query
              )
            )!;
          }
          return (
            await codexReader.readHistory(
              {
                sessionId,
                harness: 'codex',
                worktreePath: '/ws/cursor-codex',
                isLocal: true,
                resolvedTranscriptPath: codexFile,
              },
              query
            )
          )!;
        });

        const { baseUrl } = await createAndStartServer();

        // Claude initial -> forward valid paging -> eof -> invalid -> replaced mismatched
        const cInit = await jsonBody(
          await fetch(`${baseUrl}/api/v1/sessions/sess-tr-claude/history?limit=10`, {
            headers: { Authorization: `Bearer ${rawSecretKey}` },
          })
        );
        expect(cInit.cursorStatus).toBe('initial');
        expect(cInit.cursorExpired).toBe(false);
        expect(cInit.hasMore).toBe(false);
        expect(cInit.items).toHaveLength(4);

        const cPage1 = await jsonBody(
          await fetch(`${baseUrl}/api/v1/sessions/sess-tr-claude/history?limit=2&cursor=${encodeURIComponent('offset:0')}`, {
            headers: { Authorization: `Bearer ${rawSecretKey}` },
          })
        );
        expect(cPage1.cursorStatus).toBe('valid');
        expect(cPage1.cursorExpired).toBe(false);
        expect(cPage1.hasMore).toBe(true);
        expect(cPage1.items).toHaveLength(2);

        const cPage2 = await jsonBody(
          await fetch(`${baseUrl}/api/v1/sessions/sess-tr-claude/history?limit=10&cursor=${encodeURIComponent(cPage1.cursor)}`, {
            headers: { Authorization: `Bearer ${rawSecretKey}` },
          })
        );
        expect(cPage2.cursorStatus).toBe('valid');
        expect(cPage2.cursorExpired).toBe(false);
        expect(cPage2.hasMore).toBe(false);
        expect(cPage2.items).toHaveLength(2);

        const cEof = await jsonBody(
          await fetch(`${baseUrl}/api/v1/sessions/sess-tr-claude/history?limit=10&cursor=${encodeURIComponent(cPage2.cursor)}`, {
            headers: { Authorization: `Bearer ${rawSecretKey}` },
          })
        );
        expect(cEof.cursorStatus).toBe('eof');
        expect(cEof.cursorExpired).toBe(false);

        const cInvalid = await jsonBody(
          await fetch(`${baseUrl}/api/v1/sessions/sess-tr-claude/history?cursor=${encodeURIComponent('not-a-cursor')}`, {
            headers: { Authorization: `Bearer ${rawSecretKey}` },
          })
        );
        expect(cInvalid.cursorStatus).toBe('invalid');
        expect(cInvalid.cursorExpired).toBe(true);
        expect(cInvalid.items).toHaveLength(4);

        fs.writeFileSync(
          claudeFile,
          JSON.stringify({ type: 'user', uuid: 'cu-rep', message: { role: 'user', content: 'Replaced Claude Q' } }) + '\n'
        );
        const cMismatched = await jsonBody(
          await fetch(`${baseUrl}/api/v1/sessions/sess-tr-claude/history?cursor=${encodeURIComponent(cPage2.cursor)}`, {
            headers: { Authorization: `Bearer ${rawSecretKey}` },
          })
        );
        expect(cMismatched.cursorStatus).toBe('mismatched');
        expect(cMismatched.cursorExpired).toBe(true);
        expect(cMismatched.items[0].text).toBe('Replaced Claude Q');

        // Codex expired past EOF over HTTP
        const xExpired = await jsonBody(
          await fetch(`${baseUrl}/api/v1/sessions/sess-tr-codex/history?cursor=${encodeURIComponent('offset:999999')}`, {
            headers: { Authorization: `Bearer ${rawSecretKey}` },
          })
        );
        expect(xExpired.cursorStatus).toBe('expired');
        expect(xExpired.cursorExpired).toBe(true);
        expect(xExpired.items).toHaveLength(2);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });
});
