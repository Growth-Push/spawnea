import { describe, it, expect } from 'vitest';
import { MockHostAdapter } from '../src/mock-host.js';
import { TmuxManager } from '../src/tmux-session.js';

describe('TmuxManager', () => {
  it('creates a persistent tmux session and sends the harness command (FG-2.2.6, FG-2.2.7)', async () => {
    const host = new MockHostAdapter('host-1');
    const tmux = new TmuxManager();

    const result = await tmux.createPersistentSession({
      host,
      sessionName: 'spawnea-test-session',
      cwd: '/workspace/code',
      command: 'claude',
      args: ['--debug'],
    });

    expect(result.success).toBe(true);
    expect(result.sessionName).toBe('spawnea-test-session');

    // Verify tmux commands were issued
    const commands = host.executedCommands.map((c) => c.command);
    expect(commands.some((c) => c.includes('which tmux'))).toBe(true);
    expect(commands.some((c) => c.includes('tmux new-session -d -s \'spawnea-test-session\''))).toBe(true);
    expect(commands.some((c) => c.includes('tmux send-keys'))).toBe(true);
  });

  it('fails truthfully if tmux is not installed on the target host', async () => {
    const host = new MockHostAdapter('host-1');
    host.customRules.push({
      pattern: 'which tmux',
      response: {
        stdout: '',
        stderr: 'which: no tmux in (/usr/bin)',
        exitCode: 1,
      },
    });

    const tmux = new TmuxManager();
    const result = await tmux.createPersistentSession({
      host,
      sessionName: 'spawnea-no-tmux',
      cwd: '/workspace/code',
      command: 'claude',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('tmux is not installed');
  });

  it('detects duplicate tmux session names and rejects start (FG-2.2.10)', async () => {
    const host = new MockHostAdapter('host-1');
    host.customRules.push({
      pattern: 'tmux has-session',
      response: {
        stdout: '',
        stderr: '',
        exitCode: 0, // 0 means session already exists!
      },
    });

    const tmux = new TmuxManager();
    const result = await tmux.createPersistentSession({
      host,
      sessionName: 'spawnea-duplicate',
      cwd: '/workspace/code',
      command: 'claude',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });

  it('creates and attaches to a real local tmux session with LocalHostAdapter', async () => {
    const { LocalHostAdapter } = await import('../src/local-host.js');
    const localHost = new LocalHostAdapter({ serverId: 'local-test' });
    const tmux = new TmuxManager();
    const testSessionName = `spawnea-live-test-${Date.now().toString(36)}`;

    // 1. Create persistent session
    const createResult = await tmux.createPersistentSession({
      host: localHost,
      sessionName: testSessionName,
      cwd: process.cwd(),
      command: 'echo',
      args: ['"session ready"'],
    });

    expect(createResult.success).toBe(true);

    // 2. Verify tmux session exists on machine
    const hasSession = await tmux.hasSession(localHost, testSessionName);
    expect(hasSession).toBe(true);

    // 3. Attach PTY stream to real tmux session
    const ptyStream = await tmux.attachPty(localHost, testSessionName, { cols: 80, rows: 24 });
    expect(ptyStream).toBeDefined();

    // 4. Send keys into session
    await localHost.execute(`tmux send-keys -t '${testSessionName}' 'echo "interactive test"' C-m`);

    // 5. Clean up
    ptyStream.close();
    await tmux.killSession(localHost, testSessionName);

    const existsAfterKill = await tmux.hasSession(localHost, testSessionName);
    expect(existsAfterKill).toBe(false);
  });

  it('inspects pane details and captures tail buffer (FG-4.2.1)', async () => {
    const host = new MockHostAdapter('host-1');
    host.customRules.push({
      pattern: 'tmux list-panes -t',
      response: {
        stdout: '12345:::claude:::0\n',
        stderr: '',
        exitCode: 0,
      },
    });
    host.customRules.push({
      pattern: 'tmux list-panes -a',
      response: {
        stdout: 'sess-1:::12345:::claude:::0\nsess-2:::23456:::bash:::0\n',
        stderr: '',
        exitCode: 0,
      },
    });
    host.customRules.push({
      pattern: 'tmux list-windows -t',
      response: {
        stdout: '2\n1\n',
        stderr: '',
        exitCode: 0,
      },
    });
    host.customRules.push({
      pattern: 'tmux capture-pane',
      response: {
        stdout: 'line 1\nline 2\nDo you want to proceed? [y/N]',
        stderr: '',
        exitCode: 0,
      },
    });

    const tmux = new TmuxManager();

    // 1. Single pane inspection
    const pane = await tmux.getPaneInspection(host, 'sess-1');
    expect(pane).toEqual({
      sessionName: 'sess-1',
      panePid: 12345,
      paneCurrentCommand: 'claude',
      paneDead: false,
    });

    // 2. Batch pane inspection
    const allPanes = await tmux.listSessionPanes(host);
    expect(allPanes.size).toBe(2);
    expect(allPanes.get('sess-1')?.paneCurrentCommand).toBe('claude');
    expect(allPanes.get('sess-2')?.paneCurrentCommand).toBe('bash');

    // 3. Tail buffer capture
    const tail = await tmux.capturePaneTail(host, 'sess-1', 10);
    expect(tail.length).toBe(3);
    expect(tail[2]).toContain('[y/N]');
    expect(host.executedCommands.at(-1)?.command).toContain("-t 'sess-1:1'");
  });

  it('falls back to the session target when no valid first window index is returned', async () => {
    const host = new MockHostAdapter('host-1');
    host.customRules.push({
      pattern: 'tmux list-windows -t',
      response: { stdout: '1garbage\n-1\n9007199254740992\n', stderr: '', exitCode: 0 },
    });
    host.customRules.push({
      pattern: 'tmux capture-pane',
      response: { stdout: 'tail\n', stderr: '', exitCode: 0 },
    });

    const tmux = new TmuxManager();
    await tmux.capturePaneTail(host, 'sess-1');

    expect(host.executedCommands.at(-1)?.command).toContain("-t 'sess-1'");
  });

  it('normalizes line-count requests before building the tmux capture command', async () => {
    const host = new MockHostAdapter('host-1');
    host.customRules.push({
      pattern: 'tmux list-windows -t',
      response: { stdout: '', stderr: '', exitCode: 0 },
    });
    host.customRules.push({
      pattern: 'tmux capture-pane',
      response: { stdout: 'tail\n', stderr: '', exitCode: 0 },
    });

    const tmux = new TmuxManager();
    await tmux.capturePaneTail(host, 'sess-1', Number.NaN);
    await tmux.capturePaneTail(host, 'sess-1', Number.POSITIVE_INFINITY);
    await tmux.capturePaneTail(host, 'sess-1', -10);
    await tmux.capturePaneTail(host, 'sess-1', 10.9);
    await tmux.capturePaneTail(host, 'sess-1', 3_000_000_000);

    const captureCommands = host.executedCommands
      .filter(({ command }) => command.includes('tmux capture-pane'))
      .map(({ command }) => command);
    expect(captureCommands).toEqual([
      "tmux capture-pane -p -t 'sess-1' -S -25",
      "tmux capture-pane -p -t 'sess-1' -S -25",
      "tmux capture-pane -p -t 'sess-1' -S -0",
      "tmux capture-pane -p -t 'sess-1' -S -10",
      "tmux capture-pane -p -t 'sess-1' -S -2147483647",
    ]);
  });

  it('discovers external tmux sessions and filters out already known Spawnea sessions (FG-7.2.1)', async () => {
    const host = new MockHostAdapter('host-1');
    host.customRules.push({
      pattern: 'tmux list-sessions',
      response: {
        stdout: [
          'spawnea-known-1:::2:::1710000000:::1001:::claude:::/workspace/project1',
          'my-external-shell:::1:::1710000500:::1002:::bash:::/workspace/demo',
          'spawnea-known-2:::1:::1710001000:::1003:::codex:::/workspace/project2',
          'custom-worker:::3:::1710002000:::1004:::python:::/var/data/worker',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      },
    });

    const tmux = new TmuxManager();
    const knownNames = new Set(['spawnea-known-1', 'spawnea-known-2']);

    const discovered = await tmux.listExternalSessions(host, knownNames);
    expect(discovered.length).toBe(2);

    expect(discovered[0].sessionName).toBe('my-external-shell');
    expect(discovered[0].windowsCount).toBe(1);
    expect(discovered[0].panePid).toBe(1002);
    expect(discovered[0].currentCommand).toBe('bash');
    expect(discovered[0].currentPath).toBe('/workspace/demo');
    expect(discovered[0].createdAt).toBeInstanceOf(Date);

    expect(discovered[1].sessionName).toBe('custom-worker');
    expect(discovered[1].windowsCount).toBe(3);
    expect(discovered[1].panePid).toBe(1004);
    expect(discovered[1].currentCommand).toBe('python');
    expect(discovered[1].currentPath).toBe('/var/data/worker');
  });

  it('returns empty list gracefully if tmux is not running or has no sessions', async () => {
    const host = new MockHostAdapter('host-1');
    host.customRules.push({
      pattern: 'tmux list-sessions',
      response: {
        stdout: '',
        stderr: 'no server running on /tmp/tmux-1000/default',
        exitCode: 1,
      },
    });

    const tmux = new TmuxManager();
    const discovered = await tmux.listExternalSessions(host);
    expect(discovered).toEqual([]);
  });
});
