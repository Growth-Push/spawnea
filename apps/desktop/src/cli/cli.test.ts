import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, getAgentSkillPrompt } from '@spawnea/domain';
import { ControlMcpGateway } from '../main/control-mcp-gateway.js';
import type { AgentControlService as AgentControlServiceType } from '../main/agent-control-service.js';
import { ControlCliClient } from './client.js';
import { parseArgs, runCli } from './index.js';
import { createSession, createChild, pollTurn, sendPrompt, sendAndWaitPrompt, showSkillPrompt, waitTurn } from './commands.js';

describe('Spawnea Control CLI', () => {
  const gateways: ControlMcpGateway[] = [];
  const directories: string[] = [];
  const clients: ControlCliClient[] = [];

  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await Promise.allSettled(gateways.splice(0).map((g) => g.close()));
    await Promise.allSettled(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
    vi.restoreAllMocks();
  });

  describe('parseArgs', () => {
    it('parses list command with flags', () => {
      const parsed = parseArgs(['list', '--json', '--profile', 'test-prof']);
      expect(parsed.command).toBe('list');
      expect(parsed.flags.json).toBe(true);
      expect(parsed.flags.profile).toBe('test-prof');
    });

    it('parses status command with positional session ID', () => {
      const parsed = parseArgs(['status', 'sess-123', '--json']);
      expect(parsed.command).toBe('status');
      expect(parsed.subcommand).toBe('sess-123');
      expect(parsed.flags.json).toBe(true);
    });

    it('parses session create command with options', () => {
      const parsed = parseArgs([
        'session',
        'create',
        '--project',
        'spawnea',
        '--task',
        'Implement CLI',
        '--agent',
        'codex',
        '--no-worktree',
      ]);
      expect(parsed.command).toBe('session');
      expect(parsed.subcommand).toBe('create');
      expect(parsed.flags.project).toBe('spawnea');
      expect(parsed.flags.task).toBe('Implement CLI');
      expect(parsed.flags.agent).toBe('codex');
      expect(parsed.flags['no-worktree']).toBe(true);
    });

    it('parses child create command', () => {
      const parsed = parseArgs([
        'child',
        'create',
        '--parent',
        'root-1',
        '--task',
        'Child task',
        '--workspace',
        'new-worktree',
      ]);
      expect(parsed.command).toBe('child');
      expect(parsed.subcommand).toBe('create');
      expect(parsed.flags.parent).toBe('root-1');
      expect(parsed.flags.task).toBe('Child task');
      expect(parsed.flags.workspace).toBe('new-worktree');
    });

    it('parses prompt send and prompt wait', () => {
      const parsedSend = parseArgs(['prompt', 'send', '--session', 'child-1', 'Run tests']);
      expect(parsedSend.command).toBe('prompt');
      expect(parsedSend.subcommand).toBe('send');
      expect(parsedSend.flags.session).toBe('child-1');
      expect(parsedSend.positional).toEqual(['Run tests']);

      const parsedWait = parseArgs(['prompt', 'wait', '--turn', 'turn-abc', '--timeout', '60']);
      expect(parsedWait.command).toBe('prompt');
      expect(parsedWait.subcommand).toBe('wait');
      expect(parsedWait.flags.turn).toBe('turn-abc');
      expect(parsedWait.flags.timeout).toBe('60');
    });

    it('parses session close with --force', () => {
      const parsed = parseArgs(['session', 'close', 'child-1', '--force']);
      expect(parsed.command).toBe('session');
      expect(parsed.subcommand).toBe('close');
      expect(parsed.positional).toEqual(['child-1']);
      expect(parsed.flags.force).toBe(true);
    });

    it('parses boolean flags without consuming following positional arguments', () => {
      const parsed = parseArgs(['prompt', 'send', '--session', 'child-1', '--json', 'Run tests']);
      expect(parsed.command).toBe('prompt');
      expect(parsed.subcommand).toBe('send');
      expect(parsed.flags.session).toBe('child-1');
      expect(parsed.flags.json).toBe(true);
      expect(parsed.positional).toEqual(['Run tests']);

      const parsedForceFirst = parseArgs(['session', 'close', '--force', 'child-1']);
      expect(parsedForceFirst.command).toBe('session');
      expect(parsedForceFirst.subcommand).toBe('close');
      expect(parsedForceFirst.flags.force).toBe(true);
      expect(parsedForceFirst.positional).toEqual(['child-1']);
    });

    it('parses --request-id and --timeout for session create and child create', () => {
      const parsedSession = parseArgs([
        'session',
        'create',
        '--project',
        'proj-1',
        '--task',
        'Task',
        '--request-id',
        'req-123',
        '--timeout',
        '60',
      ]);
      expect(parsedSession.flags['request-id']).toBe('req-123');
      expect(parsedSession.flags.timeout).toBe('60');

      const parsedChild = parseArgs([
        'child',
        'create',
        '--parent',
        'parent-1',
        '--task',
        'Subtask',
        '--request-id',
        'req-456',
        '--timeout',
        '90',
      ]);
      expect(parsedChild.flags['request-id']).toBe('req-456');
      expect(parsedChild.flags.timeout).toBe('90');
    });

    it('throws when a non-boolean flag is missing a value', () => {
      expect(() => parseArgs(['session', 'create', '--project'])).toThrow("Flag '--project' requires a value.");
      expect(() => parseArgs(['session', 'create', '--project', '--task', 'do-work'])).toThrow("Flag '--project' requires a value.");
    });
  });

  describe('skill prompt generation', () => {
    it('generates self-contained markdown with CLI commands and rules', () => {
      const prompt = getAgentSkillPrompt();
      expect(prompt).toContain('spawnea list');
      expect(prompt).toContain('spawnea status <session-id>');
      expect(prompt).toContain('spawnea child create');
      expect(prompt).toContain('spawnea prompt send-and-wait');
      expect(prompt).toContain('spawnea session close');
      expect(prompt).toContain('No silent background installs');
      expect(prompt).toContain('$SPAWNEA_SESSION_ID');
      expect(prompt).toContain('.agents/skills/spawnea-orchestration/SKILL.md');
    });

    it('outputs skill prompt to console', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      showSkillPrompt({ json: false });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Spawnea Agent Orchestration'));

      showSkillPrompt({ json: true });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"title": "Spawnea Agent Orchestration"'));
    });
  });

  describe('socket client and error handling', () => {
    it('validates timeout in pollTurn', async () => {
      await expect(pollTurn({} as any, 'turn-abc', NaN)).rejects.toThrow('Invalid timeout');
      await expect(pollTurn({} as any, 'turn-abc', 0)).rejects.toThrow('Invalid timeout');
      await expect(pollTurn({} as any, 'turn-abc', -10)).rejects.toThrow('Invalid timeout');
    });

    it('validates timeout in sendAndWaitPrompt and waitTurn upfront', async () => {
      const mockClient = { callTool: vi.fn() } as unknown as ControlCliClient;
      await expect(
        sendAndWaitPrompt(mockClient, { session: 'sess-1', prompt: 'hi', timeout: -5 })
      ).rejects.toThrow('Invalid timeout');
      await expect(
        waitTurn(mockClient, { turn: 'turn-1', timeout: 0 })
      ).rejects.toThrow('Invalid timeout');
      expect(mockClient.callTool).not.toHaveBeenCalled();
    });

    it('validates timeoutMs in createSession and createChild upfront', async () => {
      const mockClient = { callTool: vi.fn() } as unknown as ControlCliClient;
      await expect(
        createSession(mockClient, { project: 'proj', task: 'task', timeoutMs: -100 })
      ).rejects.toThrow('Invalid timeoutMs');
      await expect(
        createSession(mockClient, { project: 'proj', task: 'task', timeoutMs: NaN })
      ).rejects.toThrow('Invalid timeoutMs');
      await expect(
        createChild(mockClient, { parent: 'sess', task: 'task', timeoutMs: 0 })
      ).rejects.toThrow('Invalid timeoutMs');
      expect(mockClient.callTool).not.toHaveBeenCalled();
    });

    it('accumulates streamed output across working polls until turn completion', async () => {
      const calls: any[] = [];
      const mockClient = {
        callTool: vi.fn().mockImplementation((_name, args) => {
          calls.push(args);
          if (calls.length === 1) {
            return Promise.resolve({
              turnId: 'turn-1',
              status: 'working',
              cursor: 'c1',
              version: 1,
              output: 'Part 1: working on it...\n',
            });
          }
          return Promise.resolve({
            turnId: 'turn-1',
            status: 'completed',
            cursor: 'c2',
            version: 2,
            output: '',
          });
        }),
      } as unknown as ControlCliClient;

      const result = await pollTurn(mockClient, 'turn-1', 5);

      expect(result.output).toContain('Part 1: working on it...');
      expect(mockClient.callTool).toHaveBeenCalledTimes(2);
    });

    it('resets accumulated output when cursor expires during turn polling', async () => {
      const calls: any[] = [];
      const mockClient = {
        callTool: vi.fn().mockImplementation((_name, args) => {
          calls.push(args);
          if (calls.length === 1) {
            return Promise.resolve({
              turnId: 'turn-1',
              status: 'working',
              cursor: 'c1',
              version: 1,
              output: 'stale output that will expire',
            });
          }
          return Promise.resolve({
            turnId: 'turn-1',
            status: 'completed',
            cursor: 'c2',
            version: 2,
            cursorExpired: true,
            output: 'fresh output after cursor expiration',
          });
        }),
      } as unknown as ControlCliClient;

      const result = await pollTurn(mockClient, 'turn-1', 5);

      expect(result.output).toBe('fresh output after cursor expiration');
      expect(result.output).not.toContain('stale output');
    });

    it('replaces accumulated output when delimited extraction is returned', async () => {
      const calls: any[] = [];
      const mockClient = {
        callTool: vi.fn().mockImplementation((_name, args) => {
          calls.push(args);
          if (calls.length === 1) {
            return Promise.resolve({
              turnId: 'turn-1',
              status: 'working',
              cursor: 'c1',
              version: 1,
              output: 'streaming chunk',
            });
          }
          return Promise.resolve({
            turnId: 'turn-1',
            status: 'completed',
            cursor: 'c2',
            version: 2,
            extraction: 'delimited',
            output: 'Final delimited content only',
          });
        }),
      } as unknown as ControlCliClient;

      const result = await pollTurn(mockClient, 'turn-1', 5);

      expect(result.output).toBe('Final delimited content only');
      expect(result.output).not.toContain('streaming chunk');
    });

    it('bounds turn output draining by the configured deadline and fails if output remains truncated', async () => {
      let drainedCalls = 0;
      const mockClient = {
        callTool: vi.fn().mockImplementation(async (name) => {
          if (name === 'spawnea_get_turn') {
            drainedCalls++;
            await new Promise((resolve) => setTimeout(resolve, 15));
            return {
              turnId: 'turn-drain',
              status: 'completed',
              cursor: 'next-cursor',
              truncated: true,
              output: `chunk-${drainedCalls} `,
            };
          }
          return {};
        }),
      } as unknown as ControlCliClient;

      // With a 0.05s timeout, draining should terminate when deadline expires and fail because truncated remained true
      await expect(pollTurn(mockClient, 'turn-drain', 0.05)).rejects.toThrow(
        /draining remaining output timed out/
      );
      expect(drainedCalls).toBeGreaterThan(0);
      expect(drainedCalls).toBeLessThan(10);
    });

    it('successfully drains all output when draining completes before deadline', async () => {
      let drainedCalls = 0;
      const mockClient = {
        callTool: vi.fn().mockImplementation(async (name) => {
          if (name === 'spawnea_get_turn') {
            drainedCalls++;
            return {
              turnId: 'turn-drain-success',
              status: 'completed',
              cursor: drainedCalls < 2 ? 'next-cursor' : undefined,
              truncated: drainedCalls < 2,
              output: `chunk-${drainedCalls} `,
            };
          }
          return {};
        }),
      } as unknown as ControlCliClient;

      const result = await pollTurn(mockClient, 'turn-drain-success', 5);
      expect(result.status).toBe('completed');
      expect(result.output).toBe('chunk-1 chunk-2 ');
    });

    it('fails when a terminal response arrives after the deadline', async () => {
      const mockClient = {
        callTool: vi.fn().mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return {
            turnId: 'late-turn',
            status: 'completed',
            output: 'late answer',
          };
        }),
      } as unknown as ControlCliClient;

      await expect(pollTurn(mockClient, 'late-turn', 0.03)).rejects.toThrow(
        /Turn late-turn did not complete within 0.03 seconds/
      );
    });

    it('sets process.exitCode = 1 when sendPrompt cannot confirm delivery', async () => {
      const mockClient = {
        callTool: vi.fn().mockResolvedValue({
          delivered: false,
          status: 'unknown',
          sessionId: 'sess-test',
          turnId: 'turn-test',
          message: 'Enter key could not be confirmed',
        }),
      } as unknown as ControlCliClient;

      const prevExitCode = process.exitCode;
      process.exitCode = undefined;
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      await sendPrompt(mockClient, { session: 'sess-test', prompt: 'test' });

      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Prompt delivery could not be confirmed'));
      process.exitCode = prevExitCode;
    });

    it('sets process.exitCode = 1 when sendAndWaitPrompt cannot confirm delivery', async () => {
      const mockClient = {
        callTool: vi.fn().mockResolvedValue({
          delivered: false,
          status: 'unknown',
          sessionId: 'sess-test',
          turnId: 'turn-test',
          message: 'Enter key could not be confirmed',
        }),
      } as unknown as ControlCliClient;

      const prevExitCode = process.exitCode;
      process.exitCode = undefined;
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      await sendAndWaitPrompt(mockClient, { session: 'sess-test', prompt: 'test', timeout: 5 });

      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Prompt delivery could not be confirmed'));
      process.exitCode = prevExitCode;
    });

    it('fails fast when desktop app is not running', async () => {
      await expect(
        ControlCliClient.connect({
          profile: 'nonexistent-profile-12345',
          env: {},
        }),
      ).rejects.toThrow('Spawnea desktop app is not running');
    });

    it('closes socket cleanly when initialization fails during connect', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'spawnea-cli-init-fail-'));
      directories.push(directory);
      const runtimeFile = join(directory, 'control-runtime.json');
      const socketPath = join(directory, 'control.sock');

      const net = await import('node:net');
      const server = net.createServer((sock) => {
        sock.destroy();
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));

      const { writeFile } = await import('node:fs/promises');
      await writeFile(runtimeFile, JSON.stringify({
        apiVersion: 'v1',
        socketPath,
        token: 'test-token',
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }));

      try {
        await expect(
          ControlCliClient.connect({ runtimeFile })
        ).rejects.toThrow();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('executes atomic commands through authenticated Unix domain socket', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'spawnea-cli-test-'));
      directories.push(directory);

      const mockSessions = [
        {
          id: 'sess-root-1',
          name: 'Root Task',
          task: 'Root Task',
          status: 'idle',
          host: { id: 'local', name: 'Local workstation' },
          project: { id: 'spawnea', name: 'Spawnea' },
          harness: { id: 'local:codex', kind: 'codex', name: 'Codex CLI' },
          worktree: { path: '/tmp/repo', branch: 'main', managed: true },
        },
      ];

      const getState = vi.fn().mockResolvedValue({
        apiVersion: 'v1',
        sessions: mockSessions,
        hosts: [{ id: 'local', name: 'Local workstation' }],
        projects: [{ id: 'spawnea', name: 'Spawnea' }],
        harnesses: [{ id: 'local:codex', kind: 'codex', name: 'Codex CLI' }],
      });

      const createRootSession = vi.fn().mockResolvedValue({
        apiVersion: 'v1',
        sessionId: 'sess-root-2',
        sessionCreated: true,
        session: { id: 'sess-root-2', worktree: { path: '/tmp/wt-2' } },
      });

      const createChildSession = vi.fn().mockResolvedValue({
        apiVersion: 'v1',
        sessionId: 'sess-child-1',
        parentSessionId: 'sess-root-1',
        sessionCreated: true,
        worktree: { path: '/tmp/wt-child' },
        harness: { name: 'Codex CLI' },
      });

      const validTurnId = '12345678-1234-4234-8234-123456789abc';

      const sendPromptMock = vi.fn().mockResolvedValue({
        apiVersion: 'v1',
        sessionId: 'sess-child-1',
        turnId: validTurnId,
        status: 'working',
        delivered: true,
      });

      const getTurnMock = vi.fn().mockResolvedValue({
        apiVersion: 'v1',
        turnId: validTurnId,
        status: 'completed',
        output: 'Tests passed cleanly.',
      });

      const closeSessionMock = vi.fn().mockResolvedValue({
        apiVersion: 'v1',
        sessionId: 'sess-child-1',
        removed: true,
      });

      const gateway = new ControlMcpGateway({
        control: {
          getState,
          createRootSession,
          createChildSession,
          sendPrompt: sendPromptMock,
          getTurn: getTurnMock,
          closeSession: closeSessionMock,
        } as unknown as AgentControlServiceType,
        logger: createLogger('ControlCliTest'),
        runtimeFilePath: join(directory, 'control-runtime.json'),
        socketPath: join(directory, 'control.sock'),
      });

      gateways.push(gateway);
      await gateway.start();

      const client = await ControlCliClient.connect({
        runtimeFile: join(directory, 'control-runtime.json'),
      });
      clients.push(client);

      // 1. List sessions
      const listRes = await client.callTool('spawnea_list_sessions');
      expect(listRes.sessions).toHaveLength(1);
      expect(listRes.sessions[0].id).toBe('sess-root-1');

      // 2. Status
      const statusRes = await client.callTool('spawnea_status', { sessionId: 'sess-root-1' });
      expect(statusRes.session.id).toBe('sess-root-1');

      // 3. Create session
      const createRes = await client.callTool('spawnea_create_session', {
        projectId: 'spawnea',
        task: 'New Root',
      });
      expect(createRes.sessionId).toBe('sess-root-2');

      // 4. Create child
      const childRes = await client.callTool('spawnea_create_child_session', {
        parentSession: 'sess-root-1',
        task: 'Child task',
      });
      expect(childRes.sessionId).toBe('sess-child-1');

      // 5. Send prompt
      const sendRes = await client.callTool('spawnea_send_prompt', {
        target: 'sess-child-1',
        prompt: 'Run tests',
      });
      expect(sendRes.turnId).toBe(validTurnId);

      // 6. Get turn
      const turnRes = await client.callTool('spawnea_get_turn', { turnId: validTurnId });
      expect(turnRes.status).toBe('completed');
      expect(turnRes.output).toBe('Tests passed cleanly.');

      // 7. Close session
      const closeRes = await client.callTool('spawnea_close_session', { sessionId: 'sess-child-1' });
      expect(closeRes.removed).toBe(true);

      client.close();
    });

    it('runs CLI end-to-end with runCli', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'spawnea-cli-e2e-'));
      directories.push(directory);
      const runtimeFile = join(directory, 'control-runtime.json');

      const gateway = new ControlMcpGateway({
        control: {
          getState: vi.fn().mockResolvedValue({
            apiVersion: 'v1',
            sessions: [
              {
                id: 'sess-e2e-1',
                name: 'E2E Session',
                task: 'Verify CLI',
                status: 'idle',
                host: { id: 'local', name: 'Local' },
                project: { id: 'spawnea', name: 'Spawnea' },
                harness: { id: 'local:codex', kind: 'codex' },
              },
            ],
            hosts: [],
            projects: [],
            harnesses: [],
          }),
        } as unknown as AgentControlServiceType,
        logger: createLogger('ControlCliE2ETest'),
        runtimeFilePath: runtimeFile,
        socketPath: join(directory, 'control.sock'),
      });

      gateways.push(gateway);
      await gateway.start();

      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Test list
      await runCli(['list', '--runtime-file', runtimeFile]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('ACTIVE SESSIONS:'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('sess-e2e-1'));

      // Test list --json
      await runCli(['list', '--json', '--runtime-file', runtimeFile]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"id": "sess-e2e-1"'));

      // Test status
      await runCli(['status', 'sess-e2e-1', '--runtime-file', runtimeFile]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Session:      sess-e2e-1'));

      // Test invalid workspace rejection
      await expect(
        runCli(['child', 'create', '--parent', 'sess-e2e-1', '--task', 'Subtask', '--workspace', 'invalid-type', '--runtime-file', runtimeFile])
      ).rejects.toThrow("Invalid --workspace: 'invalid-type'");

      // Test invalid timeout rejection
      await expect(
        runCli(['session', 'create', '--project', 'spawnea', '--task', 'Root', '--timeout', 'invalid', '--runtime-file', runtimeFile])
      ).rejects.toThrow("Invalid timeout: 'invalid'");
      await expect(
        runCli(['child', 'create', '--parent', 'sess-e2e-1', '--task', 'Subtask', '--timeout', '-10', '--runtime-file', runtimeFile])
      ).rejects.toThrow("Invalid timeout: '-10'");

      // Test rejection of explicitly empty session identity
      const origEnv = process.env.SPAWNEA_SESSION_ID;
      try {
        process.env.SPAWNEA_SESSION_ID = '';
        await expect(
          runCli(['list', '--runtime-file', runtimeFile])
        ).rejects.toThrow(/closed connection|connection closed/i);
      } finally {
        if (origEnv !== undefined) {
          process.env.SPAWNEA_SESSION_ID = origEnv;
        } else {
          delete process.env.SPAWNEA_SESSION_ID;
        }
      }
    });
  });
});
