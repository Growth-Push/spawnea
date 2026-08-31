import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase, createRepositories, type Repositories } from '@spawnea/db';
import { NotificationBroker } from './notification-broker.js';
import type { SessionStatusResult } from '@spawnea/domain';
import { Notification, BrowserWindow } from 'electron';

const mockConstructor = vi.fn();
const mockShow = vi.fn();
const mockOn = vi.fn();

vi.mock('electron', () => {
  class MockNotification {
    static isSupported = vi.fn().mockReturnValue(true);
    show = mockShow;
    on = mockOn;
    constructor(options: any) {
      mockConstructor(options);
    }
  }

  const getAllWindows = vi.fn().mockReturnValue([
    {
      isDestroyed: () => false,
      isFocused: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    },
  ]);

  return {
    Notification: MockNotification,
    BrowserWindow: {
      getAllWindows,
    },
  };
});

describe('NotificationBroker', () => {
  let repos: Repositories;
  let dbConn: ReturnType<typeof createDatabase>;
  let broker: NotificationBroker;

  beforeEach(async () => {
    vi.clearAllMocks();
    dbConn = createDatabase({ path: ':memory:', migrate: true });
    repos = createRepositories(dbConn.db);
    broker = new NotificationBroker({ repositories: repos });

    await repos.servers.save({
      id: 'local',
      name: 'Localhost',
      host: 'localhost',
      sshPort: 22,
      enabled: true,
    });

    await repos.projects.save({
      id: 'local:test',
      serverId: 'local',
      name: 'test-project',
      rootPath: '/workspace',
    });

    await repos.agents.save({
      id: 'local:codex',
      name: 'Codex',
      harness: 'codex',
      command: 'codex',
    });

    await repos.sessions.save({
      id: 'sess-1',
      name: 'Auth Refactor',
      serverId: 'local',
      projectId: 'local:test',
      agentId: 'local:codex',
      task: 'Fix JWT',
      status: 'working',
      worktreePath: '/workspace',
      tmuxSessionName: 'spawnea-sess-1',
      branch: 'task/auth',
    });
  });

  afterEach(() => {
    dbConn.close();
  });

  it('dispatches OS notification for needs_input on a background session', async () => {
    const statusResult: SessionStatusResult = {
      status: 'needs_input',
      confidence: 0.9,
      source: 'terminal_prompt',
      reason: 'Interactive confirmation required',
      detectedPrompt: 'Do you want to run `cargo test`? [y/N]',
      updatedAt: new Date(),
    };

    const dispatched = await broker.notifyStatusAlert('sess-1', statusResult);
    expect(dispatched).toBe(true);
    expect(mockConstructor).toHaveBeenCalledTimes(1);
    expect(mockConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Spawnea: Input Required',
        body: expect.stringContaining('Do you want to run `cargo test`? [y/N]'),
      })
    );
  });

  it('deduplicates identical prompt alerts and does not fire repeated notifications', async () => {
    const statusResult: SessionStatusResult = {
      status: 'needs_input',
      confidence: 0.9,
      source: 'terminal_prompt',
      reason: 'Interactive confirmation required',
      detectedPrompt: 'Do you want to run `cargo test`? [y/N]',
      updatedAt: new Date(),
    };

    // 1st check -> dispatches notification
    const first = await broker.notifyStatusAlert('sess-1', statusResult);
    expect(first).toBe(true);
    expect(mockConstructor).toHaveBeenCalledTimes(1);

    // 2nd check 3 seconds later with exact same prompt -> suppressed
    const second = await broker.notifyStatusAlert('sess-1', statusResult);
    expect(second).toBe(false);
    expect(mockConstructor).toHaveBeenCalledTimes(1);

    // 3rd check with exact same prompt -> suppressed
    const third = await broker.notifyStatusAlert('sess-1', statusResult);
    expect(third).toBe(false);
    expect(mockConstructor).toHaveBeenCalledTimes(1);
  });

  it('dispatches a new notification when a different prompt/question appears', async () => {
    const prompt1: SessionStatusResult = {
      status: 'needs_input',
      confidence: 0.9,
      source: 'terminal_prompt',
      reason: 'Choice question',
      detectedPrompt: 'Question 1: Select option A or B',
      updatedAt: new Date(),
    };

    const prompt2: SessionStatusResult = {
      status: 'needs_input',
      confidence: 0.9,
      source: 'terminal_prompt',
      reason: 'Confirmation question',
      detectedPrompt: 'Question 2: Confirm destructive migration? [y/N]',
      updatedAt: new Date(),
    };

    const first = await broker.notifyStatusAlert('sess-1', prompt1);
    expect(first).toBe(true);
    expect(mockConstructor).toHaveBeenCalledTimes(1);

    // Different prompt -> dispatches new notification
    const second = await broker.notifyStatusAlert('sess-1', prompt2);
    expect(second).toBe(true);
    expect(mockConstructor).toHaveBeenCalledTimes(2);
  });

  it('clears alert record when session returns to working or idle so future prompts notify', async () => {
    const prompt: SessionStatusResult = {
      status: 'needs_input',
      confidence: 0.9,
      source: 'terminal_prompt',
      reason: 'Interactive confirmation required',
      detectedPrompt: 'Do you want to continue? [y/N]',
      updatedAt: new Date(),
    };

    await broker.notifyStatusAlert('sess-1', prompt);
    expect(mockConstructor).toHaveBeenCalledTimes(1);

    // Session resumed working
    await broker.notifyStatusAlert('sess-1', {
      status: 'working',
      confidence: 0.8,
      source: 'pty_activity',
      reason: 'Active output streaming',
      updatedAt: new Date(),
    });

    // Later, a new prompt arrives -> should notify again
    const nextAlert = await broker.notifyStatusAlert('sess-1', prompt);
    expect(nextAlert).toBe(true);
    expect(mockConstructor).toHaveBeenCalledTimes(2);
  });

  it('suppresses notification if session is active and focused window is in use', async () => {
    const statusResult: SessionStatusResult = {
      status: 'needs_input',
      confidence: 0.9,
      source: 'terminal_prompt',
      reason: 'Interactive prompt',
      detectedPrompt: 'Proceed? [y/N]',
      updatedAt: new Date(),
    };

    broker.setActiveSessionId('sess-1');

    // Mock focused window
    const mockWindow = {
      isDestroyed: () => false,
      isFocused: () => true,
    };
    (BrowserWindow.getAllWindows as any).mockReturnValue([mockWindow]);

    const dispatched = await broker.notifyStatusAlert('sess-1', statusResult);
    expect(dispatched).toBe(false);
    expect(mockConstructor).not.toHaveBeenCalled();
  });
});
