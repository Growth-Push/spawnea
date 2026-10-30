import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, createRepositories } from '@spawnea/db';
import { createLogger } from '@spawnea/domain';
import { LocalHostAdapter, type ExecOptions, type ExecResult } from '@spawnea/hosts';
import { CatalogManager } from './catalog-manager.js';
import { SessionContextStore } from './session-context-store.js';
import { SessionManager } from './session-manager.js';
import { PtyBroker } from './pty-broker.js';
import { AgentControlService } from './agent-control-service.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

class TestLocalHostAdapter extends LocalHostAdapter {
  private activeTmuxSessions = new Set<string>();

  override async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (command.startsWith('tmux ') || command.includes('tmux ')) {
      if (command.includes('tmux new-session')) {
        const match = command.match(/-s\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
        const name = match ? (match[1] || match[2] || match[3]) : '';
        if (name) this.activeTmuxSessions.add(name);
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (command.includes('tmux has-session')) {
        const match = command.match(/-t\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
        const name = match ? (match[1] || match[2] || match[3]) : '';
        const exists = name ? this.activeTmuxSessions.has(name) : false;
        return { stdout: '', stderr: exists ? '' : "can't find session", exitCode: exists ? 0 : 1 };
      }
      if (command.includes('tmux kill-session')) {
        const match = command.match(/-t\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
        const name = match ? (match[1] || match[2] || match[3]) : '';
        if (name) this.activeTmuxSessions.delete(name);
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return super.execute(command, options);
  }
}

describe('Child session new-worktree remote-base resolution and selection', () => {
  let tempRoot: string;
  let remotePath1: string;
  let remotePath2: string;
  let repoPath1: string;
  let repoPath2: string;
  let sessionManager: SessionManager;
  let controlService: AgentControlService;
  let repos: ReturnType<typeof createRepositories>;
  let dbConn: ReturnType<typeof createDatabase>;
  let host: TestLocalHostAdapter;
  let contextStore: SessionContextStore;
  let catManager: CatalogManager;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'spawnea-child-base-'));
    remotePath1 = join(tempRoot, 'remote1.git');
    remotePath2 = join(tempRoot, 'remote2.git');
    repoPath1 = join(tempRoot, 'repo1');
    repoPath2 = join(tempRoot, 'repo2');

    // Setup bare remotes
    git(tempRoot, 'init', '--bare', '--initial-branch=main', remotePath1);
    git(tempRoot, 'init', '--bare', '--initial-branch=main', remotePath2);

    // Setup repo 1
    git(tempRoot, 'init', '--initial-branch=main', repoPath1);
    git(repoPath1, 'config', 'user.email', 'test@example.invalid');
    git(repoPath1, 'config', 'user.name', 'Spawnea Test');
    writeFileSync(join(repoPath1, 'README.md'), 'repo1 initial\n');
    git(repoPath1, 'add', 'README.md');
    git(repoPath1, 'commit', '-m', 'repo1 initial commit');
    git(repoPath1, 'remote', 'add', 'origin', remotePath1);
    git(repoPath1, 'push', '-u', 'origin', 'main');

    // Setup repo 2
    git(tempRoot, 'init', '--initial-branch=main', repoPath2);
    git(repoPath2, 'config', 'user.email', 'test@example.invalid');
    git(repoPath2, 'config', 'user.name', 'Spawnea Test');
    writeFileSync(join(repoPath2, 'README.md'), 'repo2 initial\n');
    git(repoPath2, 'add', 'README.md');
    git(repoPath2, 'commit', '-m', 'repo2 initial commit');
    git(repoPath2, 'remote', 'add', 'origin', remotePath2);
    git(repoPath2, 'push', '-u', 'origin', 'main');

    // Catalog configuration
    const catalogPath = join(tempRoot, 'spawnea.yaml');
    writeFileSync(catalogPath, `
version: 1
hosts:
  local:
    name: Local Test Host
    enabled: true
    projects:
      proj1:
        name: Project 1
        path: ${repoPath1}
        base_branch: main
        worktree:
          enabled: true
        enabled: true
      proj2:
        name: Project 2
        path: ${repoPath2}
        base_branch: main
        worktree:
          enabled: true
        enabled: true
    harnesses:
      test-agent:
        name: Test Agent
        command: sh
        args: []
        enabled: true
`);

    dbConn = createDatabase({ path: ':memory:', migrate: true });
    repos = createRepositories(dbConn.db);
    catManager = new CatalogManager({ catalogPath });
    expect(catManager.load().errors).toBeNull();

    await repos.servers.save({
      id: 'local',
      name: 'Local Test Host',
      host: 'localhost',
      sshPort: 22,
      enabled: true,
    });

    await repos.projects.save({
      id: 'local:proj1',
      serverId: 'local',
      name: 'Project 1',
      rootPath: repoPath1,
      baseBranch: 'main',
    });

    await repos.projects.save({
      id: 'local:proj2',
      serverId: 'local',
      name: 'Project 2',
      rootPath: repoPath2,
      baseBranch: 'main',
    });

    await repos.agents.save({
      id: 'local:test-agent',
      name: 'Test Agent',
      harness: 'test-agent',
      command: 'sh',
    });

    host = new TestLocalHostAdapter({ serverId: 'local' });
    contextStore = new SessionContextStore({ storeDir: join(tempRoot, 'sessions') });
    const ptyBroker = new PtyBroker();

    sessionManager = new SessionManager({
      logger: createLogger('child-remote-base-test'),
      repositories: repos,
      catalogManager: catManager,
      contextStore,
      ptyBroker,
      hostAdapterFactory: async () => host,
    });

    controlService = new AgentControlService({
      sessionManager,
      repositories: repos,
      logger: createLogger('child-remote-control-test'),
    });
  });

  afterEach(() => {
    dbConn?.close();
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(`${repoPath1}__worktrees`, { recursive: true, force: true });
    rmSync(`${repoPath2}__worktrees`, { recursive: true, force: true });
  });

  it('updates remote base and pins baseCommit when coordinator is on another branch', async () => {
    // 1. Create root coordinator session
    const parent = await sessionManager.createSession({
      serverId: 'local',
      projectId: 'local:proj1',
      agentId: 'local:test-agent',
      task: 'Coordinator Task',
      useWorktree: false,
    });

    // Switch primary checkout to another branch
    git(repoPath1, 'checkout', '-b', 'spawnea/task-coordinator');
    writeFileSync(join(repoPath1, 'coordinator.txt'), 'coordinator changes\n');
    git(repoPath1, 'add', 'coordinator.txt');
    git(repoPath1, 'commit', '-m', 'coordinator branch commit');
    const coordCommit = git(repoPath1, 'rev-parse', 'HEAD');

    // 2. Push new commit to remote origin/main from a separate pusher clone
    const pusherPath = join(tempRoot, 'pusher1');
    git(tempRoot, 'clone', remotePath1, pusherPath);
    git(pusherPath, 'config', 'user.email', 'test@example.invalid');
    git(pusherPath, 'config', 'user.name', 'Spawnea Test');
    writeFileSync(join(pusherPath, 'README.md'), 'repo1 updated on origin\n');
    git(pusherPath, 'commit', '-am', 'remote update on main');
    git(pusherPath, 'push', 'origin', 'main');
    const expectedOriginMainSha = git(pusherPath, 'rev-parse', 'HEAD');

    // Verify local tracking ref is stale
    expect(git(repoPath1, 'rev-parse', 'origin/main')).not.toBe(expectedOriginMainSha);

    // 3. Create child session with new-worktree workspace
    const child = await sessionManager.createChildSession({
      parentSessionId: parent.id,
      task: 'Child Worker Task',
      workspace: 'new-worktree',
    }, 'control');

    // Assert: refreshed SHA == initial child HEAD == returned baseCommit
    expect(child.managedWorktree).toBe(true);
    expect(child.baseBranch).toBe('main');
    expect(child.baseCommit).toBe(expectedOriginMainSha);

    const childHeadSha = git(child.worktreePath, 'rev-parse', 'HEAD');
    expect(childHeadSha).toBe(expectedOriginMainSha);

    // Primary checkout of repo1 remains on coordinator branch and is intact
    expect(git(repoPath1, 'branch', '--show-current')).toBe('spawnea/task-coordinator');
    expect(git(repoPath1, 'rev-parse', 'HEAD')).toBe(coordCommit);
  });

  it('updates base from another destination project with stale local main and remote-tracking refs', async () => {
    // 1. Create root session on project 1
    const parent = await sessionManager.createSession({
      serverId: 'local',
      projectId: 'local:proj1',
      agentId: 'local:test-agent',
      task: 'Root on Project 1',
      useWorktree: false,
    });

    // 2. In project 2, record initial commit C1
    const c1 = git(repoPath2, 'rev-parse', 'main');
    expect(git(repoPath2, 'rev-parse', 'origin/main')).toBe(c1);

    // Push new commit C2 to remote2
    const pusherPath = join(tempRoot, 'pusher2');
    git(tempRoot, 'clone', remotePath2, pusherPath);
    git(pusherPath, 'config', 'user.email', 'test@example.invalid');
    git(pusherPath, 'config', 'user.name', 'Spawnea Test');
    writeFileSync(join(pusherPath, 'README.md'), 'repo2 second commit on origin\n');
    git(pusherPath, 'commit', '-am', 'remote commit C2');
    git(pusherPath, 'push', 'origin', 'main');
    const c2 = git(pusherPath, 'rev-parse', 'HEAD');
    expect(c2).not.toBe(c1);

    // Repo2 local main and origin/main are still stale at C1
    expect(git(repoPath2, 'rev-parse', 'main')).toBe(c1);
    expect(git(repoPath2, 'rev-parse', 'origin/main')).toBe(c1);

    // 3. Create child session in Project 2 with new-worktree
    const child = await sessionManager.createChildSession({
      parentSessionId: parent.id,
      projectId: 'local:proj2',
      task: 'Child on Project 2',
      workspace: 'new-worktree',
    }, 'control');

    // Assert: refreshed SHA C2 == initial child HEAD == returned baseCommit
    expect(child.projectId).toBe('local:proj2');
    expect(child.baseBranch).toBe('main');
    expect(child.baseCommit).toBe(c2);

    const childHead = git(child.worktreePath, 'rev-parse', 'HEAD');
    expect(childHead).toBe(c2);

    // Repo2 primary checkout remains at C1 on main
    expect(git(repoPath2, 'branch', '--show-current')).toBe('main');
    expect(git(repoPath2, 'rev-parse', 'HEAD')).toBe(c1);
  });

  it('creates worktree from an explicit remote branch differing from project configuration', async () => {
    // 1. Create root session
    const parent = await sessionManager.createSession({
      serverId: 'local',
      projectId: 'local:proj1',
      agentId: 'local:test-agent',
      task: 'Parent Session',
      useWorktree: false,
    });

    // 2. Create 'develop' branch on origin
    const pusherPath = join(tempRoot, 'pusher1');
    git(tempRoot, 'clone', remotePath1, pusherPath);
    git(pusherPath, 'config', 'user.email', 'test@example.invalid');
    git(pusherPath, 'config', 'user.name', 'Spawnea Test');
    git(pusherPath, 'checkout', '-b', 'develop');
    writeFileSync(join(pusherPath, 'dev.txt'), 'develop content\n');
    git(pusherPath, 'add', 'dev.txt');
    git(pusherPath, 'commit', '-m', 'develop commit');
    git(pusherPath, 'push', '-u', 'origin', 'develop');
    const devSha = git(pusherPath, 'rev-parse', 'HEAD');

    // Project 1 configured base_branch is 'main', but we explicitly specify baseBranch: 'develop'
    const child = await sessionManager.createChildSession({
      parentSessionId: parent.id,
      task: 'Child on Develop',
      workspace: 'new-worktree',
      baseBranch: 'develop',
    }, 'control');

    expect(child.baseBranch).toBe('develop');
    expect(child.baseCommit).toBe(devSha);

    const childHead = git(child.worktreePath, 'rev-parse', 'HEAD');
    expect(childHead).toBe(devSha);

    // Also supports origin/develop syntax through AgentControlService
    const controlResult = await controlService.createChildSession({
      parentSession: parent.id,
      task: 'Child via Control Service',
      workspace: 'new-worktree',
      baseBranch: 'origin/develop',
    });

    expect(controlResult.baseCommit).toBe(devSha);
  });

  it('normalizes origin once when both topic and origin/topic exist at different commits', async () => {
    const parent = await sessionManager.createSession({ serverId: 'local', projectId: 'local:proj1', agentId: 'local:test-agent', task: 'Parent', useWorktree: false });
    git(repoPath1, 'branch', 'topic');
    git(repoPath1, 'push', 'origin', 'topic');
    git(repoPath1, 'checkout', '-b', 'origin/topic');
    writeFileSync(join(repoPath1, 'topic.txt'), 'qualified topic');
    git(repoPath1, 'add', 'topic.txt');
    git(repoPath1, 'commit', '-m', 'qualified topic');
    git(repoPath1, 'push', 'origin', 'refs/heads/origin/topic');
    const expected = git(repoPath1, 'rev-parse', 'HEAD');
    expect(expected).not.toBe(git(repoPath1, 'rev-parse', 'refs/heads/topic'));
    git(repoPath1, 'checkout', 'main');
    const child = await sessionManager.createChildSession({ parentSessionId: parent.id, task: 'Qualified base', workspace: 'new-worktree', baseBranch: 'origin/origin/topic' }, 'control');
    expect(child.baseBranch).toBe('origin/topic');
    expect(child.baseCommit).toBe(expected);
    expect(git(child.worktreePath, 'rev-parse', 'HEAD')).toBe(expected);
  });

  it.each(['same-project'] as const)('rejects an explicit base with workspace %s before creating resources', async (workspace) => {
    const parent = await sessionManager.createSession({ serverId: 'local', projectId: 'local:proj1', agentId: 'local:test-agent', task: 'Parent', useWorktree: false });
    await expect(sessionManager.createChildSession({ parentSessionId: parent.id, task: 'Invalid child', workspace, baseBranch: 'main' })).rejects.toThrow('baseBranch is only valid');
    expect((await repos.sessions.findAll()).length).toBe(1);
    expect(git(repoPath1, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it.each([true, false])('safely closes a remote-only base child with stashChanges=%s and preserves integration guards', async (stashChanges) => {
    const parent = await sessionManager.createSession({ serverId: 'local', projectId: 'local:proj1', agentId: 'local:test-agent', task: 'Parent', useWorktree: false });
    git(repoPath1, 'push', 'origin', 'main:develop');
    const before = git(repoPath1, 'rev-parse', 'HEAD');
    const child = await sessionManager.createChildSession({ parentSessionId: parent.id, task: 'Remote-only base', workspace: 'new-worktree', baseBranch: 'develop' }, 'control');
    expect((await sessionManager.inspectManagedWorktree(child.id)).state).toBe('active');
    await expect(sessionManager.preflightIntegration(child.id)).rejects.toThrow('Parent branch changed');
    await expect(sessionManager.finishSession(child.id, 'integrate')).rejects.toThrow('integration is blocked');
    git(child.worktreePath, 'checkout', '-b', 'unrelated');
    await expect(sessionManager.finishSession(child.id, 'close', { stashChanges })).rejects.toThrow('recorded branch');
    expect(await repos.sessions.findById(child.id)).toBeDefined();
    git(child.worktreePath, 'checkout', child.branch!);
    writeFileSync(join(child.worktreePath, 'unsaved.txt'), 'preserve or explicitly discard');
    const result = await sessionManager.finishSession(child.id, 'close', { stashChanges });
    expect(result.removed).toBe(true);
    expect(await repos.sessions.findById(child.id)).toBeNull();
    expect(git(repoPath1, 'branch', '--list', 'develop')).toBe('');
    expect(git(repoPath1, 'branch', '--show-current')).toBe('main');
    expect(git(repoPath1, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(repoPath1, 'stash', 'list').includes('Spawnea worktree:')).toBe(stashChanges);
  });

  it('aborts on error without creating partial resources or leaking child alias', async () => {
    const parent = await sessionManager.createSession({
      serverId: 'local',
      projectId: 'local:proj1',
      agentId: 'local:test-agent',
      task: 'Parent Session',
      useWorktree: false,
    });

    // Case A: Missing remote branch on origin
    await expect(
      sessionManager.createChildSession({
        parentSessionId: parent.id,
        task: 'Missing branch child',
        workspace: 'new-worktree',
        baseBranch: 'nonexistent-branch',
      }, 'control')
    ).rejects.toThrow("Failed to fetch remote branch 'origin/nonexistent-branch'");

    // Verify alias counter is not leaked: next child gets child-1
    const child1 = await sessionManager.createChildSession({
      parentSessionId: parent.id,
      task: 'Valid same-project child',
      workspace: 'same-project',
    }, 'control');
    expect(child1.childAlias).toBe('child-1');

    // Case B: No base branch configured or specified
    // Create an unconfigured project without base_branch
    const noBaseRepo = join(tempRoot, 'no-base-repo');
    git(tempRoot, 'init', '--initial-branch=main', noBaseRepo);
    git(noBaseRepo, 'config', 'user.email', 'test@example.invalid');
    git(noBaseRepo, 'config', 'user.name', 'Spawnea Test');
    writeFileSync(join(noBaseRepo, 'README.md'), 'no base\n');
    git(noBaseRepo, 'add', 'README.md');
    git(noBaseRepo, 'commit', '-m', 'init');

    await repos.projects.save({
      id: 'local:no-base',
      serverId: 'local',
      name: 'No Base Project',
      rootPath: noBaseRepo,
    });

    await expect(
      sessionManager.createChildSession({
        parentSessionId: parent.id,
        projectId: 'local:no-base',
        task: 'Child on unconfigured project',
        workspace: 'new-worktree',
      }, 'control')
    ).rejects.toThrow("No base branch configured for project 'No Base Project' or specified in request");

    // Case C: Missing origin remote
    await expect(
      sessionManager.createChildSession({
        parentSessionId: parent.id,
        projectId: 'local:no-base',
        task: 'Child on unconfigured project with branch',
        workspace: 'new-worktree',
        baseBranch: 'main',
      }, 'control')
    ).rejects.toThrow("Remote 'origin' is not configured");

    // Next child allocated alias is still child-2
    const child2 = await sessionManager.createChildSession({
      parentSessionId: parent.id,
      task: 'Second valid child',
      workspace: 'same-project',
    }, 'control');
    expect(child2.childAlias).toBe('child-2');
  });

  it('preserves same-project child behavior without fetching or creating worktree', async () => {
    const parent = await sessionManager.createSession({
      serverId: 'local',
      projectId: 'local:proj1',
      agentId: 'local:test-agent',
      task: 'Parent Session',
      useWorktree: false,
    });

    const child = await sessionManager.createChildSession({
      parentSessionId: parent.id,
      task: 'Same project child',
      workspace: 'same-project',
    }, 'control');

    expect(child.managedWorktree).toBe(false);
    expect(child.worktreePath).toBe(parent.worktreePath);
    expect(child.branch).toBe(parent.branch);
  });
});
