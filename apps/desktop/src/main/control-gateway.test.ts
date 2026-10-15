import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { createDatabase, createRepositories, type Repositories } from '@spawnea/db';
import { createLogger, type Session } from '@spawnea/domain';
import { AgentControlService, type AgentControlService as AgentControlServiceType } from './agent-control-service.js';
import { canConnectToControlSocket, ControlGateway } from './control-gateway.js';

interface ControlReply { id: number | null; result?: any; error?: { code: string; message: string } }

/** Minimal authenticated client speaking the gateway's line-delimited request protocol. */
class TestControlClient {
  private socket: Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly waiting = new Map<number, (reply: ControlReply) => void>();

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly sessionId: string | null = 'session-1',
  ) {}

  async connect(): Promise<void> {
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf('\n');
      while (newline !== -1) {
        const reply = JSON.parse(this.buffer.slice(0, newline)) as ControlReply;
        this.buffer = this.buffer.slice(newline + 1);
        if (reply.id !== null) this.waiting.get(reply.id)?.(reply);
        newline = this.buffer.indexOf('\n');
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        const auth = this.sessionId === null
          ? { type: 'spawnea-auth', token: this.token }
          : { type: 'spawnea-auth', token: this.token, sessionId: this.sessionId };
        socket.write(`${JSON.stringify(auth)}\n`);
        resolve();
      });
      socket.once('error', reject);
    });
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<ControlReply> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.socket!.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

