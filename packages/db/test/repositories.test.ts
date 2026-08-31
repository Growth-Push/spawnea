import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createDatabase,
  type DatabaseConnection,
  createRepositories,
  type Repositories,
  SqliteServerRepository,
  SqliteProjectRepository,
  SqliteAgentRepository,
  SqliteSessionRepository,
  SqliteArtifactRepository,
} from '../src/index.js';
import {
  createLogger,
  type LogEntry,
  type Server,
  type Project,
  type Agent,
  type Session,
  type Artifact,
} from '@spawnea/domain';

describe('Domain Repositories & Logging Integration', () => {
  let conn: DatabaseConnection;
  let repos: Repositories;
  let logs: LogEntry[];

  beforeEach(() => {
    logs = [];
    const logger = createLogger('test-db', {
      minLevel: 'debug',
      handlers: [(entry) => logs.push(entry)],
    });

    conn = createDatabase({ path: ':memory:' });
    repos = createRepositories(conn.db, { logger });
  });

  afterEach(() => {
    conn.close();
  });

  describe('createRepositories factory', () => {
    it('creates all 5 repository instances with proper types', () => {
      expect(repos.servers).toBeInstanceOf(SqliteServerRepository);
      expect(repos.projects).toBeInstanceOf(SqliteProjectRepository);
      expect(repos.agents).toBeInstanceOf(SqliteAgentRepository);
      expect(repos.sessions).toBeInstanceOf(SqliteSessionRepository);
      expect(repos.artifacts).toBeInstanceOf(SqliteArtifactRepository);
    });
  });

  describe('ServerRepository', () => {
    it('performs CRUD operations and logs properly', async () => {
      const now = new Date();
      const serverInput: Omit<Server, 'createdAt'> & { createdAt?: Date } = {
        id: 'srv-prod',
        name: 'Production Worker',
        host: '198.51.100.5',
        sshUser: 'ubuntu',
        sshPort: 22,
        sshConfigAlias: 'prod-worker',
        enabled: true,
        createdAt: now,
      };

      // 1. Create / Save
      const saved = await repos.servers.save(serverInput);
      expect(saved.id).toBe('srv-prod');
      expect(saved.name).toBe('Production Worker');
      expect(saved.sshUser).toBe('ubuntu');
      expect(saved.sshConfigAlias).toBe('prod-worker');
      expect(saved.createdAt.getTime()).toBe(now.getTime());

      // 2. Find by ID
      const found = await repos.servers.findById('srv-prod');
      expect(found).not.toBeNull();
      expect(found?.name).toBe('Production Worker');

      // 3. Find All
      const all = await repos.servers.findAll();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('srv-prod');

      // 4. Update
      const updated = await repos.servers.update('srv-prod', {
        name: 'Production Worker (Updated)',
        enabled: false,
      });
      expect(updated.name).toBe('Production Worker (Updated)');
      expect(updated.enabled).toBe(false);
      expect(updated.host).toBe('198.51.100.5');

      // 5. Upsert via save
      const upserted = await repos.servers.save({
        ...updated,
        name: 'Production Worker (Upserted)',
      });
      expect(upserted.name).toBe('Production Worker (Upserted)');

      // 6. Delete
      const deleted = await repos.servers.delete('srv-prod');
      expect(deleted).toBe(true);

      const afterDelete = await repos.servers.findById('srv-prod');
      expect(afterDelete).toBeNull();

      const deletedAgain = await repos.servers.delete('srv-prod');
      expect(deletedAgain).toBe(false);
    });

    it('throws error when updating non-existent server', async () => {
      await expect(
        repos.servers.update('non-existent', { name: 'New Name' }),
      ).rejects.toThrowError(/not found/);
    });
  });

  describe('ProjectRepository', () => {
    beforeEach(async () => {
      await repos.servers.save({
        id: 'srv-1',
        name: 'Main Server',
        host: 'localhost',
        sshPort: 22,
        enabled: true,
      });
    });

    it('performs CRUD and filters by serverId', async () => {
      const now = new Date();
      const projInput: Omit<Project, 'createdAt'> & { createdAt?: Date } = {
        id: 'proj-1',
        serverId: 'srv-1',
        name: 'Spawnea Core',
        rootPath: '/workspace/Spawnea',
        repoUrl: 'https://github.com/spawnea/spawnea.git',
        createdAt: now,
      };

      // 1. Save
      const created = await repos.projects.save(projInput);
      expect(created.id).toBe('proj-1');
      expect(created.repoUrl).toBe('https://github.com/spawnea/spawnea.git');

      // 2. Find by Server ID
      const byServer = await repos.projects.findByServerId('srv-1');
      expect(byServer).toHaveLength(1);
      expect(byServer[0].id).toBe('proj-1');

      const byOtherServer = await repos.projects.findByServerId('srv-unknown');
      expect(byOtherServer).toHaveLength(0);

      // 3. Update
      const updated = await repos.projects.update('proj-1', {
        name: 'Spawnea Enterprise',
      });
      expect(updated.name).toBe('Spawnea Enterprise');

      // 4. Delete
      const deleted = await repos.projects.delete('proj-1');
      expect(deleted).toBe(true);
      expect(await repos.projects.findById('proj-1')).toBeNull();
    });

    it('fails to insert project with invalid serverId and logs error', async () => {
      await expect(
        repos.projects.save({
          id: 'proj-bad',
          serverId: 'srv-missing',
          name: 'Bad Project',
          rootPath: '/bad',
        }),
      ).rejects.toThrowError(/FOREIGN KEY constraint failed/);

      const errorLogs = logs.filter((l) => l.level === 'error');
      expect(errorLogs.length).toBeGreaterThan(0);
    });
  });

  describe('AgentRepository', () => {
    it('performs CRUD with argsTemplate and envVars JSON serialization', async () => {
      const now = new Date();
      const agentInput: Omit<Agent, 'createdAt'> & { createdAt?: Date } = {
        id: 'agent-claude',
        name: 'Claude Code Agent',
        harness: 'claude',
        command: 'claude',
        argsTemplate: ['--model', 'claude-3-7-sonnet', '--verbose'],
        envVars: {
          ANTHROPIC_API_KEY: 'sk-ant-testkey1234567890',
          CUSTOM_FLAG: 'enabled',
        },
        createdAt: now,
      };

      // 1. Save
      const created = await repos.agents.save(agentInput);
      expect(created.id).toBe('agent-claude');
      expect(created.argsTemplate).toEqual(['--model', 'claude-3-7-sonnet', '--verbose']);
      expect(created.envVars).toEqual({
        ANTHROPIC_API_KEY: 'sk-ant-testkey1234567890',
        CUSTOM_FLAG: 'enabled',
      });

      // 2. Find by ID
      const found = await repos.agents.findById('agent-claude');
      expect(found).not.toBeNull();
      expect(found?.command).toBe('claude');

      // 3. Update
      const updated = await repos.agents.update('agent-claude', {
        name: 'Claude Code 3.7 High',
        argsTemplate: ['--model', 'claude-3-7-sonnet-thought'],
      });
      expect(updated.name).toBe('Claude Code 3.7 High');
      expect(updated.argsTemplate).toEqual(['--model', 'claude-3-7-sonnet-thought']);

      // 4. Delete
      const deleted = await repos.agents.delete('agent-claude');
      expect(deleted).toBe(true);
      expect(await repos.agents.findById('agent-claude')).toBeNull();
    });
  });

  describe('SessionRepository', () => {
    beforeEach(async () => {
      await repos.servers.save({
        id: 'srv-1',
        name: 'Main Server',
        host: 'localhost',
        sshPort: 22,
        enabled: true,
      });
      await repos.projects.save({
        id: 'proj-1',
        serverId: 'srv-1',
        name: 'Spawnea Core',
        rootPath: '/code/Spawnea',
      });
      await repos.agents.save({
        id: 'agent-1',
        name: 'Claude Code',
        harness: 'claude',
        command: 'claude',
      });
    });

    it('performs CRUD and filters by server, project, agent, and status', async () => {
      const now = new Date();
      const sessionInput: Omit<Session, 'createdAt' | 'lastActivityAt'> & {
        createdAt?: Date;
        lastActivityAt?: Date;
      } = {
        id: 'sess-1',
        name: 'Feature Persistence',
        serverId: 'srv-1',
        projectId: 'proj-1',
        agentId: 'agent-1',
        task: 'Add repositories and tests',
        worktreePath: '/code/Spawnea-worktrees/task-1',
        branch: 'feature/task-1',
        baseBranch: 'main',
        baseCommit: '0123456789abcdef0123456789abcdef01234567',
        managedWorktree: true,
        tmuxSessionName: 'spawnea-task-1',
        tmuxWindowName: 'editor',
        status: 'starting',
        creationSource: 'mcp',
        createdAt: now,
        lastActivityAt: now,
      };

      // 1. Save
      const created = await repos.sessions.save(sessionInput);
      expect(created.id).toBe('sess-1');
      expect(created.status).toBe('starting');
      expect(created.baseBranch).toBe('main');
      expect(created.baseCommit).toBe('0123456789abcdef0123456789abcdef01234567');
      expect(created.managedWorktree).toBe(true);
      expect(created.creationSource).toBe('mcp');

      // 2. Filters
      const byServer = await repos.sessions.findByServerId('srv-1');
      expect(byServer).toHaveLength(1);

      const byProj = await repos.sessions.findByProjectId('proj-1');
      expect(byProj).toHaveLength(1);

      const byAgent = await repos.sessions.findByAgentId('agent-1');
      expect(byAgent).toHaveLength(1);

      const byStatus = await repos.sessions.findByStatus('starting');
      expect(byStatus).toHaveLength(1);

      const byWorkingStatus = await repos.sessions.findByStatus('working');
      expect(byWorkingStatus).toHaveLength(0);

      // 3. Status Transition Update
      const activityTime = new Date(now.getTime() + 5000);
      const updatedStatus = await repos.sessions.updateStatus('sess-1', 'working', activityTime);
      expect(updatedStatus.status).toBe('working');
      expect(updatedStatus.lastActivityAt.getTime()).toBe(activityTime.getTime());

      // 4. Update fields
      const updated = await repos.sessions.update('sess-1', {
        branch: 'feature/task-1-revised',
      });
      expect(updated.branch).toBe('feature/task-1-revised');

      // 5. Delete
      const deleted = await repos.sessions.delete('sess-1');
      expect(deleted).toBe(true);
      expect(await repos.sessions.findById('sess-1')).toBeNull();
    });

    it('prevents deletion of server/project/agent while session exists (FK restrict)', async () => {
      await repos.sessions.save({
        id: 'sess-fk-test',
        name: 'FK Test Session',
        serverId: 'srv-1',
        projectId: 'proj-1',
        agentId: 'agent-1',
        task: 'FK Test',
        worktreePath: '/code/test',
        branch: 'main',
        tmuxSessionName: 'test-session',
        status: 'working',
      });

      await expect(repos.servers.delete('srv-1')).rejects.toThrowError(
        /FOREIGN KEY constraint failed/,
      );
      await expect(repos.projects.delete('proj-1')).rejects.toThrowError(
        /FOREIGN KEY constraint failed/,
      );
      await expect(repos.agents.delete('agent-1')).rejects.toThrowError(
        /FOREIGN KEY constraint failed/,
      );
    });
  });

  describe('ArtifactRepository', () => {
    beforeEach(async () => {
      await repos.servers.save({
        id: 'srv-1',
        name: 'Main Server',
        host: 'localhost',
        sshPort: 22,
        enabled: true,
      });
      await repos.projects.save({
        id: 'proj-1',
        serverId: 'srv-1',
        name: 'Spawnea Core',
        rootPath: '/code/Spawnea',
      });
      await repos.agents.save({
        id: 'agent-1',
        name: 'Claude Code',
        harness: 'claude',
        command: 'claude',
      });
      await repos.sessions.save({
        id: 'sess-1',
        name: 'Session',
        serverId: 'srv-1',
        projectId: 'proj-1',
        agentId: 'agent-1',
        task: 'Task',
        worktreePath: '/code/Spawnea',
        branch: 'main',
        tmuxSessionName: 'mux',
        status: 'working',
      });
    });

    it('performs CRUD and filters by sessionId', async () => {
      const now = new Date();
      const artifactInput: Omit<Artifact, 'createdAt'> & { createdAt?: Date } = {
        id: 'art-1',
        sessionId: 'sess-1',
        direction: 'output',
        remotePath: '/code/spawnea/report.pdf',
        cachedLocalPath: '/tmp/report.pdf',
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        createdAt: now,
      };

      // 1. Save
      const created = await repos.artifacts.save(artifactInput);
      expect(created.id).toBe('art-1');
      expect(created.filename).toBe('report.pdf');

      // 2. Find by ID
      const found = await repos.artifacts.findById('art-1');
      expect(found).not.toBeNull();
      expect(found?.sizeBytes).toBe(2048);

      // 3. Find by Session ID
      const bySession = await repos.artifacts.findBySessionId('sess-1');
      expect(bySession).toHaveLength(1);
      expect(bySession[0].id).toBe('art-1');

      // 4. Cascade delete on session delete
      await repos.sessions.delete('sess-1');
      const remaining = await repos.artifacts.findById('art-1');
      expect(remaining).toBeNull();
    });
  });

  describe('Zero-Secret Storage Policy Verification', () => {
    it('verifies that no credentials, passwords, tokens, or private keys exist in any table columns', () => {
      const tableNames = ['servers', 'projects', 'agents', 'sessions', 'artifacts'];

      for (const table of tableNames) {
        const columns = conn.sqlite
          .prepare(`PRAGMA table_info(${table})`)
          .all() as { name: string }[];
        const names = columns.map((c) => c.name.toLowerCase());

        expect(names).not.toContain('password');
        expect(names).not.toContain('passwd');
        expect(names).not.toContain('private_key');
        expect(names).not.toContain('secret');
        expect(names).not.toContain('token');
        expect(names).not.toContain('credential');
        expect(names).not.toContain('auth_token');
        expect(names).not.toContain('ssh_key');
      }
    });

    it('verifies server entity persistence strictly stores host descriptors only', async () => {
      await repos.servers.save({
        id: 'srv-clean',
        name: 'Clean Host',
        host: 'remote.example.com',
        sshUser: 'remote-user',
        sshPort: 2222,
        sshConfigAlias: 'bastion-hop',
        enabled: true,
      });

      const rawRow = conn.sqlite
        .prepare('SELECT * FROM servers WHERE id = ?')
        .get('srv-clean') as Record<string, unknown>;

      expect(Object.keys(rawRow)).toEqual([
        'id',
        'name',
        'host',
        'ssh_user',
        'ssh_port',
        'ssh_config_alias',
        'enabled',
        'created_at',
      ]);
      expect(rawRow.host).toBe('remote.example.com');
      expect(rawRow.ssh_user).toBe('remote-user');
    });
  });

  describe('Troubleshooting Logs & Sensitive Data Masking Verification', () => {
    it('records helpful troubleshooting logs during repository operations', async () => {
      await repos.servers.save({
        id: 'srv-log-test',
        name: 'Logging Server',
        host: '192.0.2.1',
        sshPort: 22,
        enabled: true,
      });

      expect(logs.some((l) => l.message.includes('Saving server'))).toBe(true);
      expect(logs.some((l) => l.namespace.includes('server-repo'))).toBe(true);
    });

    it('masks sensitive environment variables and tokens in repository logs', async () => {
      await repos.agents.save({
        id: 'agent-sensitive',
        name: 'Agent with Keys',
        harness: 'claude',
        command: 'claude',
        envVars: {
          ANTHROPIC_API_KEY: 'sk-ant-secretkey999888777',
          AUTH_TOKEN: 'Bearer secrettoken123456',
          DATABASE_URL: 'postgres://user:super_secret_password@db:5432/main',
        },
      });

      // Find the log entry for saving the agent
      const agentLog = logs.find(
        (l) => l.namespace.includes('agent-repo') && l.message.includes('Saving agent'),
      );
      expect(agentLog).toBeDefined();

      const logContextStr = JSON.stringify(agentLog?.context);
      expect(logContextStr).not.toContain('sk-ant-secretkey999888777');
      expect(logContextStr).not.toContain('super_secret_password');
      expect(logContextStr).toContain('[REDACTED]');
    });
  });
});
