import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDatabase,
  type DatabaseConnection,
  servers,
  projects,
  agents,
  sessions,
  artifacts,
} from '../src/index.js';

describe('Database Schema & Integrity', () => {
  let conn: DatabaseConnection;

  beforeEach(() => {
    conn = createDatabase({ path: ':memory:' });
  });

  afterEach(() => {
    conn.close();
  });

  it('inserts and retrieves servers, projects, agents, sessions, and artifacts', async () => {
    const now = new Date();

    // 1. Insert Server
    await conn.db.insert(servers).values({
      id: 'srv-1',
      name: 'GPU Server 1',
      host: '192.0.2.10',
      sshUser: 'developer',
      sshPort: 2222,
      sshConfigAlias: 'gpu-box',
      enabled: true,
      createdAt: now,
    });

    const [savedServer] = await conn.db
      .select()
      .from(servers)
      .where(eq(servers.id, 'srv-1'));
    expect(savedServer).toBeDefined();
    expect(savedServer.name).toBe('GPU Server 1');
    expect(savedServer.host).toBe('192.0.2.10');
    expect(savedServer.sshUser).toBe('developer');
    expect(savedServer.sshPort).toBe(2222);
    expect(savedServer.sshConfigAlias).toBe('gpu-box');
    expect(savedServer.enabled).toBe(true);
    expect(savedServer.createdAt.getTime()).toBe(now.getTime());

    // 2. Insert Project
    await conn.db.insert(projects).values({
      id: 'proj-1',
      serverId: 'srv-1',
      name: 'spawnea Core',
      rootPath: '/workspace/spawnea',
      repoUrl: 'https://github.com/example/spawnea.git',
      createdAt: now,
    });

    const [savedProject] = await conn.db
      .select()
      .from(projects)
      .where(eq(projects.id, 'proj-1'));
    expect(savedProject).toBeDefined();
    expect(savedProject.serverId).toBe('srv-1');
    expect(savedProject.name).toBe('spawnea Core');

    // 3. Insert Agent
    await conn.db.insert(agents).values({
      id: 'agent-1',
      name: 'Claude Code Agent',
      harness: 'claude',
      command: 'claude',
      argsTemplate: ['--model', 'claude-3-7-sonnet'],
      envVars: { ANTHROPIC_LOG: 'debug' },
      createdAt: now,
    });

    const [savedAgent] = await conn.db
      .select()
      .from(agents)
      .where(eq(agents.id, 'agent-1'));
    expect(savedAgent).toBeDefined();
    expect(savedAgent.harness).toBe('claude');
    expect(savedAgent.argsTemplate).toEqual(['--model', 'claude-3-7-sonnet']);
    expect(savedAgent.envVars).toEqual({ ANTHROPIC_LOG: 'debug' });

    // 4. Insert Session
    await conn.db.insert(sessions).values({
      id: 'sess-1',
      name: 'Feature Branch Session',
      serverId: 'srv-1',
      projectId: 'proj-1',
      agentId: 'agent-1',
      task: 'Add SQLite persistence',
      worktreePath: '/workspace/spawnea-worktrees/task-db',
      branch: 'feature/task-db',
      tmuxSessionName: 'spawnea-task-db',
      tmuxWindowName: 'main',
      status: 'working',
      createdAt: now,
      lastActivityAt: now,
    });

    const [savedSession] = await conn.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, 'sess-1'));
    expect(savedSession).toBeDefined();
    expect(savedSession.status).toBe('working');
    expect(savedSession.task).toBe('Add SQLite persistence');

    // 5. Insert Artifact
    await conn.db.insert(artifacts).values({
      id: 'art-1',
      sessionId: 'sess-1',
      direction: 'output',
      remotePath: '/workspace/spawnea/output.log',
      cachedLocalPath: '/tmp/output.log',
      filename: 'output.log',
      mimeType: 'text/plain',
      sizeBytes: 1024,
      createdAt: now,
    });

    const [savedArtifact] = await conn.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, 'art-1'));
    expect(savedArtifact).toBeDefined();
    expect(savedArtifact.direction).toBe('output');
    expect(savedArtifact.sizeBytes).toBe(1024);
  });

  it('queries related data using Drizzle relational API', async () => {
    const now = new Date();
    await conn.db.insert(servers).values({
      id: 'srv-1',
      name: 'Local',
      host: 'localhost',
      sshPort: 22,
      createdAt: now,
    });
    await conn.db.insert(projects).values({
      id: 'proj-1',
      serverId: 'srv-1',
      name: 'spawnea',
      rootPath: '/code/spawnea',
      createdAt: now,
    });
    await conn.db.insert(agents).values({
      id: 'agent-1',
      name: 'Shell',
      harness: 'shell',
      command: 'bash',
      createdAt: now,
    });
    await conn.db.insert(sessions).values({
      id: 'sess-1',
      name: 'Test Session',
      serverId: 'srv-1',
      projectId: 'proj-1',
      agentId: 'agent-1',
      task: 'Test relational queries',
      worktreePath: '/code/spawnea',
      branch: 'main',
      tmuxSessionName: 'mux-test',
      createdAt: now,
      lastActivityAt: now,
    });
    await conn.db.insert(artifacts).values({
      id: 'art-1',
      sessionId: 'sess-1',
      direction: 'input',
      remotePath: '/tmp/input.txt',
      filename: 'input.txt',
      mimeType: 'text/plain',
      sizeBytes: 42,
      createdAt: now,
    });

    const serverWithRelations = await conn.db.query.servers.findFirst({
      where: eq(servers.id, 'srv-1'),
      with: {
        projects: true,
        sessions: {
          with: {
            artifacts: true,
            agent: true,
            project: true,
          },
        },
      },
    });

    expect(serverWithRelations).toBeDefined();
    expect(serverWithRelations?.projects).toHaveLength(1);
    expect(serverWithRelations?.sessions).toHaveLength(1);
    expect(serverWithRelations?.sessions[0].artifacts).toHaveLength(1);
    expect(serverWithRelations?.sessions[0].agent.name).toBe('Shell');
    expect(serverWithRelations?.sessions[0].project.name).toBe('spawnea');
  });

  it('cascades project deletion when server is deleted (if no session references server)', async () => {
    const now = new Date();
    await conn.db.insert(servers).values({
      id: 'srv-tmp',
      name: 'Tmp Server',
      host: 'tmp.example.com',
      sshPort: 22,
      createdAt: now,
    });
    await conn.db.insert(projects).values({
      id: 'proj-tmp',
      serverId: 'srv-tmp',
      name: 'Tmp Project',
      rootPath: '/tmp/proj',
      createdAt: now,
    });

    await conn.db.delete(servers).where(eq(servers.id, 'srv-tmp'));

    const remainingProjects = await conn.db
      .select()
      .from(projects)
      .where(eq(projects.id, 'proj-tmp'));
    expect(remainingProjects).toHaveLength(0);
  });

  it('cascades artifact deletion when session is deleted', async () => {
    const now = new Date();
    await conn.db.insert(servers).values({
      id: 'srv-1',
      name: 'Local',
      host: 'localhost',
      sshPort: 22,
      createdAt: now,
    });
    await conn.db.insert(projects).values({
      id: 'proj-1',
      serverId: 'srv-1',
      name: 'spawnea',
      rootPath: '/code',
      createdAt: now,
    });
    await conn.db.insert(agents).values({
      id: 'agent-1',
      name: 'Shell',
      harness: 'shell',
      command: 'bash',
      createdAt: now,
    });
    await conn.db.insert(sessions).values({
      id: 'sess-1',
      name: 'Session',
      serverId: 'srv-1',
      projectId: 'proj-1',
      agentId: 'agent-1',
      task: 'Task',
      worktreePath: '/code',
      branch: 'main',
      tmuxSessionName: 'mux',
      createdAt: now,
      lastActivityAt: now,
    });
    await conn.db.insert(artifacts).values({
      id: 'art-1',
      sessionId: 'sess-1',
      direction: 'input',
      remotePath: '/tmp/in.txt',
      filename: 'in.txt',
      mimeType: 'text/plain',
      sizeBytes: 10,
      createdAt: now,
    });

    await conn.db.delete(sessions).where(eq(sessions.id, 'sess-1'));

    const remainingArtifacts = await conn.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, 'art-1'));
    expect(remainingArtifacts).toHaveLength(0);
  });

  it('enforces RESTRICT foreign key constraint when deleting server, project, or agent referenced by a session', async () => {
    const now = new Date();
    await conn.db.insert(servers).values({
      id: 'srv-1',
      name: 'Local',
      host: 'localhost',
      sshPort: 22,
      createdAt: now,
    });
    await conn.db.insert(projects).values({
      id: 'proj-1',
      serverId: 'srv-1',
      name: 'spawnea',
      rootPath: '/code',
      createdAt: now,
    });
    await conn.db.insert(agents).values({
      id: 'agent-1',
      name: 'Shell',
      harness: 'shell',
      command: 'bash',
      createdAt: now,
    });
    await conn.db.insert(sessions).values({
      id: 'sess-1',
      name: 'Session',
      serverId: 'srv-1',
      projectId: 'proj-1',
      agentId: 'agent-1',
      task: 'Task',
      worktreePath: '/code',
      branch: 'main',
      tmuxSessionName: 'mux',
      createdAt: now,
      lastActivityAt: now,
    });

    // Deleting server referenced by session should fail
    expect(() =>
      conn.sqlite.prepare('DELETE FROM servers WHERE id = ?').run('srv-1'),
    ).toThrowError(/FOREIGN KEY constraint failed/);

    // Deleting project referenced by session should fail
    expect(() =>
      conn.sqlite.prepare('DELETE FROM projects WHERE id = ?').run('proj-1'),
    ).toThrowError(/FOREIGN KEY constraint failed/);

    // Deleting agent referenced by session should fail
    expect(() =>
      conn.sqlite.prepare('DELETE FROM agents WHERE id = ?').run('agent-1'),
    ).toThrowError(/FOREIGN KEY constraint failed/);
  });

  it('rejects foreign key violation when inserting project with invalid serverId', async () => {
    const now = new Date();
    await expect(
      conn.db.insert(projects).values({
        id: 'proj-invalid',
        serverId: 'non-existent-server',
        name: 'Invalid Project',
        rootPath: '/tmp/invalid',
        createdAt: now,
      }),
    ).rejects.toThrowError(/FOREIGN KEY constraint failed/);
  });

  it('strictly contains no credentials, passwords, or private keys in the schema', () => {
    const serverColumns = conn.sqlite
      .prepare('PRAGMA table_info(servers)')
      .all() as { name: string }[];
    const columnNames = serverColumns.map((c) => c.name.toLowerCase());

    expect(columnNames).not.toContain('password');
    expect(columnNames).not.toContain('private_key');
    expect(columnNames).not.toContain('secret');
    expect(columnNames).not.toContain('token');
    expect(columnNames).not.toContain('key');
  });
});
