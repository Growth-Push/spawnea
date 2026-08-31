import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import {
  Client,
  ReadBuffer,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client';
import { createDatabase, createRepositories, type Repositories } from '@spawnea/db';
import { createLogger, type Session } from '@spawnea/domain';
import { AgentControlService, type AgentControlService as AgentControlServiceType } from './agent-control-service.js';
import { ControlMcpGateway } from './control-mcp-gateway.js';

class AuthenticatedSocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly readBuffer = new ReadBuffer();
  private socket: Socket | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly authType: 'spawnea-auth' | 'spawnea-auth' = 'spawnea-auth',
  ) {}

  async start(): Promise<void> {
    if (this.socket) throw new Error('Transport already started');
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    socket.on('data', (chunk) => {
      this.readBuffer.append(chunk);
      let message: JSONRPCMessage | null;
      while ((message = this.readBuffer.readMessage()) !== null) this.onmessage?.(message);
    });
    socket.on('error', (error) => this.onerror?.(error));
    socket.on('close', () => this.onclose?.());
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ type: this.authType, token: this.token })}\n`);
        resolve();
      });
      socket.once('error', reject);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.socket) throw new Error('Transport not started');
    await new Promise<void>((resolve, reject) => {
      this.socket!.write(serializeMessage(message), (error) => error ? reject(error) : resolve());
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.readBuffer.clear();
    if (!socket || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.once('close', resolve);
      socket.end();
    });
  }
}

describe('ControlMcpGateway security boundary', () => {
  const gateways: ControlMcpGateway[] = [];
  const directories: string[] = [];
  const databases: Array<ReturnType<typeof createDatabase>> = [];

  afterEach(async () => {
    await Promise.allSettled(gateways.splice(0).map((gateway) => gateway.close()));
    await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    databases.splice(0).forEach((database) => database.close());
  });

  it('creates same-user-only runtime files, rejects a bad token, and removes runtime files on close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spawnea-control-gateway-'));
    directories.push(directory);
    const getState = vi.fn();
    const gateway = new ControlMcpGateway({
      control: { getState } as unknown as AgentControlServiceType,
      logger: createLogger('ControlMcpGatewayTest'),
      runtimeFilePath: join(directory, 'runtime.json'),
      socketPath: join(directory, 'control.sock'),
    });
    gateways.push(gateway);
    const descriptor = await gateway.start();

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(descriptor.socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(gateway.runtimeFilePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(gateway.runtimeFilePath, 'utf8'))).toMatchObject({
      apiVersion: 'v1', socketPath: descriptor.socketPath, pid: process.pid,
    });

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(descriptor.socketPath);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ type: 'spawnea-auth', token: 'wrong-token' })}\n`);
      });
      socket.once('close', () => resolve());
    });

    expect(getState).not.toHaveBeenCalled();

    await gateway.close();
    await expect(stat(gateway.runtimeFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(descriptor.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serves rename-session through the authenticated Unix socket', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spawnea-control-gateway-'));
    directories.push(directory);
    const renameSession = vi.fn().mockResolvedValue({
      apiVersion: 'v1',
      deliveredToRenderer: false,
      session: { id: 'session-1', name: 'Socket title', task: 'Original task' },
    });
    const gateway = new ControlMcpGateway({
      control: { renameSession } as unknown as AgentControlServiceType,
      logger: createLogger('ControlMcpGatewayTest'),
      runtimeFilePath: join(directory, 'runtime.json'),
      socketPath: join(directory, 'control.sock'),
    });
    gateways.push(gateway);
    const descriptor = await gateway.start();
    const client = new Client({ name: 'spawnea-gateway-test', version: '1.0.0' });

    try {
      await client.connect(new AuthenticatedSocketTransport(descriptor.socketPath, descriptor.token));
      const result = await client.callTool({
        name: 'spawnea_rename_session',
        arguments: { sessionId: 'session-1', title: 'Socket title' },
      });

      expect(result.structuredContent).toMatchObject({
        apiVersion: 'v1',
        deliveredToRenderer: false,
        session: { id: 'session-1', name: 'Socket title', task: 'Original task' },
      });
      expect(renameSession).toHaveBeenCalledWith({ sessionId: 'session-1', title: 'Socket title' });
    } finally {
      await client.close();
    }
  });

  it('passes the explicit validated-close protocol through the authenticated gateway', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spawnea-control-gateway-'));
    directories.push(directory);
    const requestFinalization = vi.fn().mockResolvedValue({
      apiVersion: 'v1',
      clientRequestId: 'close-1',
      sessionId: 'session-1',
      action: 'close',
      dirtyChanges: 'stash',
      mode: 'mcp-validated',
      status: 'completed',
      result: { action: 'close', removed: true },
    });
    const gateway = new ControlMcpGateway({
      control: { requestFinalization } as unknown as AgentControlService,
      logger: createLogger('ControlMcpGatewayTest'),
      runtimeFilePath: join(directory, 'runtime.json'),
      socketPath: join(directory, 'control.sock'),
    });
    gateways.push(gateway);
    const descriptor = await gateway.start();
    const client = new Client({ name: 'spawnea-gateway-test', version: '1.0.0' });

    try {
      await client.connect(new AuthenticatedSocketTransport(descriptor.socketPath, descriptor.token, 'spawnea-auth'));
      const result = await client.callTool({
        name: 'spawnea_request_finalization',
        arguments: {
          clientRequestId: 'close-1',
          sessionId: 'session-1',
          action: 'close',
          dirtyChanges: 'stash',
          confirmation: 'llm-validated',
        },
      });

      expect(result.structuredContent).toMatchObject({ mode: 'mcp-validated', status: 'completed' });
      expect(requestFinalization).toHaveBeenCalledWith(expect.objectContaining({
        confirmation: 'llm-validated',
      }));
    } finally {
      await client.close();
    }
  });

  it('executes a validated MCP close end-to-end without emitting a renderer confirmation', async () => {
    const database = createDatabase({ path: ':memory:', migrate: true });
    databases.push(database);
    const repositories: Repositories = createRepositories(database.db);
    await repositories.servers.save({
      id: 'host-1', name: 'Local host', host: 'localhost', sshPort: 22, enabled: true,
    });
    await repositories.projects.save({
      id: 'project-1', serverId: 'host-1', name: 'Spawnea', rootPath: '/repo', baseBranch: 'main',
    });
    await repositories.agents.save({
      id: 'agent-1', name: 'Codex', harness: 'codex', command: 'codex',
    });
    const session: Session = {
      id: 'session-1',
      name: 'Close me',
      serverId: 'host-1',
      projectId: 'project-1',
      agentId: 'agent-1',
      task: 'Close me',
      worktreePath: '/repo/worktrees/task',
      branch: 'spawnea/task',
      baseBranch: 'main',
      managedWorktree: true,
      tmuxSessionName: 'spawnea-task',
      status: 'working',
      createdAt: new Date('2026-08-27T10:00:00.000Z'),
      lastActivityAt: new Date('2026-08-27T10:01:00.000Z'),
    };
    await repositories.sessions.save(session);
    const finishSession = vi.fn().mockResolvedValue({ action: 'close', removed: true });
    const notifyFinalizationRequested = vi.fn();
    const control = new AgentControlService({
      repositories,
      sessionManager: { finishSession } as never,
      logger: createLogger('ControlMcpGatewayE2ETest'),
      notifyFinalizationRequested,
    });
    const directory = await mkdtemp(join(tmpdir(), 'spawnea-control-gateway-'));
    directories.push(directory);
    const gateway = new ControlMcpGateway({
      control,
      logger: createLogger('ControlMcpGatewayE2ETest'),
      runtimeFilePath: join(directory, 'runtime.json'),
      socketPath: join(directory, 'control.sock'),
    });
    gateways.push(gateway);
    const descriptor = await gateway.start();
    const client = new Client({ name: 'spawnea-gateway-e2e-test', version: '1.0.0' });

    try {
      await client.connect(new AuthenticatedSocketTransport(descriptor.socketPath, descriptor.token));
      const result = await client.callTool({
        name: 'spawnea_request_finalization',
        arguments: {
          clientRequestId: 'e2e-close-1',
          sessionId: 'session-1',
          action: 'close',
          dirtyChanges: 'stash',
          confirmation: 'llm-validated',
        },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        mode: 'mcp-validated',
        status: 'completed',
        result: { action: 'close', removed: true },
      });
      expect(finishSession).toHaveBeenCalledWith(
        'session-1',
        'close',
        { stashChanges: true },
        'mcp-validated'
      );
      expect(notifyFinalizationRequested).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
