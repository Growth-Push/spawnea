import { describe, it, expect } from 'vitest';
import { createLogger, type LogEntry, type SessionTopologySnapshot } from '@spawnea/domain';
import { MockHostAdapter } from '../src/mock-host.js';
import { TmuxManager } from '../src/tmux-session.js';
import { fileURLToPath } from 'node:url';

describe('TmuxManager', () => {
  it('submits text once to a real paste-aware terminal without an extra caller Enter', async () => {
    const { LocalHostAdapter } = await import('../src/local-host.js');
    const host = new LocalHostAdapter({ serverId: 'prompt-runtime-test' });
    const tmux = new TmuxManager();
    const name = `spawnea-prompt-test-${Date.now().toString(36)}`;
    const fixture = fileURLToPath(new URL('./fixtures/paste-aware-prompt.mjs', import.meta.url));
    try {
      expect((await tmux.createPersistentSession({ host, sessionName: name, cwd: process.cwd(), command: process.execPath, args: [fixture] })).success).toBe(true);
      await expect.poll(async () => (await tmux.capturePaneTail(host, name, 100)).join('\n')).toContain('PROMPT_READY');
      // Reproduce the original combined text/Enter behavior in the real PTY.
      await host.execute(`tmux send-keys -t '${name}' -l -- 'original'`);
      await host.execute(`tmux send-keys -t '${name}' Enter`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await tmux.capturePaneTail(host, name, 100)).join('\n')).not.toContain('SUBMITTED:');
      // Reset only the disposable fixture's input by completing that probe.
      await host.execute(`tmux send-keys -t '${name}' Enter`);
      for (const prompt of ['Run tests', 'First line\nSecond line']) {
        expect(await tmux.sendInput(host, name, `\x1b[200~${prompt}\x1b[201~`)).toBe(true);
        await expect.poll(async () => (await tmux.capturePaneTail(host, name, 100)).join('\n')).toContain(`SUBMITTED:${JSON.stringify(prompt)}`);
      }
    } finally {
      await tmux.killSession(host, name);
    }
  });
  it.each([
    { diagnostic: 'No such file or directory', absent: true },
    { diagnostic: 'Permission denied', absent: false },
  ])('uses deterministic diagnostics on a localized host: $diagnostic', async ({ diagnostic, absent }) => {
    const host = new MockHostAdapter('host-1');
    host.customRules.push({
      pattern: 'tmux has-session',
      response: (command) => ({
        stdout: '',
        // Multilingual fixture: simulate a host whose diagnostics follow LC_MESSAGES.
        stderr: `error connecting to /tmp/spawnea-test/socket (${command.startsWith('LC_ALL=C ') ? diagnostic : 'diagnóstico localizado'})`,
        exitCode: 1,
      }),
    });
    const result = new TmuxManager().killSession(host, 'localized-host');
    if (absent) await expect(result).resolves.toBe(true);
    else await expect(result).rejects.toThrow('Permission denied');
  });

  it.each([
    { exitCode: 1, stderr: "can't find session: missing" },
    { exitCode: 1, stderr: 'no server running on /tmp/spawnea-test/socket' },
    { exitCode: 1, stderr: 'error connecting to /tmp/spawnea-test/socket (No such file or directory)' },
  ])('verifies an absent session before accepting termination: $stderr', async ({ exitCode, stderr }) => {
    const host = new MockHostAdapter('host-1');
    host.customRules.push({ pattern: 'tmux has-session', response: { stdout: '', stderr, exitCode } });
    await expect(new TmuxManager().killSession(host, 'missing')).resolves.toBe(true);
  });

  it.each([
    { exitCode: 1, stderr: 'error connecting to /tmp/spawnea-test/socket (Permission denied)' },
    { exitCode: 127, stderr: 'tmux: command not found' },
    { exitCode: 255, stderr: 'Connection closed' },
    { exitCode: 1, stderr: '' },
  ])('rejects an inconclusive termination check: $stderr', async ({ exitCode, stderr }) => {
    const host = new MockHostAdapter('host-1');
    host.customRules.push({ pattern: 'tmux has-session', response: { stdout: '', stderr, exitCode } });
    await expect(new TmuxManager().killSession(host, 'uncertain')).rejects.toThrow('Failed to verify termination');
  });

  it('accepts tmux server exit after a successful last-session kill', async () => {
    const host = new MockHostAdapter('host-1');
    host.customRules.push({ pattern: 'tmux kill-session', response: { stdout: '', stderr: '', exitCode: 0 } });
    host.customRules.push({ pattern: 'tmux has-session', response: { stdout: '', stderr: 'server exited unexpectedly', exitCode: 1 } });
    await expect(new TmuxManager().killSession(host, 'last-session')).resolves.toBe(true);
  });

  it.each([
    { sessions: 'another-session', expected: true },
    { sessions: 'last-session\nanother-session', expected: false },
  ])('checks the session list after tmux reports no current target', async ({ sessions, expected }) => {
    const host = new MockHostAdapter('host-1');
    host.customRules.push({ pattern: 'tmux kill-session', response: { stdout: '', stderr: '', exitCode: 0 } });
    host.customRules.push({ pattern: 'tmux has-session', response: { stdout: '', stderr: 'no current target', exitCode: 1 } });
    host.customRules.push({ pattern: 'tmux list-sessions', response: { stdout: `${sessions}\n`, stderr: '', exitCode: 0 } });
    await expect(new TmuxManager().killSession(host, 'last-session')).resolves.toBe(expected);
  });

  it('rejects tmux server exit when the kill did not succeed', async () => {
    const host = new MockHostAdapter('host-1');
    host.customRules.push({ pattern: 'tmux kill-session', response: { stdout: '', stderr: 'failed', exitCode: 1 } });
    host.customRules.push({ pattern: 'tmux has-session', response: { stdout: '', stderr: 'server exited unexpectedly', exitCode: 1 } });
    await expect(new TmuxManager().killSession(host, 'last-session')).rejects.toThrow('Failed to verify termination');
  });

  it('creates a persistent tmux session and sends the harness command (FG-2.2.6, FG-2.2.7)', async () => {
    const host = new MockHostAdapter('host-1');
    const entries: LogEntry[] = [];
    const tmux = new TmuxManager(createLogger('test', { minLevel: 'debug', handlers: [(entry) => entries.push(entry)] }));
    const opaqueCredential = 'opaque-harness-credential-7f4c9d';

    const result = await tmux.createPersistentSession({
      host,
      sessionName: 'spawnea-test-session',
      cwd: '/workspace/code',
      command: 'claude',
      args: ['--credential', opaqueCredential],
    });

    expect(result.success).toBe(true);
    expect(result.sessionName).toBe('spawnea-test-session');

    // Verify tmux commands were issued
    const commands = host.executedCommands.map((c) => c.command);
    expect(commands.some((c) => c.includes('which tmux'))).toBe(true);
    expect(commands.some((c) => c.includes('tmux new-session -d -s \'spawnea-test-session\''))).toBe(true);
    expect(commands.some((c) => c.includes('tmux send-keys'))).toBe(true);
    expect(commands.some((c) => c.includes('set-option') && c.includes('mouse'))).toBe(false);
    expect(commands.some((c) => c.includes('set-option') && c.includes('history-limit'))).toBe(false);
    expect(JSON.stringify(entries)).not.toContain(opaqueCredential);
    expect(JSON.stringify(entries)).not.toContain('args');
  });

  it('applies only explicitly configured tmux options and commands', async () => {
    const host = new MockHostAdapter('host-1');
    const tmux = new TmuxManager();

    const result = await tmux.createPersistentSession({
      host,
      sessionName: 'spawnea-configured-session',
      cwd: '/workspace/code',
      command: 'bash',
      tmuxOptions: { mouse: true, 'history-limit': 50000 },
      tmuxCommands: [['set-window-option', '-t', '{{session}}', 'status', 'off']],
    });

    expect(result.success).toBe(true);
    const commands = host.executedCommands.map((c) => c.command);
    expect(commands).toContain("tmux set-option -t 'spawnea-configured-session' 'mouse' 'on'");
    expect(commands).toContain("tmux set-option -t 'spawnea-configured-session' 'history-limit' '50000'");
    expect(commands).toContain("tmux 'set-window-option' '-t' 'spawnea-configured-session' 'status' 'off'");
  });

  it('does not change tmux options while attaching', async () => {
    const host = new MockHostAdapter('host-1');
    const tmux = new TmuxManager();

    await tmux.attachPty(host, 'spawnea-existing-session', { cols: 80, rows: 24 });

    expect(host.executedCommands.map((c) => c.command)).toEqual([]);
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

  it('does not press Enter when literal input delivery fails', async () => {
    const host = new MockHostAdapter('host-1');
    host.customRules.push({
      pattern: "tmux send-keys -t 'spawnea-input-failure' -l",
      response: { stdout: '', stderr: 'send failed', exitCode: 1 },
    });

    const tmux = new TmuxManager();
    await expect(tmux.sendInput(host, 'spawnea-input-failure', 'partial input\n')).resolves.toBe(false);
    expect(host.executedCommands).toHaveLength(1);
  });

  it('can submit multiline paste-aware harness input with a confirming Enter', async () => {
    const host = new MockHostAdapter('host-1');
    const tmux = new TmuxManager();

    await expect(tmux.sendInput(host, 'spawnea-codex', 'line one\nline two', 2)).resolves.toBe(true);

    expect(host.executedCommands.filter(({ command }) => command.includes("tmux send-keys -t 'spawnea-codex' Enter"))).toHaveLength(2);
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

  describe('captureSessionTopology', () => {
    it('throws error if session does not exist on host', async () => {
      const host = new MockHostAdapter('host-1');
      host.customRules.push({
        pattern: 'tmux has-session',
        response: { stdout: '', stderr: 'can\'t find session: missing-sess', exitCode: 1 },
      });

      const tmux = new TmuxManager();
      await expect(tmux.captureSessionTopology(host, 'missing-sess')).rejects.toThrow('does not exist');
    });

    it('captures multi-window and multi-pane topology with layouts and working directories', async () => {
      const host = new MockHostAdapter('host-1');
      host.customRules.push({
        pattern: 'tmux has-session',
        response: { stdout: '', stderr: '', exitCode: 0 },
      });
      host.customRules.push({
        pattern: 'tmux list-windows',
        response: {
          stdout: '0:::1:::c625,260x56,0,0,8:::code\n1:::0:::a123,260x56,0,0,9:::tests\n',
          stderr: '',
          exitCode: 0,
        },
      });
      host.customRules.push({
        pattern: 'tmux list-panes',
        response: {
          stdout:
            '0:::0:::1:::/workspace/spawnea/src:::editor\n' +
            '0:::1:::0:::/workspace/spawnea/packages:::terminal\n' +
            '1:::0:::1:::/workspace/spawnea/test:::runner\n',
          stderr: '',
          exitCode: 0,
        },
      });

      const tmux = new TmuxManager();
      const topology = await tmux.captureSessionTopology(host, 'spawnea-active');

      expect(topology.sessionName).toBe('spawnea-active');
      expect(topology.windows).toHaveLength(2);

      const win0 = topology.windows[0];
      expect(win0.index).toBe(0);
      expect(win0.name).toBe('code');
      expect(win0.active).toBe(true);
      expect(win0.layout).toBe('c625,260x56,0,0,8');
      expect(win0.panes).toHaveLength(2);
      expect(win0.panes[0]).toEqual({
        windowIndex: 0,
        paneIndex: 0,
        cwd: '/workspace/spawnea/src',
        title: 'editor',
        active: true,
      });
      expect(win0.panes[1]).toEqual({
        windowIndex: 0,
        paneIndex: 1,
        cwd: '/workspace/spawnea/packages',
        title: 'terminal',
        active: false,
      });

      const win1 = topology.windows[1];
      expect(win1.index).toBe(1);
      expect(win1.name).toBe('tests');
      expect(win1.active).toBe(false);
      expect(win1.panes).toHaveLength(1);
      expect(win1.panes[0].cwd).toBe('/workspace/spawnea/test');
    });
  });

  describe('resurrectSession', () => {
    const testDirs = [
      '/code',
      '/code/spawnea',
      '/code/spawnea/src',
      '/code/spawnea/docs',
      '/code/spawnea/build',
      '/code/spawnea/apps',
      '/code/spawnea/packages',
      '/code/valid-root',
    ];
    const createResurrectHost = (dirs = testDirs): MockHostAdapter => new MockHostAdapter('host-1', dirs);

    it('returns error when tmux binary is missing on target host', async () => {
      const host = new MockHostAdapter('host-1');
      host.customRules.push({
        pattern: 'which tmux',
        response: { stdout: '', stderr: 'not found', exitCode: 1 },
      });

      const tmux = new TmuxManager();
      const res = await tmux.resurrectSession({
        host,
        sessionName: 'res-sess',
        defaultCwd: '/code/spawnea',
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('tmux is not installed');
    });

    it('returns success without recreation if session already exists', async () => {
      const host = new MockHostAdapter('host-1');
      host.customRules.push({
        pattern: 'which tmux',
        response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 },
      });
      host.customRules.push({
        pattern: 'tmux has-session',
        response: { stdout: '', stderr: '', exitCode: 0 },
      });

      const tmux = new TmuxManager();
      const res = await tmux.resurrectSession({
        host,
        sessionName: 'existing-sess',
        defaultCwd: '/code/spawnea',
      });

      expect(res.success).toBe(true);
      expect(res.sessionName).toBe('existing-sess');
      expect(res.alreadyRunning).toBe(true);
    });

    it('resurrects clean session with default cwd and window name if topology is absent', async () => {
      const host = createResurrectHost();
      const executedCommands: string[] = [];
      host.customRules.push({
        pattern: 'which tmux',
        response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 },
      });
      host.customRules.push({
        pattern: 'tmux has-session',
        response: { stdout: '', stderr: 'no session', exitCode: 1 },
      });
      host.customRules.push({
        pattern: 'tmux new-session',
        response: (cmd) => {
          executedCommands.push(cmd);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });

      const tmux = new TmuxManager();
      const res = await tmux.resurrectSession({
        host,
        sessionName: 'clean-sess',
        defaultCwd: '/code/spawnea',
        defaultWindowName: 'main-win',
      });

      expect(res.success).toBe(true);
      expect(executedCommands).toHaveLength(1);
      expect(executedCommands[0]).toContain("tmux new-session -d -s 'clean-sess' -c '/code/spawnea' -n 'main-win'");
    });

    it('resurrects complex topology with windows, panes, and layout', async () => {
      const host = createResurrectHost();
      const executedCommands: string[] = [];
      host.customRules.push({
        pattern: 'which tmux',
        response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 },
      });
      host.customRules.push({
        pattern: 'tmux has-session',
        response: { stdout: '', stderr: 'no session', exitCode: 1 },
      });
      host.customRules.push({
        pattern: 'tmux ',
        response: (cmd) => {
          executedCommands.push(cmd);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });

      const tmux = new TmuxManager();
      const topology = {
        savedAt: new Date(),
        sessionName: 'complex-sess',
        windows: [
          {
            index: 0,
            name: 'editor-win',
            active: false,
            layout: 'even-horizontal',
            panes: [
              { windowIndex: 0, paneIndex: 0, cwd: '/code/spawnea/src', active: true },
              { windowIndex: 0, paneIndex: 1, cwd: '/code/spawnea/docs', active: false },
            ],
          },
          {
            index: 1,
            name: 'terminal-win',
            active: true,
            layout: 'tiled',
            panes: [
              { windowIndex: 1, paneIndex: 0, cwd: '/code/spawnea/build', active: true },
            ],
          },
        ],
      };

      const res = await tmux.resurrectSession({
        host,
        sessionName: 'complex-sess',
        defaultCwd: '/code/spawnea',
        topology,
      });

      expect(res.success).toBe(true);

      // Verify command sequence:
      // 1. new-session for window 0 at /code/spawnea/src
      expect(executedCommands.some((c) => c.includes("tmux new-session -d -s 'complex-sess' -c '/code/spawnea/src' -n 'editor-win'"))).toBe(true);
      // 2. split-window for pane 1 at /code/spawnea/docs targeting window 0 with horizontal orientation
      expect(executedCommands.some((c) => c.includes("tmux split-window -h -t 'complex-sess:0' -c '/code/spawnea/docs'"))).toBe(true);
      // 3. select-layout for window 0
      expect(executedCommands.some((c) => c.includes("tmux select-layout -t 'complex-sess:0' 'even-horizontal'"))).toBe(true);
      // 4. new-window for window 1 at /code/spawnea/build
      expect(executedCommands.some((c) => c.includes("tmux new-window") && c.includes("'complex-sess") && c.includes("'/code/spawnea/build'") && c.includes("'terminal-win'"))).toBe(true);
      // 5. select-window for the active window index 1
      expect(executedCommands.some((c) => c.includes("tmux select-window -t 'complex-sess:1'"))).toBe(true);
    });

    it('rolls back partial tmux session when pane split fails after new-session', async () => {
      const host = createResurrectHost();
      const executedCommands: string[] = [];
      host.customRules.push({
        pattern: 'which tmux',
        response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 },
      });
      host.customRules.push({
        pattern: 'tmux has-session',
        response: { stdout: '', stderr: 'no session', exitCode: 1 },
      });
      host.customRules.push({
        pattern: 'tmux new-session',
        response: (cmd) => {
          executedCommands.push(cmd);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });
      host.customRules.push({
        pattern: 'tmux split-window',
        response: (cmd) => {
          executedCommands.push(cmd);
          return { stdout: '', stderr: 'no space for new pane', exitCode: 1 };
        },
      });
      host.customRules.push({
        pattern: 'tmux kill-session',
        response: (cmd) => {
          executedCommands.push(cmd);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });

      const tmux = new TmuxManager();
      const topology: SessionTopologySnapshot = {
        savedAt: new Date(),
        sessionName: 'partial-fail-sess',
        windows: [
          {
            index: 0,
            name: 'main',
            active: true,
            panes: [
              { windowIndex: 0, paneIndex: 0, cwd: '/code/spawnea/src', active: true },
              { windowIndex: 0, paneIndex: 1, cwd: '/code/spawnea/docs', active: false },
            ],
          },
        ],
      };

      const res = await tmux.resurrectSession({
        host,
        sessionName: 'partial-fail-sess',
        defaultCwd: '/code/spawnea',
        topology,
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('Failed to create pane');
      // Ensure kill-session was called to roll back partial session
      expect(executedCommands.some((c) => c.includes("tmux kill-session -t 'partial-fail-sess'"))).toBe(true);
    });

    it('respawns multiple dead panes at their saved working directories while leaving live panes untouched', async () => {
      const host = new MockHostAdapter('host-1');
      const executedCommands: string[] = [];
      host.customRules.push({
        pattern: 'which tmux',
        response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 },
      });
      host.customRules.push({
        pattern: 'tmux has-session',
        response: { stdout: '', stderr: '', exitCode: 0 },
      });
      host.customRules.push({
        pattern: 'tmux list-panes',
        response: {
          // pane %0 is alive, %1 is dead (win 0, pane 1), %2 is dead (win 1, pane 0)
          stdout: '%0:::0:::0:::0\n%1:::1:::0:::1\n%2:::1:::1:::0\n',
          stderr: '',
          exitCode: 0,
        },
      });
      host.customRules.push({
        pattern: 'tmux respawn-pane',
        response: (cmd) => {
          executedCommands.push(cmd);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });

      const tmux = new TmuxManager();
      const topology: SessionTopologySnapshot = {
        savedAt: new Date(),
        sessionName: 'dead-panes-sess',
        windows: [
          {
            index: 0,
            name: 'win0',
            active: true,
            panes: [
              { windowIndex: 0, paneIndex: 0, cwd: '/code/spawnea/main', active: true },
              { windowIndex: 0, paneIndex: 1, cwd: '/code/spawnea/saved-subpane', active: false },
            ],
          },
          {
            index: 1,
            name: 'win1',
            active: false,
            panes: [
              { windowIndex: 1, paneIndex: 0, cwd: '/code/spawnea/saved-tool', active: true },
            ],
          },
        ],
      };

      const res = await tmux.resurrectSession({
        host,
        sessionName: 'dead-panes-sess',
        defaultCwd: '/code/spawnea',
        defaultShell: '/bin/bash',
        topology,
      });

      expect(res.success).toBe(true);
      // Verify pane %1 respawned at /code/spawnea/saved-subpane with explicit shell
      expect(executedCommands.some((c) => c.includes("tmux respawn-pane -k -t '%1'") && c.includes("'/code/spawnea/saved-subpane'") && c.includes("'/bin/bash'"))).toBe(true);
      // Verify pane %2 respawned at /code/spawnea/saved-tool with explicit shell
      expect(executedCommands.some((c) => c.includes("tmux respawn-pane -k -t '%2'") && c.includes("'/code/spawnea/saved-tool'") && c.includes("'/bin/bash'"))).toBe(true);
      // Verify pane %0 was NOT respawned
      expect(executedCommands.some((c) => c.includes("'%0'"))).toBe(false);
    });

    it('queries window and pane indices using positional display-message syntax without -F', async () => {
      const host = createResurrectHost();
      const executedCommands: string[] = [];
      host.customRules.push({
        pattern: 'which tmux',
        response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 },
      });
      host.customRules.push({
        pattern: 'tmux has-session',
        response: { stdout: '', stderr: 'no session', exitCode: 1 },
      });
      host.customRules.push({
        pattern: 'tmux new-session',
        response: { stdout: '', stderr: '', exitCode: 0 },
      });
      host.customRules.push({
        pattern: 'tmux display-message',
        response: (cmd) => {
          executedCommands.push(cmd);
          if (cmd.includes('#{window_index}')) return { stdout: '1\n', stderr: '', exitCode: 0 };
          if (cmd.includes('#{pane_id}')) return { stdout: '%10\n', stderr: '', exitCode: 0 };
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });

      const tmux = new TmuxManager();
      const topology: SessionTopologySnapshot = {
        savedAt: new Date(),
        sessionName: 'disp-msg-sess',
        windows: [
          {
            index: 0,
            name: 'main',
            active: true,
            panes: [{ windowIndex: 0, paneIndex: 0, cwd: '/code/spawnea', active: true }],
          },
        ],
      };

      const res = await tmux.resurrectSession({
        host,
        sessionName: 'disp-msg-sess',
        defaultCwd: '/code/spawnea',
        topology,
      });

      expect(res.success).toBe(true);
      const dispCmds = executedCommands.filter((c) => c.includes('display-message'));
      expect(dispCmds.length).toBeGreaterThan(0);
      for (const cmd of dispCmds) {
        expect(cmd).not.toContain('-F');
        expect(cmd).toContain('-p');
      }
    });

    it('launches an explicit shell in every new pane and sizes the session from saved geometry', async () => {
      const host = createResurrectHost();
      const created: string[] = [];
      host.customRules.push({ pattern: 'which tmux', response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 } });
      host.customRules.push({ pattern: 'tmux has-session', response: { stdout: '', stderr: 'no session', exitCode: 1 } });
      for (const pattern of ['tmux new-session', 'tmux split-window', 'tmux new-window']) {
        host.customRules.push({
          pattern,
          response: (cmd) => {
            created.push(cmd);
            return { stdout: pattern === 'tmux new-window' ? '1\n' : '%5\n', stderr: '', exitCode: 0 };
          },
        });
      }

      const tmux = new TmuxManager();
      const topology: SessionTopologySnapshot = {
        savedAt: new Date(),
        sessionName: 'shell-sess',
        windows: [
          {
            index: 0, name: 'a', active: true, layout: 'c625,260x56,0,0{60x56,0,0,1,60x56,61,0,2}',
            panes: [
              { windowIndex: 0, paneIndex: 0, cwd: '/code/a', active: true },
              { windowIndex: 0, paneIndex: 1, cwd: '/code/b', active: false },
            ],
          },
          {
            index: 1, name: 'b', active: false, layout: 'a123,200x70,0,0,9',
            panes: [{ windowIndex: 1, paneIndex: 0, cwd: '/code/c', active: true }],
          },
        ],
      };

      const res = await tmux.resurrectSession({ host, sessionName: 'shell-sess', defaultCwd: '/code', defaultShell: '/bin/zsh', topology });

      expect(res.success).toBe(true);
      expect(created).toHaveLength(3);
      for (const cmd of created) {
        expect(cmd.trimEnd().endsWith("'/bin/zsh'")).toBe(true);
      }
      expect(created[0]).toContain('-x 260 -y 70');
    });

    it('splits horizontally for horizontal layouts to avoid exhausting vertical space in short windows', async () => {
      const host = createResurrectHost();
      const splits: string[] = [];
      host.customRules.push({ pattern: 'which tmux', response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 } });
      host.customRules.push({ pattern: 'tmux has-session', response: { stdout: '', stderr: 'no session', exitCode: 1 } });
      host.customRules.push({ pattern: 'tmux new-session', response: { stdout: '', stderr: '', exitCode: 0 } });
      host.customRules.push({
        pattern: 'tmux split-window',
        response: (cmd) => {
          splits.push(cmd);
          return { stdout: '%10\n', stderr: '', exitCode: 0 };
        },
      });

      const tmux = new TmuxManager();
      const topology: SessionTopologySnapshot = {
        savedAt: new Date(),
        sessionName: 'horiz-sess',
        windows: [
          {
            index: 0,
            name: 'wide',
            active: true,
            layout: '12e8,260x24,0,0{26x24,0,0,1,26x24,27,0,2,26x24,53,0,3}',
            panes: Array.from({ length: 6 }, (_, i) => ({
              windowIndex: 0,
              paneIndex: i,
              cwd: `/code/pane-${i}`,
              active: i === 0,
            })),
          },
        ],
      };

      const res = await tmux.resurrectSession({ host, sessionName: 'horiz-sess', defaultCwd: '/code', topology });
      expect(res.success).toBe(true);
      expect(splits).toHaveLength(5);
      for (const cmd of splits) {
        expect(cmd).toContain('split-window -h');
      }
    });

    it('falls back to alternative split orientation if initial split direction fails', async () => {
      const host = createResurrectHost();
      const splits: string[] = [];
      host.customRules.push({ pattern: 'which tmux', response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 } });
      host.customRules.push({ pattern: 'tmux has-session', response: { stdout: '', stderr: 'no session', exitCode: 1 } });
      host.customRules.push({ pattern: 'tmux new-session', response: { stdout: '', stderr: '', exitCode: 0 } });
      host.customRules.push({
        pattern: 'tmux split-window',
        response: (cmd) => {
          splits.push(cmd);
          // Fail vertical splits with no space, succeed horizontal
          if (cmd.includes('split-window -v')) {
            return { stdout: '', stderr: 'no space for new pane', exitCode: 1 };
          }
          return { stdout: '%20\n', stderr: '', exitCode: 0 };
        },
      });

      const tmux = new TmuxManager();
      const topology: SessionTopologySnapshot = {
        savedAt: new Date(),
        sessionName: 'fallback-sess',
        windows: [
          {
            index: 0,
            name: 'fallback',
            active: true,
            layout: '5a5c,80x24,0,0[80x12,0,0,1,80x11,0,13,2]', // vertical layout
            panes: [
              { windowIndex: 0, paneIndex: 0, cwd: '/code/0', active: true },
              { windowIndex: 0, paneIndex: 1, cwd: '/code/1', active: false },
            ],
          },
        ],
      };

      const res = await tmux.resurrectSession({ host, sessionName: 'fallback-sess', defaultCwd: '/code', topology });
      expect(res.success).toBe(true);
      expect(splits.some((c) => c.includes('split-window -v'))).toBe(true);
      expect(splits.some((c) => c.includes('split-window -h'))).toBe(true);
    });

    it('restores automatic window sizing by unsetting window-size after geometry reconstruction', async () => {
      const host = createResurrectHost();
      const executed: string[] = [];
      host.customRules.push({ pattern: 'which tmux', response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 } });
      host.customRules.push({ pattern: 'tmux has-session', response: { stdout: '', stderr: 'no session', exitCode: 1 } });
      host.customRules.push({
        pattern: 'tmux',
        response: (cmd) => {
          executed.push(cmd);
          if (cmd.includes('#{window_index}')) return { stdout: '0\n', stderr: '', exitCode: 0 };
          if (cmd.includes('#{pane_id}')) return { stdout: '%1\n', stderr: '', exitCode: 0 };
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });

      const tmux = new TmuxManager();
      const topology: SessionTopologySnapshot = {
        savedAt: new Date(),
        sessionName: 'wsize-sess',
        windows: [
          {
            index: 0,
            name: 'main',
            active: true,
            layout: 'c625,260x56,0,0,1',
            panes: [{ windowIndex: 0, paneIndex: 0, cwd: '/code', active: true }],
          },
        ],
      };

      const res = await tmux.resurrectSession({ host, sessionName: 'wsize-sess', defaultCwd: '/code', topology });
      expect(res.success).toBe(true);
      expect(executed.some((c) => c.includes("tmux set-option -w -u -t 'wsize-sess:0' window-size"))).toBe(true);
    });

    it('preserves environment in shell launch fallback when -e flag is rejected', async () => {
      const host = createResurrectHost();
      const executed: string[] = [];
      host.customRules.push({ pattern: 'which tmux', response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 } });
      host.customRules.push({ pattern: 'tmux has-session', response: { stdout: '', stderr: 'no session', exitCode: 1 } });
      host.customRules.push({
        pattern: 'tmux new-session',
        response: (cmd) => {
          executed.push(cmd);
          // Simulate older tmux rejecting -e
          if (cmd.includes('-e ')) {
            return { stdout: '', stderr: 'unknown option -- e', exitCode: 1 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });
      host.customRules.push({
        pattern: 'tmux',
        response: (cmd) => {
          executed.push(cmd);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });

      const tmux = new TmuxManager();
      const res = await tmux.resurrectSession({
        host,
        sessionName: 'env-fallback-sess',
        defaultCwd: '/code',
        defaultShell: '/bin/bash',
        env: { SPAWNEA_SESSION_ID: 'session-xyz', SPAWNEA_PROFILE: 'dev' },
      });

      expect(res.success).toBe(true);
      const retriedNewSession = executed.find((c) => c.includes('tmux new-session') && !c.includes('-e '));
      expect(retriedNewSession).toBeDefined();
      expect(retriedNewSession).toContain("SPAWNEA_SESSION_ID='\\''session-xyz'\\''");
      expect(retriedNewSession).toContain("SPAWNEA_PROFILE='\\''dev'\\''");
      expect(retriedNewSession).toContain("'/bin/bash'");
    });

    it('attempts to restore saved first-window index and returns translatedTopology when base-index differs', async () => {
      const executed: string[] = [];
      const host = createResurrectHost();
      host.customRules.push({ pattern: 'which tmux', response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 } });
      host.customRules.push({ pattern: 'tmux has-session', response: { stdout: '', stderr: 'no session', exitCode: 1 } });
      host.customRules.push({
        pattern: 'tmux display-message -p -t',
        response: (cmd) => {
          executed.push(cmd);
          if (cmd.includes('#{window_index}')) {
            // Host tmux base-index is 1, so new-session assigned 1 instead of saved 0
            return { stdout: '1\n', stderr: '', exitCode: 0 };
          }
          if (cmd.includes('#{pane_id}')) {
            return { stdout: '%10\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });
      host.customRules.push({
        pattern: 'tmux move-window',
        response: (cmd) => {
          executed.push(cmd);
          // Simulate move-window succeeding to restore saved index 0
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });
      host.customRules.push({
        pattern: 'tmux',
        response: (cmd) => {
          executed.push(cmd);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });

      const tmux = new TmuxManager();
      const res = await tmux.resurrectSession({
        host,
        sessionName: 'win-index-sess',
        defaultCwd: '/code',
        defaultShell: '/bin/bash',
        topology: {
          savedAt: new Date(),
          sessionName: 'win-index-sess',
          windows: [
            {
              index: 0,
              name: 'main',
              active: true,
              layout: 'c625,260x56,0,0,1',
              panes: [{ windowIndex: 0, paneIndex: 0, cwd: '/code', active: true }],
            },
          ],
        },
      });

      expect(res.success).toBe(true);
      const moveCmd = executed.find((c) => c.includes('tmux move-window'));
      expect(moveCmd).toBeDefined();
      expect(moveCmd).toContain("-s 'win-index-sess:1' -t 'win-index-sess:0'");
    });

    it('translates saved pane indices when host pane-base-index differs and matches dead pane on resurrection', async () => {
      const executed: string[] = [];
      const host = createResurrectHost();
      host.customRules.push({ pattern: 'which tmux', response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 } });
      host.customRules.push({ pattern: 'tmux has-session', response: { stdout: '', stderr: 'no session', exitCode: 1 } });
      host.customRules.push({
        pattern: 'tmux display-message -p -t',
        response: (cmd) => {
          executed.push(cmd);
          if (cmd.includes('#{window_index}')) {
            return { stdout: '0\n', stderr: '', exitCode: 0 };
          }
          if (cmd.includes('#{pane_id}:::#{pane_index}')) {
            // pane-base-index is 1 on this host, so first pane is index 1
            return { stdout: '%10:::1\n', stderr: '', exitCode: 0 };
          }
          if (cmd.includes('#{pane_id}')) {
            return { stdout: '%10\n', stderr: '', exitCode: 0 };
          }
          if (cmd.includes('#{pane_index}')) {
            return { stdout: '1\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });
      host.customRules.push({
        pattern: 'tmux split-window',
        response: (cmd) => {
          executed.push(cmd);
          // Split pane gets index 2
          return { stdout: '%11:::2\n', stderr: '', exitCode: 0 };
        },
      });
      host.customRules.push({
        pattern: 'tmux',
        response: (cmd) => {
          executed.push(cmd);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });

      const tmux = new TmuxManager();
      const res = await tmux.resurrectSession({
        host,
        sessionName: 'pane-base-idx-sess',
        defaultCwd: '/code/spawnea',
        defaultShell: '/bin/bash',
        topology: {
          savedAt: new Date(),
          sessionName: 'pane-base-idx-sess',
          windows: [
            {
              index: 0,
              name: 'main',
              active: true,
              panes: [
                { windowIndex: 0, paneIndex: 0, cwd: '/code/spawnea/src', active: true },
                { windowIndex: 0, paneIndex: 1, cwd: '/code/spawnea/docs', active: false },
              ],
            },
          ],
        },
      });

      expect(res.success).toBe(true);
      expect(res.translatedTopology).toBeDefined();
      expect(res.translatedTopology?.windows[0].panes[0].paneIndex).toBe(1);
      expect(res.translatedTopology?.windows[0].panes[1].paneIndex).toBe(2);

      // Now verify subsequent dead pane resurrection with the translated topology
      const host2 = createResurrectHost();
      host2.customRules.push({ pattern: 'which tmux', response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 } });
      host2.customRules.push({ pattern: 'tmux has-session', response: { stdout: '', stderr: '', exitCode: 0 } });
      host2.customRules.push({
        pattern: 'tmux list-panes',
        response: {
          // Dead pane %11 at window 0, paneIndex 2 (the second pane, docs)
          stdout: '%10:::0:::0:::1\n%11:::1:::0:::2\n',
          stderr: '',
          exitCode: 0,
        },
      });
      const respawnCommands: string[] = [];
      host2.customRules.push({
        pattern: 'tmux respawn-pane',
        response: (cmd) => {
          respawnCommands.push(cmd);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });
      host2.customRules.push({
        pattern: 'tmux',
        response: () => ({ stdout: '', stderr: '', exitCode: 0 }),
      });

      const res2 = await tmux.resurrectSession({
        host: host2,
        sessionName: 'pane-base-idx-sess',
        defaultCwd: '/code/spawnea',
        defaultShell: '/bin/bash',
        topology: res.translatedTopology,
      });

      expect(res2.success).toBe(true);
      expect(respawnCommands).toHaveLength(1);
      // It must respawn pane %11 in its saved directory /code/spawnea/docs, not defaultCwd or src!
      expect(respawnCommands[0]).toContain("-c '/code/spawnea/docs'");
    });

    it('rejects resurrection when base defaultCwd does not exist on host', async () => {
      const host = new MockHostAdapter('host-1');
      host.customRules.push({ pattern: 'which tmux', response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 } });
      host.customRules.push({ pattern: 'tmux has-session', response: { stdout: '', stderr: 'no session', exitCode: 1 } });
      host.customRules.push({
        pattern: 'test -d',
        response: { stdout: '', stderr: 'directory not found', exitCode: 1 },
      });

      const tmux = new TmuxManager();
      const res = await tmux.resurrectSession({
        host,
        sessionName: 'missing-dir-sess',
        defaultCwd: '/code/nonexistent-worktree',
        defaultShell: '/bin/bash',
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe('Session working directory no longer exists on the host');
    });

    it('falls back to defaultCwd when a pane saved sub-directory does not exist', async () => {
      const executed: string[] = [];
      const host = new MockHostAdapter('host-1');
      host.customRules.push({ pattern: 'which tmux', response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 } });
      host.customRules.push({ pattern: 'tmux has-session', response: { stdout: '', stderr: 'no session', exitCode: 1 } });
      host.customRules.push({
        pattern: 'test -d',
        response: (cmd) => {
          if (cmd.includes('/code/deleted-subdir')) {
            return { stdout: '', stderr: 'directory missing', exitCode: 1 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });
      host.customRules.push({
        pattern: 'tmux display-message -p -t',
        response: (cmd) => {
          if (cmd.includes('#{window_index}')) return { stdout: '0\n', stderr: '', exitCode: 0 };
          if (cmd.includes('#{pane_id}')) return { stdout: '%0\n', stderr: '', exitCode: 0 };
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });
      host.customRules.push({
        pattern: 'tmux',
        response: (cmd) => {
          executed.push(cmd);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });

      const tmux = new TmuxManager();
      const res = await tmux.resurrectSession({
        host,
        sessionName: 'fallback-dir-sess',
        defaultCwd: '/code/valid-root',
        defaultShell: '/bin/bash',
        topology: {
          savedAt: new Date(),
          sessionName: 'fallback-dir-sess',
          windows: [
            {
              index: 0,
              name: 'main',
              active: true,
              layout: 'c625,260x56,0,0,1',
              panes: [
                { windowIndex: 0, paneIndex: 0, cwd: '/code/deleted-subdir', active: true },
              ],
            },
          ],
        },
      });

      expect(res.success).toBe(true);
      const newSessionCmd = executed.find((c) => c.includes('tmux new-session'));
      expect(newSessionCmd).toBeDefined();
      expect(newSessionCmd).toContain("-c '/code/valid-root'");
      expect(newSessionCmd).not.toContain('/code/deleted-subdir');
    });

    it('filters topology mutating commands from tmuxCommands when resurrecting with saved topology', async () => {
      const executed: string[] = [];
      const host = createResurrectHost();
      host.customRules.push({ pattern: 'which tmux', response: { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 } });
      host.customRules.push({ pattern: 'tmux has-session', response: { stdout: '', stderr: 'no session', exitCode: 1 } });
      host.customRules.push({
        pattern: 'tmux display-message -p -t',
        response: (cmd) => {
          if (cmd.includes('#{window_index}')) return { stdout: '0\n', stderr: '', exitCode: 0 };
          if (cmd.includes('#{pane_id}')) return { stdout: '%0\n', stderr: '', exitCode: 0 };
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });
      host.customRules.push({
        pattern: 'tmux',
        response: (cmd) => {
          executed.push(cmd);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });

      const tmux = new TmuxManager();
      const res = await tmux.resurrectSession({
        host,
        sessionName: 'cmd-filter-sess',
        defaultCwd: '/code/spawnea',
        defaultShell: '/bin/bash',
        topology: {
          savedAt: new Date(),
          sessionName: 'cmd-filter-sess',
          windows: [
            {
              index: 0,
              name: 'main',
              active: true,
              layout: 'c625,260x56,0,0,1',
              panes: [{ windowIndex: 0, paneIndex: 0, cwd: '/code/spawnea', active: true }],
            },
          ],
        },
        tmuxCommands: [
          ['split-window', '-h', '-t', '{{session}}'],
          ['new-window', '-n', 'extra'],
          ['select-layout', 'even-horizontal'],
          ['set-hook', '-g', 'client-attached', 'run-shell "echo attached"'],
        ],
      });

      expect(res.success).toBe(true);
      // set-hook should be executed
      expect(executed.some((c) => c.includes('set-hook'))).toBe(true);
      // The extra split-window, new-window, and select-layout from tmuxCommands must not be replayed
      const customSplits = executed.filter((c) => c.includes("tmux 'split-window'") || c.includes('tmux split-window -h -t'));
      expect(customSplits).toHaveLength(0);
      const customNewWins = executed.filter((c) => c.includes("tmux 'new-window'") || c.includes("tmux new-window -n 'extra'"));
      expect(customNewWins).toHaveLength(0);
    });
  });
});