describe('ControlGateway security boundary', () => {
  const gateways: ControlGateway[] = [];
  const directories: string[] = [];
  const databases: Array<ReturnType<typeof createDatabase>> = [];

  afterEach(async () => {
    await Promise.allSettled(gateways.splice(0).map((gateway) => gateway.close()));
    await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    databases.splice(0).forEach((database) => database.close());
  });

  async function startGateway(control: unknown, name = 'ControlGatewayTest') {
    const directory = await mkdtemp(join(tmpdir(), 'spawnea-control-gateway-'));
    directories.push(directory);
    const gateway = new ControlGateway({
      control: control as AgentControlServiceType,
      logger: createLogger(name),
      runtimeFilePath: join(directory, 'runtime.json'),
      socketPath: join(directory, 'control.sock'),
    });
    gateways.push(gateway);
    const descriptor = await gateway.start();
    return { directory, gateway, descriptor };
  }

  it('creates same-user-only runtime files, rejects a bad token, and removes runtime files on close', async () => {
    const getState = vi.fn();
    const { directory, gateway, descriptor } = await startGateway({ getState });

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

  it('serves rename-session through the authenticated Unix socket for a scoped session', async () => {
    const renameSession = vi.fn().mockResolvedValue({
      apiVersion: 'v1',
      deliveredToRenderer: false,
      session: { id: 'session-1', name: 'Socket title', task: 'Original task' },
    });
    const { descriptor } = await startGateway({
      createScopedControl: vi.fn().mockResolvedValue({ renameSession }),
    });
    const client = new TestControlClient(descriptor.socketPath, descriptor.token);
    try {
      await client.connect();
      const reply = await client.call('spawnea_rename_session', { sessionId: 'session-1', title: 'Socket title' });
      expect(reply.result).toMatchObject({
        apiVersion: 'v1',
        deliveredToRenderer: false,
        session: { id: 'session-1', name: 'Socket title', task: 'Original task' },
      });
      expect(renameSession).toHaveBeenCalledWith({ sessionId: 'session-1', title: 'Socket title' });
    } finally {
      client.close();
    }
  });

  it('waits for a newly launched root session to become available during authentication', async () => {
    const getState = vi.fn().mockResolvedValue({ apiVersion: 'v1', sessions: [] });
    const createScopedControl = vi.fn()
      .mockRejectedValueOnce(new Error('Session identity is not an active local root'))
      .mockResolvedValue({ getState });
    const { descriptor } = await startGateway({ createScopedControl });
    const client = new TestControlClient(descriptor.socketPath, descriptor.token);
    try {
      await client.connect();
      const reply = await client.call('spawnea_get_state');
      expect(reply.error).toBeUndefined();
      expect(createScopedControl).toHaveBeenCalledTimes(2);
      expect(createScopedControl).toHaveBeenCalledWith('session-1', { allowChildSession: true });
    } finally {
      client.close();
    }
  });

  it('serves the operator operations on a token-only connection and rejects scoped-only operations', async () => {
    const getState = vi.fn().mockResolvedValue({ apiVersion: 'v1', sessions: [{ id: 'root-1' }], hosts: [], projects: [], harnesses: [] });
    const { descriptor } = await startGateway({ getState });
    const client = new TestControlClient(descriptor.socketPath, descriptor.token, null);
    try {
      await client.connect();
      expect((await client.call('spawnea_list_sessions')).result).toMatchObject({ sessions: [{ id: 'root-1' }] });
      const rejected = await client.call('spawnea_rename_session', { sessionId: 'root-1', title: 'x' });
      expect(rejected.error).toMatchObject({ code: 'invalid_request' });
    } finally {
      client.close();
    }
  });

  /** Writes raw chunks to an authenticated socket and collects the first reply line. */
  async function rawExchange(socketPath: string, chunks: Buffer[]): Promise<{ reply: any; closed: boolean }> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let buffer = '';
      socket.setEncoding('utf8');
      socket.once('error', reject);
      socket.on('data', (data: string) => {
        buffer += data;
        const newline = buffer.indexOf('\n');
        if (newline !== -1) {
          const reply = JSON.parse(buffer.slice(0, newline));
          socket.destroy();
          resolve({ reply, closed: false });
        }
      });
      socket.once('close', () => resolve({ reply: undefined, closed: true }));
      socket.once('connect', async () => {
        for (const chunk of chunks) {
          socket.write(chunk);
          await new Promise((done) => setTimeout(done, 20));
        }
      });
    });
  }

  it('accepts a first request larger than the authentication limit in the same chunk', async () => {
    const sendPrompt = vi.fn().mockResolvedValue({ apiVersion: 'v1', turnId: '3d47ca17-70c0-43ac-96e9-464ddc1f28a4' });
    const { descriptor } = await startGateway({ sendPrompt, getState: vi.fn() });
    const prompt = 'p'.repeat(10_000);
    const frame = Buffer.from(
      `${JSON.stringify({ type: 'spawnea-auth', token: descriptor.token })}\n` +
      `${JSON.stringify({ id: 1, method: 'spawnea_send_prompt', params: { target: 'child', prompt } })}\n`,
    );
    const { reply } = await rawExchange(descriptor.socketPath, [frame]);
    expect(reply.error).toBeUndefined();
    expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({ prompt }));
  });

  it('preserves a multibyte character split across the authentication chunk', async () => {
    const sendPrompt = vi.fn().mockResolvedValue({ apiVersion: 'v1', turnId: '3d47ca17-70c0-43ac-96e9-464ddc1f28a4' });
    const { descriptor } = await startGateway({ sendPrompt, getState: vi.fn() });
    const frame = Buffer.from(
      `${JSON.stringify({ type: 'spawnea-auth', token: descriptor.token })}\n` +
      `${JSON.stringify({ id: 1, method: 'spawnea_send_prompt', params: { target: 'child', prompt: 'café' } })}\n`,
    );
    const split = frame.indexOf(Buffer.from('é')) + 1;
    const { reply } = await rawExchange(descriptor.socketPath, [frame.subarray(0, split), frame.subarray(split)]);
    expect(reply.error).toBeUndefined();
    expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'café' }));
  });

  it('answers a non-object request with a typed error instead of dropping it', async () => {
    const { descriptor } = await startGateway({ getState: vi.fn() });
    const frame = Buffer.from(`${JSON.stringify({ type: 'spawnea-auth', token: descriptor.token })}\nnull\n`);
    const { reply } = await rawExchange(descriptor.socketPath, [frame]);
    expect(reply?.error).toMatchObject({ code: 'invalid_request' });
  });

  it('rejects a complete request line above the size limit without dispatching it', async () => {
    const getState = vi.fn();
    const { descriptor } = await startGateway({ getState });
    const oversized = JSON.stringify({ id: 1, method: 'spawnea_get_state', params: { pad: 'x'.repeat(2 * 1024 * 1024 + 10) } });
    const frame = Buffer.from(`${JSON.stringify({ type: 'spawnea-auth', token: descriptor.token })}\n${oversized}\n`);
    const { reply } = await rawExchange(descriptor.socketPath, [frame]);
    expect(reply?.error).toMatchObject({ code: 'invalid_request' });
    expect(getState).not.toHaveBeenCalled();
  });

  it('reports typed errors for malformed arguments and unknown operations', async () => {
    const { descriptor } = await startGateway({ getState: vi.fn() });
    const client = new TestControlClient(descriptor.socketPath, descriptor.token, null);
    try {
      await client.connect();
      expect((await client.call('spawnea_status', {})).error).toMatchObject({ code: 'invalid_request' });
      expect((await client.call('no_such_operation')).error).toMatchObject({ code: 'invalid_request' });
    } finally {
      client.close();
    }
  });

  it('passes the explicit validated-close protocol through the authenticated gateway', async () => {
    const requestFinalization = vi.fn().mockResolvedValue({
      apiVersion: 'v1',
      clientRequestId: 'close-1',
      sessionId: 'session-1',
      action: 'close',
      dirtyChanges: 'stash',
      mode: 'agent-validated',
      status: 'completed',
      result: { action: 'close', removed: true },
    });
    const { descriptor } = await startGateway({
      createScopedControl: vi.fn().mockResolvedValue({ requestFinalization }),
    });
    const client = new TestControlClient(descriptor.socketPath, descriptor.token);
    try {
      await client.connect();
      const reply = await client.call('spawnea_request_finalization', {
        clientRequestId: 'close-1',
        sessionId: 'session-1',
        action: 'close',
        dirtyChanges: 'stash',
        confirmation: 'llm-validated',
        force: true,
      });
      expect(reply.result).toMatchObject({ mode: 'agent-validated', status: 'completed' });
      expect(requestFinalization).toHaveBeenCalledWith(expect.objectContaining({ confirmation: 'llm-validated' }));
    } finally {
      client.close();
    }
  });

  it('executes a validated close end-to-end without emitting a renderer confirmation', async () => {
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
    await repositories.sessions.save({ ...session, id: 'child-1', name: 'Child', parentSessionId: 'session-1', childAlias: 'child-1' });
    const finishSession = vi.fn().mockResolvedValue({ action: 'close', removed: true });
    const notifyFinalizationRequested = vi.fn();
    const control = new AgentControlService({
      repositories,
      sessionManager: { finishSession } as never,
      logger: createLogger('ControlGatewayE2ETest'),
      notifyFinalizationRequested,
    });
    const { descriptor } = await startGateway(control, 'ControlGatewayE2ETest');
    const client = new TestControlClient(descriptor.socketPath, descriptor.token);
    try {
      await client.connect();
      const reply = await client.call('spawnea_request_finalization', {
        clientRequestId: 'e2e-close-1',
        sessionId: 'child-1',
        action: 'close',
        dirtyChanges: 'stash',
        confirmation: 'llm-validated',
        force: true,
      });
      expect(reply.error).toBeUndefined();
      expect(reply.result).toMatchObject({
        mode: 'agent-validated',
        status: 'completed',
        result: { action: 'close', removed: true },
      });
      expect(finishSession).toHaveBeenCalledWith(
        'child-1',
        'close',
        { stashChanges: true },
        'agent-validated',
      );
      expect(notifyFinalizationRequested).not.toHaveBeenCalled();
    } finally {
      client.close();
    }
  });

  it('allows multiple gateways to run concurrently with distinct profiles and prevents duplicate profiles', async () => {
    const tempRuntime = await mkdtemp(join(tmpdir(), 'spawnea-runtime-multi-'));
    directories.push(tempRuntime);
    const origXdg = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = tempRuntime;

    try {
      const gatewayA = new ControlGateway({
        control: { getState: vi.fn() } as unknown as AgentControlServiceType,
        logger: createLogger('ControlGatewayTestA'),
        profile: 'profile-a',
      });
      gateways.push(gatewayA);
      const descA = await gatewayA.start();

      const gatewayB = new ControlGateway({
        control: { getState: vi.fn() } as unknown as AgentControlServiceType,
        logger: createLogger('ControlGatewayTestB'),
        profile: 'profile-b',
      });
      gateways.push(gatewayB);
      const descB = await gatewayB.start();

      expect(descA.socketPath).toContain('/profiles/profile-a/');
      expect(descB.socketPath).toContain('/profiles/profile-b/');
      expect(descA.socketPath).not.toBe(descB.socketPath);

      const collidingGatewayA = new ControlGateway({
        control: { getState: vi.fn() } as unknown as AgentControlServiceType,
        logger: createLogger('ControlGatewayTestA2'),
        profile: ' Profile-A ',
      });
      gateways.push(collidingGatewayA);
      await expect(collidingGatewayA.start()).rejects.toThrow('Another Spawnea control runtime is active');
      const originalDescriptor = await readFile(gatewayA.runtimeFilePath, 'utf8');
      await collidingGatewayA.close();
      expect(await readFile(gatewayA.runtimeFilePath, 'utf8')).toBe(originalDescriptor);
      expect(await canConnectToControlSocket(gatewayA.socketPath)).toBe(true);

      await gatewayA.close();
      const replacement = new ControlGateway({
        control: { getState: vi.fn() } as unknown as AgentControlServiceType,
        logger: createLogger('ControlGatewayReplacement'),
        profile: 'profile-a',
      });
      gateways.push(replacement);
      await replacement.start();
      const replacementDescriptor = await readFile(replacement.runtimeFilePath, 'utf8');
      await gatewayA.close();
      expect(await readFile(replacement.runtimeFilePath, 'utf8')).toBe(replacementDescriptor);
      expect(await canConnectToControlSocket(replacement.socketPath)).toBe(true);
    } finally {
      if (origXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = origXdg;
    }
  });
});
