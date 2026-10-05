import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, getAgentSkillPrompt } from '@spawnea/domain';
import { ControlMcpGateway } from '../main/control-mcp-gateway.js';
import type { AgentControlService as AgentControlServiceType } from '../main/agent-control-service.js';
import { ControlCliClient } from './client.js';
import { parseArgs, runCli } from './index.js';
import { showSkillPrompt } from './commands.js';

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
    it('fails fast when desktop app is not running', async () => {
      await expect(
        ControlCliClient.connect({
          profile: 'nonexistent-profile-12345',
        }),
      ).rejects.toThrow('Spawnea desktop app is not running');
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
    });
  });
});
