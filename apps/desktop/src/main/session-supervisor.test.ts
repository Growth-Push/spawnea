import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, createRepositories, type Repositories } from '@spawnea/db';
import { MockHostAdapter } from '@spawnea/hosts';
import { CatalogManager } from './catalog-manager.js';
import { SessionContextStore } from './session-context-store.js';
import { PtyBroker } from './pty-broker.js';
import { SessionManager } from './session-manager.js';
import { SessionSupervisor } from './session-supervisor.js';
import type { WebContents } from 'electron';

describe('SessionSupervisor', () => {
  let tempDir: string;
  let repos: Repositories;
  let dbConn: ReturnType<typeof createDatabase>;
  let catManager: CatalogManager;
  let contextStore: SessionContextStore;
  let ptyBroker: PtyBroker;
  let sessionManager: SessionManager;
  let supervisor: SessionSupervisor;
  let mockHost: MockHostAdapter;
  let mockWebContents: WebContents;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'spawnea-test-sup-'));
    dbConn = createDatabase({ path: ':memory:', migrate: true });
    repos = createRepositories(dbConn.db);
    catManager = new CatalogManager();
    contextStore = new SessionContextStore({ storeDir: join(tempDir, 'sessions') });
    ptyBroker = new PtyBroker();
    mockHost = new MockHostAdapter('dev-workstation', ['/workspace/spawnea']);

    await repos.servers.save({
      id: 'dev-workstation',
      name: 'Development Workstation',
      host: 'example-host',
      sshPort: 22,
      enabled: true,
    });

    await repos.projects.save({
      id: 'dev-workstation:spawnea',
      serverId: 'dev-workstation',
      name: 'Spawnea',
      rootPath: '/workspace/spawnea',
    });

    await repos.agents.save({
      id: 'dev-workstation:claude',
      name: 'Claude Code',
      harness: 'claude',
      command: 'claude',
    });

    sessionManager = new SessionManager({
      repositories: repos,
      catalogManager: catManager,
      contextStore,
      ptyBroker,
      hostAdapterFactory: async (_serverId) => mockHost,
    });

    supervisor = new SessionSupervisor({
      repositories: repos,
      sessionManager,
      contextStore,
      ptyBroker,
    });

    mockWebContents = {
      isDestroyed: () => false,
      send: vi.fn(),
    } as unknown as WebContents;

    supervisor.setWebContentsGetter(() => mockWebContents);
  });

  afterEach(async () => {
    supervisor.stopPolling();
    dbConn.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('detects needs_input on prompt pattern in capture-pane tail and broadcasts IPC event', async () => {
    // 1. Create a session
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Refactor state detector',
    });

    // 2. Configure mock host to return prompt in capture-pane
    mockHost.customRules.push({
      pattern: 'tmux list-panes -t',
      response: {
        stdout: '9999:::claude:::0\n',
        stderr: '',
        exitCode: 0,
      },
    });

    mockHost.customRules.push({
      pattern: 'tmux capture-pane',
      response: {
        stdout: 'Thinking...\nDo you want to run `npm test`? [y/N]',
        stderr: '',
        exitCode: 0,
      },
    });

    // 3. Run check
    const result = await supervisor.checkSession(session.id);
    expect(result.status).toBe('needs_input');
    expect(result.source).toBe('terminal_prompt');
    expect(result.detectedPrompt).toContain('Do you want to run `npm test`? [y/N]');

    // 4. Verify DB and context file updated
    const updated = await repos.sessions.findById(session.id);
    expect(updated?.status).toBe('needs_input');

    // 5. Verify IPC event broadcasted
    expect(mockWebContents.send).toHaveBeenCalledWith(
      'session:statusChanged',
      session.id,
      'needs_input',
      expect.objectContaining({ status: 'needs_input' })
    );
  });

  it('detects working when active PTY stream activity is received', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Build project',
    });

    // Register PTY channel
    let dataCb: (d: string) => void = () => {};
    ptyBroker.registerPty(
      `pty-${session.id}`,
      {
        id: `pty-${session.id}`,
        onData: (cb) => {
          dataCb = cb;
          return () => {};
        },
        onExit: () => () => {},
        write: vi.fn(),
        resize: vi.fn(),
        close: vi.fn(),
      },
      mockWebContents
    );

    // Send data
    dataCb('Transpiling packages/state...\n');

    mockHost.customRules.push({
      pattern: 'tmux list-panes -t',
      response: {
        stdout: '9999:::claude:::0\n',
        stderr: '',
        exitCode: 0,
      },
    });

    const result = await supervisor.checkSession(session.id);
    expect(result.status).toBe('working');
    expect(result.source).toBe('pty_activity');
  });

  it('supports configurable periodic check interval (defaults to 10s)', () => {
    const customSupervisor = new SessionSupervisor({
      repositories: repos,
      sessionManager,
      contextStore,
      ptyBroker,
      pollIntervalMs: 5000,
    });

    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    customSupervisor.startPolling();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    customSupervisor.stopPolling();

    // Default supervisor uses 10000ms
    supervisor.startPolling();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10000);
    supervisor.stopPolling();
    setIntervalSpy.mockRestore();
  });
});
