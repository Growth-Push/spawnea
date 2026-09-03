import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, createRepositories, type Repositories } from '@spawnea/db';
import { MockHostAdapter, OnePasswordResolver } from '@spawnea/hosts';
import {
  createCatalogProjectPathLocator,
  createCatalogWorktreePathLocator,
  registerSensitiveValue,
  SecretResolutionError,
} from '@spawnea/domain';
import { CatalogManager } from './catalog-manager.js';
import { SessionContextStore } from './session-context-store.js';
import { PtyBroker } from './pty-broker.js';
import { SessionManager } from './session-manager.js';

describe('SessionManager', () => {
  let tempDir: string;
  let repos: Repositories;
  let dbConn: ReturnType<typeof createDatabase>;
  let catManager: CatalogManager;
  let contextStore: SessionContextStore;
  let ptyBroker: PtyBroker;
  let sessionManager: SessionManager;
  let mockHost: MockHostAdapter;

  async function enableManagedWorktrees(): Promise<void> {
    const catalogPath = join(tempDir, 'spawnea.yaml');
    writeFileSync(catalogPath, `
version: 1
hosts:
  dev-workstation:
    name: Development Workstation
    enabled: true
    projects:
      spawnea:
        name: Spawnea
        path: /workspace/spawnea
        worktree:
          enabled: true
          copy_files: []
        enabled: true
    harnesses:
      claude:
        name: Claude Code
        command: claude
        args: []
        enabled: true
`);
    catManager = new CatalogManager({ catalogPath });
    expect(catManager.load().errors).toBeNull();
    sessionManager = new SessionManager({
      repositories: repos,
      catalogManager: catManager,
      contextStore,
      ptyBroker,
      hostAdapterFactory: async () => mockHost,
    });

    mockHost.customRules.push({
      pattern: 'git rev-parse --show-toplevel',
      response: (_command, options) => ({
        stdout: `${options?.cwd || '/workspace/spawnea'}\n`,
        stderr: '',
        exitCode: 0,
      }),
    });
    mockHost.customRules.push({
      pattern: /git rev-parse '[^']+\^\{commit\}'/,
      response: () => ({
        stdout: '0123456789abcdef0123456789abcdef01234567\n',
        stderr: '',
        exitCode: 0,
      }),
    });
    mockHost.customRules.push({
      pattern: 'git branch --show-current',
      response: (_command, options) => {
        const cwd = options?.cwd || '';
        const leaf = cwd.split('/').pop() || '';
        return {
          stdout: cwd.includes('__worktrees/') ? `spawnea/${leaf}\n` : 'main\n',
          stderr: '',
          exitCode: 0,
        };
      },
    });
    const trackedWorktrees = new Map<string, string>();
    const trackedBranches = new Set<string>(['main']);
    mockHost.customRules.push({
      pattern: 'git worktree add -b',
      response: (command) => {
        const parts = command.match(/git worktree add -b '([^']+)' '([^']+)'/);
        if (parts) {
          trackedWorktrees.set(parts[2], parts[1]);
          trackedBranches.add(parts[1]);
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    mockHost.customRules.push({
      pattern: 'git worktree list --porcelain',
      response: () => {
        let out = 'worktree /workspace/spawnea\nbranch refs/heads/main\n\n';
        for (const [wtPath, wtBranch] of trackedWorktrees.entries()) {
          out += `worktree ${wtPath}\nbranch refs/heads/${wtBranch}\n\n`;
        }
        return { stdout: out, stderr: '', exitCode: 0 };
      },
    });
    mockHost.customRules.push({
      pattern: 'git status --porcelain=v1 --untracked-files=all',
      response: () => ({ stdout: '', stderr: '', exitCode: 0 }),
    });
    mockHost.customRules.push({
      pattern: 'git merge --no-ff',
      response: () => ({ stdout: 'Merge made by the recursive strategy.\n', stderr: '', exitCode: 0 }),
    });
    mockHost.customRules.push({
      pattern: 'git worktree remove',
      response: (command) => {
        const parts = command.match(/git worktree remove '([^']+)'/);
        if (parts) {
          trackedWorktrees.delete(parts[1]);
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    mockHost.customRules.push({
      pattern: 'git branch -d',
      response: (command) => {
        const parts = command.match(/git branch -d.*?['"]([^'"]+)['"]/);
        if (parts) {
          trackedBranches.delete(parts[1]);
        }
        return { stdout: 'Deleted branch\n', stderr: '', exitCode: 0 };
      },
    });
    mockHost.customRules.push({
      pattern: 'git show-ref --verify --quiet',
      response: (command) => {
        const match = command.match(/refs\/heads\/([^']+)/);
        const branch = match ? match[1] : '';
        return {
          stdout: '',
          stderr: '',
          exitCode: trackedBranches.has(branch) ? 0 : 1,
        };
      },
    });
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'spawnea-test-mgr-'));
    dbConn = createDatabase({ path: ':memory:', migrate: true });
    repos = createRepositories(dbConn.db);
    catManager = new CatalogManager();
    contextStore = new SessionContextStore({ storeDir: join(tempDir, 'sessions') });
    ptyBroker = new PtyBroker();
    mockHost = new MockHostAdapter('dev-workstation', ['/workspace/spawnea']);

    // Seed mock server, project, agent in DB
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
  });

  afterEach(async () => {
    await sessionManager.dispose();
    dbConn.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('sendPrompt delivery', () => {
    async function createPromptSession() {
      return repos.sessions.save({
        id: 'sess-prompt',
        name: 'Prompt Session',
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Prompt delivery',
        worktreePath: '/workspace/spawnea',
        branch: 'main',
        tmuxSessionName: 'spawnea-prompt',
        status: 'working',
      });
    }

    it('delivers through an active PTY', async () => {
      await createPromptSession();
      vi.spyOn(ptyBroker, 'getMetrics').mockReturnValue({ recentOutputBytes: 0 });
      const write = vi.spyOn(ptyBroker, 'write').mockReturnValue(true);

      await expect(sessionManager.sendPrompt('sess-prompt', 'Run tests')).resolves.toEqual({
        delivered: true,
        deliveryMethod: 'pty',
      });
      expect(write).toHaveBeenCalledWith('pty-sess-prompt', 'Run tests\n');
    });

    it('falls back to tmux when the PTY closes after its metrics are read', async () => {
      await createPromptSession();
      vi.spyOn(ptyBroker, 'getMetrics').mockReturnValue({ recentOutputBytes: 0 });
      vi.spyOn(ptyBroker, 'write').mockReturnValue(false);

      await expect(sessionManager.sendPrompt('sess-prompt', 'Run tests')).resolves.toEqual({
        delivered: true,
        deliveryMethod: 'tmux',
      });
      expect(mockHost.executedCommands.some(({ command }) => command.includes('tmux send-keys'))).toBe(true);
    });

    it('throws when tmux cannot deliver the prompt', async () => {
      await createPromptSession();
      mockHost.customRules.push({
        pattern: "tmux send-keys -t 'spawnea-prompt' -l",
        response: { stdout: '', stderr: 'send failed', exitCode: 1 },
      });
      vi.spyOn(ptyBroker, 'getMetrics').mockReturnValue({ recentOutputBytes: 0 });
      vi.spyOn(ptyBroker, 'write').mockReturnValue(false);

      await expect(sessionManager.sendPrompt('sess-prompt', 'Run tests')).rejects.toThrow(
        "Failed to deliver prompt to tmux session 'spawnea-prompt'"
      );
    });
  });

  it('tests selected host connection successfully (FG-1.2, FG-2.1)', async () => {
    const result = await sessionManager.testHost('dev-workstation');
    expect(result.success).toBe(true);
    expect(result.hostId).toBe('dev-workstation');
  });

  it('rejects session file paths outside the active worktree', async () => {
    const session = await repos.sessions.save({
      id: 'sess-path-boundary',
      name: 'Path Boundary Session',
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Test path boundaries',
      worktreePath: '/workspace/spawnea',
      branch: 'main',
      tmuxSessionName: 'spawnea-path-boundary',
      status: 'working',
    });
    const listFiles = vi.spyOn(mockHost, 'listFiles');
    const readFile = vi.spyOn(mockHost, 'readFile');

    await expect(sessionManager.listFiles(session.id, '../../etc')).rejects.toThrow();
    await expect(sessionManager.listFiles(session.id, '/workspace/spawnea-other')).rejects.toThrow();
    await expect(sessionManager.readFile(session.id, '../outside.txt')).rejects.toThrow();
    await expect(sessionManager.readFile(session.id, '/workspace/spawnea-other/file.txt')).rejects.toThrow();

    expect(listFiles).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('creates an Spawnea-owned persistent session and context file (FG-2.2)', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Implement authentication flow',
    });

    expect(session).toBeDefined();
    expect(session.task).toBe('Implement authentication flow');
    expect(session.status).toBe('working');
    expect(session.tmuxSessionName).toContain('spawnea-implement-authentication-');

    // Verify context file was persisted
    const context = await contextStore.load(session.id);
    expect(context).not.toBeNull();
    expect(context?.sessionId).toBe(session.id);
    expect(context?.project.path).toBe('/workspace/spawnea');
    expect(context?.persistentSession.name).toBe(session.tmuxSessionName);
    expect(context?.creationSource).toBe('ui');
    expect(session.creationSource).toBe('ui');
  });

  it('persists the MCP creation source when the control path creates a session', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'MCP-created session',
    }, 'mcp');

    expect(session.creationSource).toBe('mcp');
    expect((await repos.sessions.findById(session.id))?.creationSource).toBe('mcp');
    expect((await contextStore.load(session.id))?.creationSource).toBe('mcp');
  });

  it('resolves a credential-backed project only for runtime and persists safe locators', async () => {
    const catalogPath = join(tempDir, 'spawnea-secure.yaml');
    const projectReference = 'op://example-vault/secure-server/project-root';
    const targetReference = 'op://example-vault/secure-server/hostname';
    const resolvedProjectPath = '/srv/private/customer-app';
    writeFileSync(catalogPath, `
version: 1
hosts:
  secure:
    name: Secure host
    ssh:
      target: ${targetReference}
    projects:
      app:
        name: Customer app
        path: ${projectReference}
    harnesses:
      shell:
        name: Shell
        command: bash
`);
    catManager = new CatalogManager({ catalogPath });
    expect(catManager.load().errors).toBeNull();

    await repos.servers.save({
      id: 'secure',
      name: 'Secure host',
      host: 'credential-backed',
      sshPort: 22,
      enabled: true,
    });
    await repos.projects.save({
      id: 'secure:app',
      serverId: 'secure',
      name: 'Customer app',
      rootPath: createCatalogProjectPathLocator('secure', 'app'),
    });
    await repos.agents.save({
      id: 'secure:shell',
      name: 'Shell',
      harness: 'shell',
      command: 'bash',
    });

    const resolver = new OnePasswordResolver();
    const release = vi.fn();
    const resolveString = vi.spyOn(resolver, 'resolveString').mockImplementation(async (value, _field, kind) => {
      if (kind === 'project_path' && value === projectReference) {
        const unregister = registerSensitiveValue(resolvedProjectPath);
        return {
          value: resolvedProjectPath,
          sensitive: true,
          release: () => {
            release();
            unregister();
          },
        };
      }
      throw new Error('Unexpected secret field resolution');
    });
    const secureHost = new MockHostAdapter('secure', [resolvedProjectPath]);

    await sessionManager.dispose();
    sessionManager = new SessionManager({
      repositories: repos,
      catalogManager: catManager,
      contextStore,
      ptyBroker,
      hostAdapterFactory: async () => secureHost,
      onePasswordResolver: resolver,
    });

    expect(resolveString).not.toHaveBeenCalled();
    const session = await sessionManager.createSession({
      serverId: 'secure',
      projectId: 'secure:app',
      agentId: 'secure:shell',
      task: 'Credential safe session',
      useWorktree: false,
    });
    const context = await contextStore.load(session.id);
    const persisted = await repos.sessions.findById(session.id);
    const serializedPersistence = JSON.stringify({ context, persisted });

    expect(session.worktreePath).toBe(createCatalogProjectPathLocator('secure', 'app'));
    expect(context?.project.path).toBe(session.worktreePath);
    expect(context?.host.ssh).toBeUndefined();
    expect(serializedPersistence).not.toContain('op://');
    expect(serializedPersistence).not.toContain(resolvedProjectPath);
    expect(release).toHaveBeenCalledTimes(1);

    await sessionManager.listFiles(session.id);
    expect(resolveString).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);

    const worktreeLocator = createCatalogWorktreePathLocator('secure', 'app', 'restart-task-abc');
    await repos.sessions.save({
      ...session,
      worktreePath: worktreeLocator,
      managedWorktree: true,
      branch: 'spawnea/restart-task-abc',
      baseBranch: 'main',
    });
    const listFiles = vi.spyOn(secureHost, 'listFiles');
    await sessionManager.dispose();
    sessionManager = new SessionManager({
      repositories: repos,
      catalogManager: catManager,
      contextStore,
      ptyBroker: new PtyBroker(),
      hostAdapterFactory: async () => secureHost,
      onePasswordResolver: resolver,
    });

    await sessionManager.listFiles(session.id);
    expect(listFiles).toHaveBeenLastCalledWith(
      `${resolvedProjectPath}__worktrees/restart-task-abc`
    );
    expect(resolveString).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it('does not resolve SSH references until an explicit connection test', async () => {
    const catalogPath = join(tempDir, 'spawnea-secure-host.yaml');
    writeFileSync(catalogPath, `
version: 1
hosts:
  secure:
    name: Secure host
    ssh:
      target: op://example-vault/secure-server/hostname
    projects: {}
    harnesses: {}
`);
    catManager = new CatalogManager({ catalogPath });
    expect(catManager.load().errors).toBeNull();
    const resolver = new OnePasswordResolver();
    const resolveString = vi.spyOn(resolver, 'resolveString').mockRejectedValue(
      new SecretResolutionError('authentication_required', 'hosts.secure.ssh.target')
    );

    await sessionManager.dispose();
    sessionManager = new SessionManager({
      repositories: repos,
      catalogManager: catManager,
      contextStore,
      ptyBroker,
      onePasswordResolver: resolver,
    });

    await sessionManager.getHostAdapter('secure');
    expect(resolveString).not.toHaveBeenCalled();
    await repos.servers.delete('dev-workstation');
    await repos.servers.save({
      id: 'secure',
      name: 'Secure host',
      host: 'credential-backed',
      sshPort: 22,
      enabled: true,
    });
    expect(await sessionManager.checkAllHostsHealth()).toEqual({});
    expect(resolveString).not.toHaveBeenCalled();

    const result = await sessionManager.testHost('secure');
    expect(resolveString).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('sign in to the 1Password CLI');
    expect(JSON.stringify(result)).not.toContain('op://');
  });

  it('excludes credential-backed hosts from immediate and periodic automatic health checks', async () => {
    vi.useFakeTimers();
    try {
      const catalogPath = join(tempDir, 'spawnea-secure-monitoring.yaml');
      writeFileSync(catalogPath, `
version: 1
hosts:
  secure:
    name: Secure host
    ssh:
      target: op://example-vault/secure-server/hostname
    projects: {}
    harnesses: {}
`);
      catManager = new CatalogManager({ catalogPath });
      expect(catManager.load().errors).toBeNull();
      const resolver = new OnePasswordResolver();
      const resolveString = vi.spyOn(resolver, 'resolveString').mockRejectedValue(
        new SecretResolutionError('authentication_required', 'hosts.secure.ssh.target')
      );

      await sessionManager.dispose();
      sessionManager = new SessionManager({
        repositories: repos,
        catalogManager: catManager,
        contextStore,
        ptyBroker,
        onePasswordResolver: resolver,
      });

      sessionManager.startHostHealthMonitoring(30_000);
      await vi.advanceTimersByTimeAsync(90_000);

      expect(resolveString).not.toHaveBeenCalled();
      expect(sessionManager.getAllCachedHostHealth()).toEqual({});
    } finally {
      sessionManager.stopHostHealthMonitoring();
      vi.useRealTimers();
    }
  });

  it('renames only the session display title and restores it from context', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Implement authentication flow',
    });

    const renamed = await sessionManager.renameSession(session.id, '  Auth follow-up  ');
    expect(renamed.name).toBe('Auth follow-up');
    expect(renamed.task).toBe(session.task);
    expect(renamed.tmuxSessionName).toBe(session.tmuxSessionName);
    expect(renamed.branch).toBe(session.branch);
    expect(renamed.worktreePath).toBe(session.worktreePath);
    expect(renamed.baseBranch).toBe(session.baseBranch);
    expect(renamed.managedWorktree).toBe(session.managedWorktree);

    const persisted = await repos.sessions.findById(session.id);
    expect(persisted?.name).toBe('Auth follow-up');

    const context = await contextStore.load(session.id);
    expect(context?.sessionName).toBe('Auth follow-up');
    expect(context?.task).toBe(session.task);
    expect(context?.persistentSession.name).toBe(session.tmuxSessionName);

    await repos.sessions.delete(session.id);
    const restored = await sessionManager.restoreSessions();
    expect(restored.find((candidate) => candidate.id === session.id)?.name).toBe('Auth follow-up');
  });

  it('rejects blank and oversized session titles without changing persistence', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Keep this title',
    });

    await expect(sessionManager.renameSession(session.id, '   ')).rejects.toThrow('cannot be empty');
    await expect(sessionManager.renameSession(session.id, 'x'.repeat(121))).rejects.toThrow(
      '120 characters or fewer'
    );
    expect((await repos.sessions.findById(session.id))?.name).toBe('Keep this title');
    expect((await contextStore.load(session.id))?.sessionName).toBe('Keep this title');
  });

  it('creates an isolated session in its verified managed worktree', async () => {
    await enableManagedWorktrees();

    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Isolated feature',
      baseBranch: 'main',
    });

    expect(session.managedWorktree).toBe(true);
    expect(session.baseBranch).toBe('main');
    expect(session.baseCommit).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(session.branch).toMatch(/^spawnea\/isolated-feature-/);
    expect(session.worktreePath).toMatch(/spawnea__worktrees\/isolated-feature-/);

    const tmuxCreate = mockHost.executedCommands.find(({ command }) => command.includes('tmux new-session'));
    expect(tmuxCreate?.command).toContain(`-c '${session.worktreePath}'`);

    const context = await contextStore.load(session.id);
    expect(context?.project.path).toBe(session.worktreePath);
    expect(context?.worktree).toEqual({
      managed: true,
      path: session.worktreePath,
      branch: session.branch,
      baseBranch: 'main',
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
    });
  });

  it('respects useWorktree: false to run on project root even if worktree is enabled in catalog', async () => {
    await enableManagedWorktrees();

    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Direct root task',
      useWorktree: false,
    });

    expect(session.managedWorktree).toBe(false);
    expect(session.worktreePath).toBe('/workspace/spawnea');
  });

  it('respects useWorktree: true to create an isolated worktree', async () => {
    await enableManagedWorktrees();

    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Explicit worktree task',
      useWorktree: true,
      baseBranch: 'main',
    });

    expect(session.managedWorktree).toBe(true);
    expect(session.worktreePath).toMatch(/spawnea__worktrees\/explicit-worktree-task-/);
  });

  it('keeps five isolated sessions active on distinct branches and worktrees', async () => {
    await enableManagedWorktrees();

    const sessions = [];
    for (let index = 0; index < 5; index += 1) {
      sessions.push(await sessionManager.createSession({
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: `Parallel feature ${index}`,
        baseBranch: 'main',
      }));
    }

    expect(new Set(sessions.map((session) => session.worktreePath))).toHaveLength(5);
    expect(new Set(sessions.map((session) => session.branch))).toHaveLength(5);
    expect(new Set(sessions.map((session) => session.tmuxSessionName))).toHaveLength(5);
    expect(sessions.every((session) => mockHost.sessions.has(session.tmuxSessionName))).toBe(true);
    expect(sessions.every((session) => session.managedWorktree)).toBe(true);
  });

  it('restores the same live managed worktree after an application restart', async () => {
    await enableManagedWorktrees();
    const created = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Persistent isolated feature',
      baseBranch: 'main',
    });

    await sessionManager.dispose();
    sessionManager = new SessionManager({
      repositories: repos,
      catalogManager: catManager,
      contextStore,
      ptyBroker: new PtyBroker(),
      hostAdapterFactory: async () => mockHost,
    });
    const restored = await sessionManager.restoreSessions();

    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      id: created.id,
      worktreePath: created.worktreePath,
      branch: created.branch,
      baseBranch: 'main',
      managedWorktree: true,
      status: 'disconnected',
    });
    expect(mockHost.sessions.has(created.tmuxSessionName)).toBe(true);
  });

  it('does not start tmux when the generated branch collides', async () => {
    await enableManagedWorktrees();
    mockHost.customRules.unshift({
      pattern: /git show-ref --verify --quiet 'refs\/heads\/spawnea\//,
      response: { stdout: '', stderr: '', exitCode: 0 },
    });

    await expect(sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Colliding isolated feature',
      baseBranch: 'main',
    })).rejects.toThrow(/already exists/);

    expect(mockHost.executedCommands.some(({ command }) => command.includes('tmux new-session'))).toBe(false);
    expect(await repos.sessions.findAll()).toEqual([]);
  });

  it('attempts normal worktree cleanup and preserves the branch when startup fails', async () => {
    await enableManagedWorktrees();
    mockHost.customRules.unshift({
      pattern: 'which tmux',
      response: { stdout: '', stderr: 'tmux unavailable', exitCode: 1 },
    });

    await expect(sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Failed isolated feature',
      baseBranch: 'main',
    })).rejects.toThrow(/tmux is not installed/);

    expect(mockHost.executedCommands.some(({ command }) => command.includes('git worktree remove --'))).toBe(true);
    expect(mockHost.executedCommands.some(({ command }) => /git branch .*-d/.test(command))).toBe(false);
    expect(await repos.sessions.findAll()).toEqual([]);
    expect(await contextStore.list()).toEqual([]);
  });

  it('fails truthfully if project folder preparation fails (FG-2.2.5)', async () => {
    mockHost.customRules.push({
      pattern: 'test -d',
      response: { stdout: '', stderr: '', exitCode: 1 },
    });
    mockHost.customRules.push({
      pattern: 'mkdir -p',
      response: { stdout: '', stderr: 'Permission denied', exitCode: 1 },
    });

    await expect(
      sessionManager.createSession({
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Failing Task',
      })
    ).rejects.toThrow(/Permission denied/);

    // Verify no session was saved to DB
    const allSessions = await repos.sessions.findAll();
    expect(allSessions.length).toBe(0);
  });

  it('queues concurrent duplicate session launches (FG-2.2.10)', async () => {
    let releaseFirstTmuxCheck!: () => void;
    let firstTmuxCheckReached!: () => void;
    const firstTmuxCheck = new Promise<void>((resolve) => { firstTmuxCheckReached = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirstTmuxCheck = resolve; });
    let tmuxCheckCount = 0;
    mockHost.customRules.push({
      pattern: 'which tmux',
      response: async () => {
        tmuxCheckCount += 1;
        if (tmuxCheckCount === 1) {
          firstTmuxCheckReached();
          await release;
        }
        return { stdout: '/usr/bin/tmux', stderr: '', exitCode: 0 };
      },
    });

    const p1 = sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Duplicate Task',
    });
    await firstTmuxCheck;

    const p2 = sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Duplicate Task',
    });

    await Promise.resolve();
    expect(tmuxCheckCount).toBe(1);
    releaseFirstTmuxCheck();
    const sessions = await Promise.all([p1, p2]);
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((session) => session.id)).size).toBe(2);
  });

  it('detaches from session without stopping persistent execution (FG-2.3.1, FG-2.3.3)', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Detachable Task',
    });

    const mockWebContents = { send: () => {} } as any;
    const { ptyChannelId } = await sessionManager.attachSession(session.id, mockWebContents);
    expect(ptyChannelId).toBe(`pty-${session.id}`);

    // Verify session is active
    let dbSession = await repos.sessions.findById(session.id);
    expect(dbSession?.status).toBe('working');

    // Detach from session
    await sessionManager.detachSession(session.id);

    // Verify status transitioned to disconnected in DB and contextStore
    dbSession = await repos.sessions.findById(session.id);
    expect(dbSession?.status).toBe('disconnected');

    const ctx = await contextStore.load(session.id);
    expect(ctx?.status).toBe('disconnected');

    // Verify persistent tmux session STILL exists on host
    expect(mockHost.sessions.has(session.tmuxSessionName)).toBe(true);

    // Verify operator can re-attach cleanly
    const reattached = await sessionManager.attachSession(session.id, mockWebContents);
    expect(reattached.ptyChannelId).toBe(`pty-${session.id}`);

    dbSession = await repos.sessions.findById(session.id);
    expect(dbSession?.status).toBe('idle');
  });

  it('restores remembered sessions and preserves session identity across close and reopen (FG-2.3.2, FG-2.4.1)', async () => {
    const s1 = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Task 1 — Build feature',
    });
    const s2 = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Task 2 — Refactor core',
    });

    // Simulate application close (dispose)
    await sessionManager.dispose();

    // Verify tmux sessions on host were NOT killed during dispose
    expect(mockHost.sessions.has(s1.tmuxSessionName)).toBe(true);
    expect(mockHost.sessions.has(s2.tmuxSessionName)).toBe(true);

    // Verify context files exist on disk
    const listFiles = await contextStore.list();
    expect(listFiles.length).toBe(2);

    // Simulate application restart: create a new SessionManager instance
    const newSessionManager = new SessionManager({
      repositories: repos,
      catalogManager: catManager,
      contextStore,
      ptyBroker: new PtyBroker(),
      hostAdapterFactory: async (_serverId) => mockHost,
    });

    const restoredSessions = await newSessionManager.restoreSessions();
    expect(restoredSessions.length).toBe(2);

    // Verify identities preserved
    const restored1 = restoredSessions.find((s) => s.id === s1.id);
    const restored2 = restoredSessions.find((s) => s.id === s2.id);

    expect(restored1).toBeDefined();
    expect(restored1?.task).toBe('Task 1 — Build feature');
    expect(restored1?.tmuxSessionName).toBe(s1.tmuxSessionName);
    expect(restored1?.status).toBe('disconnected');

    expect(restored2).toBeDefined();
    expect(restored2?.task).toBe('Task 2 — Refactor core');
    expect(restored2?.tmuxSessionName).toBe(s2.tmuxSessionName);
    expect(restored2?.status).toBe('disconnected');

    // Verify no duplicate records in database
    const allDbSessions = await repos.sessions.findAll();
    expect(allDbSessions.length).toBe(2);

    await newSessionManager.dispose();
  });

  it('distinguishes explicit stop from detach by verifying termination before marking done (FG-2.7.1, FG-2.7.3, FG-2.7.4)', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Stoppable Task',
    });

    expect(mockHost.sessions.has(session.tmuxSessionName)).toBe(true);

    // Explicitly stop session
    await sessionManager.stopSession(session.id);

    // Verify tmux session was killed and verified dead on host
    expect(mockHost.sessions.has(session.tmuxSessionName)).toBe(false);

    // Verify status is done in DB and contextStore
    const dbSession = await repos.sessions.findById(session.id);
    expect(dbSession?.status).toBe('done');

    const ctx = await contextStore.load(session.id);
    expect(ctx?.status).toBe('done');
  });

  it('fails truthfully and preserves non-ended state when termination verification fails (FG-2.7.3)', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Unstoppable Task',
    });

    // Simulate failure to kill session (e.g. host rule prevents killing session)
    mockHost.customRules.push({
      pattern: 'tmux kill-session',
      response: {
        stdout: '',
        stderr: 'failed to kill session: permission denied',
        exitCode: 1,
      },
    });

    // Attempt stop -> should throw verification failure
    await expect(sessionManager.stopSession(session.id)).rejects.toThrow(
      /Failed to verify termination/
    );

    // Verify session was NOT falsely marked done
    const dbSession = await repos.sessions.findById(session.id);
    expect(dbSession?.status).toBe('working');

    const ctx = await contextStore.load(session.id);
    expect(ctx?.status).toBe('working');
  });

  it('ensures stopping an owned session leaves unrelated external tmux sessions untouched (FG-2.4.5, FG-2.7.3)', async () => {
    // Register an external unowned session on the host
    const externalSessionName = 'unrelated-tmux-session';
    mockHost.sessions.add(externalSessionName);

    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Owned Task',
    });

    expect(mockHost.sessions.has(session.tmuxSessionName)).toBe(true);
    expect(mockHost.sessions.has(externalSessionName)).toBe(true);

    // Stop owned session
    await sessionManager.stopSession(session.id);

    // Verify owned session is gone, but external session remains untouched
    expect(mockHost.sessions.has(session.tmuxSessionName)).toBe(false);
    expect(mockHost.sessions.has(externalSessionName)).toBe(true);
  });

  it('reconciles active sessions with remote reality and marks missing sessions as done (FG-2.4.2, FG-2.6.2)', async () => {
    const s1 = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Task 1 — Still Running',
    });
    const s2 = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Task 2 — Terminated Remotely',
    });

    // Simulate s2 terminating externally on the host (e.g. agent exited)
    mockHost.sessions.delete(s2.tmuxSessionName);

    // Reconcile sessions against remote host
    const reconciled = await sessionManager.reconcileSessions();
    expect(reconciled.length).toBe(2);

    const rec1 = reconciled.find((s) => s.id === s1.id);
    const rec2 = reconciled.find((s) => s.id === s2.id);

    expect(rec1?.status).toBe('disconnected');
    expect(rec2?.status).toBe('done');

    // Verify context files reflect the reconciled state
    const ctx1 = await contextStore.load(s1.id);
    const ctx2 = await contextStore.load(s2.id);
    expect(ctx1?.status).toBe('disconnected');
    expect(ctx2?.status).toBe('done');
  });

  it('preserves disconnected session state when host is temporarily unreachable (FG-2.4.3, FG-2.6.1)', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Task on unreachable host',
    });

    // Simulate host becoming unreachable / network failure
    mockHost.shouldFailConnection = true;
    mockHost.connectionErrorMessage = 'ssh: connect to host example-host port 22: Connection timed out';

    // Reconcile session
    const reconciled = await sessionManager.reconcileSessions();
    const recSession = reconciled.find((s) => s.id === session.id);

    // CRITICAL: Unreachable host MUST NOT mark the session as done or delete it! (FG-2.4.3)
    expect(recSession?.status).toBe('disconnected');
    const dbSession = await repos.sessions.findById(session.id);
    expect(dbSession?.status).toBe('disconnected');
    const ctx = await contextStore.load(session.id);
    expect(ctx?.status).toBe('disconnected');
  });

  it('reconnects to the exact same persistent tmux session without spawning replacement harnesses (FG-2.5.3)', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Continuous Work Session',
    });

    // Detach
    await sessionManager.detachSession(session.id);
    expect((await repos.sessions.findById(session.id))?.status).toBe('disconnected');

    // Track command execution on mockHost
    const initialSessionCount = mockHost.sessions.size;

    // Reconnect / Attach
    const mockWebContents = { send: () => {} } as any;
    const { ptyChannelId } = await sessionManager.attachSession(session.id, mockWebContents);
    expect(ptyChannelId).toBe(`pty-${session.id}`);

    // Verify session status transitioned to idle
    expect((await repos.sessions.findById(session.id))?.status).toBe('idle');

    // Verify no second tmux session or duplicate record was created
    expect(mockHost.sessions.size).toBe(initialSessionCount);
    const allDb = await repos.sessions.findAll();
    expect(allDb.length).toBe(1);
  });

  it('leaves unrelated external tmux sessions unchanged (FG-2.4.5)', async () => {
    // Add external unrelated session on host
    mockHost.sessions.add('user-personal-tmux-session');

    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Spawnea Owned Session',
    });

    await sessionManager.reconcileSessions();

    // Verify external session was not adopted into database
    const allSessions = await repos.sessions.findAll();
    expect(allSessions.length).toBe(1);
    expect(allSessions[0].id).toBe(session.id);

    // Verify external session on host still exists untouched
    expect(mockHost.sessions.has('user-personal-tmux-session')).toBe(true);
  });

  it('deletes an active or concluded session record completely (FG-2.6.5, FG-2.7.4)', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Deletable Task',
    });

    expect(mockHost.sessions.has(session.tmuxSessionName)).toBe(true);

    const deleted = await sessionManager.deleteSession(session.id);
    expect(deleted).toBe(true);

    // Verify tmux session killed
    expect(mockHost.sessions.has(session.tmuxSessionName)).toBe(false);

    // Verify DB record deleted
    const dbSession = await repos.sessions.findById(session.id);
    expect(dbSession).toBeNull();

    // Verify context file removed from disk
    const ctx = await contextStore.load(session.id);
    expect(ctx).toBeNull();
  });

  it('probes host system telemetry and caches result in memory for subsequent tabs/sessions', async () => {
    mockHost.customRules.push({
      pattern: '===UNAME===',
      response: {
        stdout: `
===UNAME===
Linux 6.1.0-rpi4 aarch64
===OS===
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
===CPU===
model name	: ARM Cortex-A72
===CORES===
4
===MEM===
MemTotal:        8192000 kB
===UPTIME===
up 1 day, 5 hours
===SHELL===
/bin/bash
`,
        stderr: '',
        exitCode: 0,
      },
    });

    const info1 = await sessionManager.getHostSystemInfo('dev-workstation');
    expect(info1).not.toBeNull();
    expect(info1?.osName).toBe('Debian GNU/Linux 12 (bookworm)');
    expect(info1?.arch).toBe('aarch64');
    expect(info1?.cpuModel).toBe('ARM Cortex-A72 (4 cores)');
    expect(info1?.totalMemory).toBe('7.8 GB');
    expect(info1?.uptime).toBe('1 day, 5 hours');

    // Mutate customRules to verify cache is used and does NOT re-execute
    mockHost.customRules = [];
    const info2 = await sessionManager.getHostSystemInfo('dev-workstation');
    expect(info2).toEqual(info1);
  });

  it('lists files and reads file content for an active session (FG-5.1, FG-5.2)', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Files Test Session',
    });

    mockHost.directories.add('/workspace/spawnea/src');
    mockHost.mockFiles.set('/workspace/spawnea/package.json', {
      content: '{"name": "spawnea"}',
      mimeType: 'application/json',
      size: 21,
    });
    mockHost.mockFiles.set('/workspace/spawnea/src/index.ts', {
      content: 'console.log("hello");',
      mimeType: 'text/typescript',
      size: 21,
    });

    const files = await sessionManager.listFiles(session.id);
    expect(files.some((f) => f.name === 'src' && f.isDirectory)).toBe(true);
    expect(files.some((f) => f.name === 'package.json' && f.isFile)).toBe(true);

    const readResult = await sessionManager.readFile(session.id, 'package.json');
    expect(readResult.content).toBe('{"name": "spawnea"}');
    expect(readResult.mimeType).toBe('application/json');
    expect(readResult.isTruncated).toBe(false);
  });

  it('delegates Git status and diff queries through GitService for a session (FG-5.3, FG-5.4)', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Git Test Session',
    });

    mockHost.customRules.push(
      {
        pattern: 'git rev-parse --is-inside-work-tree',
        response: { stdout: 'true\n', stderr: '', exitCode: 0 },
      },
      {
        pattern: 'git branch --show-current',
        response: { stdout: 'feat/pilot3\n', stderr: '', exitCode: 0 },
      },
      {
        pattern: 'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}',
        response: { stdout: '', stderr: 'fatal: no upstream', exitCode: 1 },
      },
      {
        pattern: 'git status --porcelain=v1 -uall',
        response: { stdout: 'M  src/index.ts\n?? notes.txt\n', stderr: '', exitCode: 0 },
      },
      {
        pattern: 'git diff HEAD',
        response: {
          stdout: 'diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1,2 @@\n-old\n+new\n+added\n',
          stderr: '',
          exitCode: 0,
        },
      }
    );

    const gitStatus = await sessionManager.getGitStatus(session.id);
    expect(gitStatus.isGitRepo).toBe(true);
    expect(gitStatus.branch).toBe('feat/pilot3');
    expect(gitStatus.staged.length).toBe(1);
    expect(gitStatus.untracked.length).toBe(1);
    expect(gitStatus.totalChanges).toBe(2);

    const gitDiff = await sessionManager.getGitDiff(session.id);
    expect(gitDiff.totalFilesChanged).toBe(1);
    expect(gitDiff.totalAdditions).toBe(2);
    expect(gitDiff.totalDeletions).toBe(1);
    expect(gitDiff.files[0].path).toBe('src/index.ts');
  });

  it('discovers unmanaged external tmux sessions on host (FG-7.2.1)', async () => {
    // 1. Create one managed session in Spawnea
    await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Managed Session 1',
    });

    const managedSessions = await repos.sessions.findAll();
    const managedTmuxName = managedSessions[0].tmuxSessionName;

    // 2. Mock tmux list-sessions output containing both managed and unmanaged sessions
    mockHost.customRules.push({
      pattern: 'tmux list-sessions',
      response: {
        stdout: [
          `${managedTmuxName}:::1:::1710000000:::1001:::claude:::/workspace/spawnea`,
          `external-work-session:::2:::1710000500:::1002:::bash:::/workspace/demo`,
          `custom-dev-shell:::1:::1710001000:::1003:::python:::/var/data/worker`,
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      },
    });

    const discovered = await sessionManager.discoverExternalSessions('dev-workstation');
    expect(discovered.length).toBe(2);
    expect(discovered[0].sessionName).toBe('external-work-session');
    expect(discovered[0].currentPath).toBe('/workspace/demo');
    expect(discovered[1].sessionName).toBe('custom-dev-shell');
  });

  it('adopts an external tmux session and writes context file with isExternal flag (FG-7.2.2)', async () => {
    mockHost.customRules.push({
      pattern: 'tmux has-session -t \'external-work-session\'',
      response: { stdout: '', stderr: '', exitCode: 0 },
    });

    const adopted = await sessionManager.adoptSession({
      serverId: 'dev-workstation',
      tmuxSessionName: 'external-work-session',
      sessionName: 'Adopted Work Session',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Investigate production bug',
    });

    expect(adopted.id).toMatch(/^sess-/);
    expect(adopted.name).toBe('Adopted Work Session');
    expect(adopted.isExternal).toBe(true);
    expect(adopted.tmuxSessionName).toBe('external-work-session');
    expect(adopted.status).toBe('working');

    // Verify stored in DB
    const dbRecord = await repos.sessions.findById(adopted.id);
    expect(dbRecord?.isExternal).toBe(true);

    // Verify context file written
    const ctx = await contextStore.load(adopted.id);
    expect(ctx).toBeDefined();
    expect(ctx?.isExternal).toBe(true);
    expect(ctx?.persistentSession.name).toBe('external-work-session');
  });

  it('releases an adopted session non-destructively without killing tmux (FG-7.2.3)', async () => {
    mockHost.customRules.push({
      pattern: 'tmux has-session -t \'external-shell-session\'',
      response: { stdout: '', stderr: '', exitCode: 0 },
    });

    const adopted = await sessionManager.adoptSession({
      serverId: 'dev-workstation',
      tmuxSessionName: 'external-shell-session',
      sessionName: 'Terminal Shell',
      task: 'Ad-hoc terminal work',
    });

    expect(await repos.sessions.findById(adopted.id)).toBeDefined();
    expect(await contextStore.load(adopted.id)).toBeDefined();

    // Release / Un-adopt
    const unadopted = await sessionManager.unadoptSession(adopted.id);
    expect(unadopted).toBe(true);

    // DB record and context file removed
    expect(await repos.sessions.findById(adopted.id)).toBeNull();
    expect(await contextStore.load(adopted.id)).toBeNull();

    // Verify tmux kill-session was NOT called
    const killCommands = mockHost.executedCommands.filter((c) => c.command.includes('kill-session'));
    expect(killCommands.length).toBe(0);
  });

  it('tracks host connection state and triggers retryHostConnection on demand (FG-P5.2)', async () => {
    const initialState = await sessionManager.getHostConnectionState('dev-workstation');
    expect(initialState.status).toBe('connected');
    expect(initialState.serverId).toBe('dev-workstation');

    // Simulate drop
    mockHost.simulateDrop('Network unreachable');
    const droppedState = await sessionManager.getHostConnectionState('dev-workstation');
    expect(droppedState.status).toBe('reconnecting');
    expect(droppedState.attempt).toBe(1);

    // Operator requests Retry Now
    const retriedState = await sessionManager.retryHostConnection('dev-workstation');
    expect(retriedState.status).toBe('connected');
    expect(retriedState.attempt).toBe(0);
  });

  it('routes loopback profiles with SSH settings through the SSH adapter', async () => {
    await repos.servers.save({
      id: 'loopback-ssh',
      name: 'Loopback SSH Host',
      host: '::1',
      sshUser: 'remote-user',
      sshPort: 2222,
      enabled: true,
    });
    const fallbackManager = new SessionManager({
      repositories: repos,
      catalogManager: catManager,
      contextStore,
      ptyBroker,
    });

    try {
      await expect(fallbackManager.getHostConnectionEndpoint('loopback-ssh')).resolves.toEqual({
        transport: 'ssh',
        hostname: '::1',
        port: 2222,
      });
    } finally {
      await fallbackManager.dispose();
    }
  });

  it('transparently re-attaches PTY stream and notifies renderer when host connection recovers', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Task with network drop',
    });

    const mockWebContents = {
      send: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
    } as unknown as import('electron').WebContents;

    sessionManager.setWebContentsGetter(() => mockWebContents);

    // Attach to session
    await sessionManager.attachSession(session.id, mockWebContents, 100, 30);

    // Simulate connection drop
    mockHost.simulateDrop('WiFi disconnected');

    expect(mockWebContents.send).toHaveBeenCalledWith('host:connectionStateChanged', expect.objectContaining({
      status: 'reconnecting',
      serverId: 'dev-workstation',
    }));

    // Trigger recovery
    await sessionManager.retryHostConnection('dev-workstation');

    expect(mockWebContents.send).toHaveBeenCalledWith('host:connectionStateChanged', expect.objectContaining({
      status: 'connected',
      serverId: 'dev-workstation',
    }));

    // Verify session:reconnected event was broadcast to renderer
    expect(mockWebContents.send).toHaveBeenCalledWith('session:reconnected', expect.objectContaining({
      sessionId: session.id,
      ptyChannelId: `pty-${session.id}`,
    }));
  });

  it('runs parallel host health and latency checks across all hosts (FG-7.1.1, FG-1.2.2)', async () => {
    const health = await sessionManager.checkHostHealth('dev-workstation');
    expect(health).toBeDefined();
    expect(health.hostId).toBe('dev-workstation');
    expect(health.status).toBe('healthy');
    expect(health.latencyMs).toBeDefined();

    const allHealth = await sessionManager.checkAllHostsHealth();
    expect(allHealth['dev-workstation']).toBeDefined();
    expect(allHealth['dev-workstation'].status).toBe('healthy');

    const cached = sessionManager.getAllCachedHostHealth();
    expect(cached['dev-workstation']).toBeDefined();
  });

  describe('finishSession (Task 6.2.1)', () => {
    it('accepts the MCP-validated origin only for close requests', async () => {
      await expect(sessionManager.finishSession(
        'missing-session',
        'integrate',
        {},
        'mcp-validated'
      )).rejects.toThrow("'mcp-validated' finalization origin is only valid for close requests");
    });

    it('rejects finishing an unmanaged session', async () => {
      const regularSession = await sessionManager.createSession({
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Regular unmanaged task',
      });

      await expect(sessionManager.finishSession(regularSession.id, 'integrate')).rejects.toThrow(
        /not a managed worktree session/i
      );
      await expect(sessionManager.finishSession(regularSession.id, 'close')).rejects.toThrow(
        /not a managed worktree session/i
      );
    });

    it('returns without mutations when action is ignore', async () => {
      await enableManagedWorktrees();
      const session = await sessionManager.createSession({
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Ignore task test',
        baseBranch: 'main',
      });

      const result = await sessionManager.finishSession(session.id, 'ignore');
      expect(result).toEqual({ action: 'ignore', removed: false });

      // Session record and context still exist
      expect(await repos.sessions.findById(session.id)).toBeDefined();
      expect(await contextStore.load(session.id)).toBeDefined();
    });

    it('finalizes a managed worktree session with action close while preserving branch', async () => {
      await enableManagedWorktrees();
      const session = await sessionManager.createSession({
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Close task test',
        baseBranch: 'main',
      });

      const result = await sessionManager.finishSession(session.id, 'close');
      expect(result).toEqual({ action: 'close', removed: true });

      // Session record and context removed
      expect(await repos.sessions.findById(session.id)).toBeNull();
      expect(await contextStore.load(session.id)).toBeNull();
    });

    it('finalizes a managed worktree session with action integrate', async () => {
      await enableManagedWorktrees();
      const session = await sessionManager.createSession({
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Integrate task test',
        baseBranch: 'main',
      });

      const result = await sessionManager.finishSession(session.id, 'integrate');
      expect(result).toEqual({ action: 'integrate', removed: true });

      // Session record and context removed
      expect(await repos.sessions.findById(session.id)).toBeNull();
      expect(await contextStore.load(session.id)).toBeNull();
    });
  });

  describe('Session Hierarchy and Child Sessions', () => {
    it('creates a child session inheriting parent server, project, and agent with alias child-1', async () => {
      await enableManagedWorktrees();
      const parent = await sessionManager.createSession({
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Parent root task',
      });

      const child = await sessionManager.createChildSession({
        parentSessionId: parent.id,
        task: 'Child subtask 1',
        workspace: 'same-project',
      });

      expect(child.parentSessionId).toBe(parent.id);
      expect(child.childAlias).toBe('child-1');
      expect(child.serverId).toBe(parent.serverId);
      expect(child.projectId).toBe(parent.projectId);
      expect(child.agentId).toBe(parent.agentId);
      expect(child.worktreePath).toBe(parent.worktreePath);
      expect(child.managedWorktree).toBe(false);

      // Verify second child receives child-2
      const child2 = await sessionManager.createChildSession({
        parentSessionId: parent.id,
        task: 'Child subtask 2',
        workspace: 'same-project',
      });
      expect(child2.childAlias).toBe('child-2');
    });

    it('enforces 2-level hierarchy and rejects creating a child of a child', async () => {
      await enableManagedWorktrees();
      const parent = await sessionManager.createSession({
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Parent root task',
      });

      const child = await sessionManager.createChildSession({
        parentSessionId: parent.id,
        task: 'Child subtask',
        workspace: 'same-project',
      });

      await expect(
        sessionManager.createChildSession({
          parentSessionId: child.id,
          task: 'Grandchild task',
          workspace: 'same-project',
        })
      ).rejects.toThrow(/2-level cap/);
    });

    it('deletes parent with leave-children and promotes children to standalone root sessions', async () => {
      await enableManagedWorktrees();
      const parent = await sessionManager.createSession({
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Parent root task',
      });

      const child = await sessionManager.createChildSession({
        parentSessionId: parent.id,
        task: 'Child subtask',
        workspace: 'same-project',
      });

      await sessionManager.deleteSession(parent.id, 'leave-children');

      // Parent is deleted
      expect(await repos.sessions.findById(parent.id)).toBeNull();

      // Child is promoted
      const promoted = await repos.sessions.findById(child.id);
      expect(promoted).not.toBeNull();
      expect(promoted!.parentSessionId).toBeUndefined();
      expect(promoted!.childAlias).toBeUndefined();
    });

    it('deletes parent with close-all and closes both parent and child sessions', async () => {
      await enableManagedWorktrees();
      const parent = await sessionManager.createSession({
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Parent root task',
      });

      const child = await sessionManager.createChildSession({
        parentSessionId: parent.id,
        task: 'Child subtask',
        workspace: 'same-project',
      });

      await sessionManager.deleteSession(parent.id, 'close-all');

      // Both are deleted
      expect(await repos.sessions.findById(parent.id)).toBeNull();
      expect(await repos.sessions.findById(child.id)).toBeNull();
    });
    it('deletes parent and managed worktree child with close-all', async () => {
      await enableManagedWorktrees();
      const parent = await sessionManager.createSession({
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Parent root task',
      });

      const child = await sessionManager.createChildSession({
        parentSessionId: parent.id,
        task: 'Child with independent worktree',
        workspace: 'new-worktree',
      });

      expect(child.managedWorktree).toBe(true);
      expect(child.worktreePath).not.toBe(parent.worktreePath);

      await sessionManager.deleteSession(parent.id, 'close-all');

      expect(await repos.sessions.findById(parent.id)).toBeNull();
      expect(await repos.sessions.findById(child.id)).toBeNull();
    });

    it('keeps same-project children when integrate preflight fails', async () => {
      await enableManagedWorktrees();
      const parent = await sessionManager.createSession({
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Parent preflight task',
      });
      const child = await sessionManager.createChildSession({
        parentSessionId: parent.id,
        task: 'Child preserved on failure',
        workspace: 'same-project',
      });
      const verify = vi.spyOn((sessionManager as any).gitService, 'verifyManagedWorktreeForFinalization')
        .mockRejectedValueOnce(new Error('worktree is dirty'));

      await expect(sessionManager.finishSession(parent.id, 'integrate')).rejects.toThrow('worktree is dirty');
      expect(await repos.sessions.findById(child.id)).not.toBeNull();
      verify.mockRestore();
    });

    it('keeps same-project children when integration fails after preflight', async () => {
      await enableManagedWorktrees();
      const parent = await sessionManager.createSession({
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Parent merge task',
      });
      const child = await sessionManager.createChildSession({
        parentSessionId: parent.id,
        task: 'Child preserved after merge failure',
        workspace: 'same-project',
      });
      const merge = vi.spyOn((sessionManager as any).gitService, 'mergeManagedBranch')
        .mockRejectedValueOnce(new Error('merge failed'));

      await expect(sessionManager.finishSession(parent.id, 'integrate')).rejects.toThrow('merge failed');
      expect(await repos.sessions.findById(child.id)).not.toBeNull();
      expect(await (sessionManager as any).tmuxManager.hasSession(mockHost, child.tmuxSessionName)).toBe(true);
      merge.mockRestore();
    });
  });
});
