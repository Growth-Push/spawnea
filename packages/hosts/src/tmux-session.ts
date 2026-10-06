import type {
  HostAdapter,
  PtyOptions,
  PtyStream,
  Logger,
  SessionTopologySnapshot,
  TmuxWindowSnapshot,
  TmuxPaneSnapshot,
} from '@spawnea/domain';
import { createLogger, maskSensitiveString } from '@spawnea/domain';

export interface CreateTmuxSessionOptions {
  host: HostAdapter;
  sessionName: string;
  cwd: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  tmuxOptions?: Record<string, string | number | boolean>;
  tmuxCommands?: string[][];
  logger?: Logger;
}

export interface ResurrectSessionOptions {
  host: HostAdapter;
  sessionName: string;
  defaultCwd: string;
  defaultWindowName?: string;
  defaultShell?: string;
  topology?: SessionTopologySnapshot;
  env?: Record<string, string>;
  tmuxOptions?: Record<string, string | number | boolean>;
  tmuxCommands?: string[][];
  logger?: Logger;
}

export interface TmuxSessionResult {
  success: boolean;
  sessionName: string;
  error?: string;
  translatedTopology?: SessionTopologySnapshot;
  alreadyRunning?: boolean;
}

export interface PaneInspectionResult {
  sessionName?: string;
  paneId?: string;
  panePid?: number;
  paneCurrentCommand?: string;
  paneDead: boolean;
}

export interface DeadPaneInfo {
  paneId: string;
  windowIndex?: number;
  paneIndex?: number;
}

/** Text reached the terminal, but submission was not acknowledged. Do not replay it. */
export class PromptSubmissionError extends Error {
  constructor(readonly deliveryMethod: 'pty' | 'tmux') {
    super('Prompt text was delivered but Enter could not be confirmed. Inspect the terminal before continuing; do not resend the prompt.');
    this.name = 'PromptSubmissionError';
  }
}

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function parseLayoutDimensions(layout?: string): { width: number; height: number } | null {
  if (!layout) return null;
  const match = layout.match(/^[a-f0-9]+,(\d+)x(\d+)/i);
  if (match) {
    const width = parseInt(match[1], 10);
    const height = parseInt(match[2], 10);
    if (!isNaN(width) && !isNaN(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }
  return null;
}

function isHorizontalLayout(layout?: string, paneCount?: number): boolean {
  if (!layout) return (paneCount ?? 0) > 4;
  if (layout.includes('{') || layout.includes('horizontal')) return true;
  if (layout.includes('[') || layout.includes('vertical')) return false;
  return (paneCount ?? 0) > 4;
}

const TOPOLOGY_MUTATING_COMMANDS = new Set([
  'split-window',
  'splitw',
  'new-window',
  'neww',
  'select-layout',
  'selectl',
  'next-layout',
  'nextl',
  'previous-layout',
  'prevl',
  'kill-pane',
  'killp',
  'kill-window',
  'killw',
  'break-pane',
  'breakp',
  'join-pane',
  'joinp',
  'swap-pane',
  'swapp',
  'swap-window',
  'swapw',
  'move-window',
  'movew',
  'rotate-window',
  'rotatew',
]);

export class TmuxManager {
  private readonly logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger || createLogger('TmuxManager');
  }

  private async splitPane(
    host: HostAdapter,
    windowTarget: string,
    paneCwd: string,
    defaultCwd: string,
    splitFlags: string[],
    envArg: string,
    shellArg: string,
    fallbackShellArg: string,
  ): Promise<{ success: boolean; paneId: string | null; paneIndex?: number; error?: string }> {
    let lastErr = '';
    for (const flag of splitFlags) {
      let splitRes = await host.execute(`tmux split-window${flag} -t ${escapeShellArg(windowTarget)}${envArg} -c ${escapeShellArg(paneCwd)} -P -F "#{pane_id}:::#{pane_index}"${shellArg}`);
      if (splitRes.exitCode !== 0 && envArg) {
        splitRes = await host.execute(`tmux split-window${flag} -t ${escapeShellArg(windowTarget)} -c ${escapeShellArg(paneCwd)} -P -F "#{pane_id}:::#{pane_index}"${fallbackShellArg}`);
      }
      if (splitRes.exitCode !== 0 && paneCwd !== defaultCwd) {
        splitRes = await host.execute(`tmux split-window${flag} -t ${escapeShellArg(windowTarget)}${envArg} -c ${escapeShellArg(defaultCwd)} -P -F "#{pane_id}:::#{pane_index}"${shellArg}`);
        if (splitRes.exitCode !== 0 && envArg) {
          splitRes = await host.execute(`tmux split-window${flag} -t ${escapeShellArg(windowTarget)} -c ${escapeShellArg(defaultCwd)} -P -F "#{pane_id}:::#{pane_index}"${fallbackShellArg}`);
        }
      }
      if (splitRes.exitCode === 0) {
        await host.execute(`tmux select-layout -E -t ${escapeShellArg(windowTarget)}`).catch(() => {});
        const out = splitRes.stdout.trim();
        const parts = out.split(':::');
        const paneId = parts[0] || null;
        let paneIndex: number | undefined;
        if (parts[1] !== undefined) {
          const parsed = Number.parseInt(parts[1], 10);
          if (!Number.isNaN(parsed)) paneIndex = parsed;
        }
        return { success: true, paneId, paneIndex };
      }
      lastErr = splitRes.stderr.trim() || splitRes.stdout.trim() || `Exit code ${splitRes.exitCode}`;
      await host.execute(`tmux select-layout -E -t ${escapeShellArg(windowTarget)}`).catch(() => {});
    }
    return { success: false, paneId: null, error: lastErr };
  }

  /**
   * Checks whether a tmux session with the given name currently exists on the target host.
   */
  async hasSession(host: HostAdapter, sessionName: string): Promise<boolean> {
    const result = await host.execute(`tmux has-session -t ${escapeShellArg(sessionName)}`, { timeoutMs: 5000 });
    if (result.exitCode === 124) {
      throw new Error(`tmux has-session timed out for session '${sessionName}'`);
    }
    return result.exitCode === 0;
  }

  /**
   * Starts an Spawnea-owned persistent tmux session inside the prepared project directory
   * and launches the configured harness command.
   */
  async createPersistentSession(options: CreateTmuxSessionOptions): Promise<TmuxSessionResult> {
    const { host, sessionName, cwd, command, args } = options;

    this.logger.info('Creating persistent tmux session on target host', {
      serverId: host.serverId,
      sessionName,
      cwd,
      commandLength: command.length,
      argumentCount: (args || []).length,
    });

    // 1. Verify tmux is installed on target host
    const whichTmux = await host.execute('which tmux');
    if (whichTmux.exitCode !== 0) {
      const err = `tmux is not installed or not in PATH on host ${host.serverId}`;
      this.logger.error('tmux missing on host', new Error(err));
      return { success: false, sessionName, error: err };
    }

    // 2. Check if a session with this name already exists
    const exists = await this.hasSession(host, sessionName);
    if (exists) {
      const err = `A tmux session named '${sessionName}' already exists on host ${host.serverId}`;
      this.logger.warn('Duplicate tmux session detected', { sessionName });
      return { success: false, sessionName, error: err };
    }

    // 3. Create detached tmux session in the project directory
    const createCmd = `tmux new-session -d -s ${escapeShellArg(sessionName)} -c ${escapeShellArg(cwd)}`;
    const createResult = await host.execute(createCmd);

    if (createResult.exitCode !== 0) {
      const err = createResult.stderr.trim() || createResult.stdout.trim() || `Exit code ${createResult.exitCode}`;
      this.logger.error('Failed to create tmux session', new Error(err), { sessionName, cwd });
      return {
        success: false,
        sessionName,
        error: `Failed to create tmux session: ${maskSensitiveString(err)}`,
      };
    }

    await this.applyConfiguredSessionSettings(host, sessionName, options.tmuxOptions, options.tmuxCommands);

    // 4. Construct harness command with arguments and environment variables
    const envEntries = options.env ? Object.entries(options.env) : [];
    const envPrefix =
      envEntries.length > 0
        ? envEntries.map(([k, v]) => `${k}=${escapeShellArg(v)}`).join(' ') + ' '
        : '';

    const fullCommand =
      envPrefix +
      [command, ...(args || [])]
        .map((part) => (/[ \t\n"'\\$`!*?~#&;|<>()[\]{}]/.test(part) ? escapeShellArg(part) : part))
        .join(' ');

    this.logger.info('Sending harness command to tmux session', {
      sessionName,
      argumentCount: (args || []).length,
      environmentVariableCount: envEntries.length,
    });

    // Send command literals to tmux session followed by Enter
    // Using -l sends the exact characters without extra shell quoting layers
    const sendCmd = `tmux send-keys -t ${escapeShellArg(sessionName)} -l -- ${escapeShellArg(fullCommand)}`;
    const sendResult = await host.execute(sendCmd);
    await host.execute(`tmux send-keys -t ${escapeShellArg(sessionName)} Enter`);

    if (sendResult.exitCode !== 0) {
      this.logger.warn('Warning: failed to send initial harness command to tmux session', {
        sessionName,
        error: sendResult.stderr,
      });
    }

    this.logger.info('Persistent tmux session established successfully', { sessionName });
    return {
      success: true,
      sessionName,
    };
  }

  /**
   * Sends keyboard input / prompt text directly to the tmux session.
   */
  async sendInput(host: HostAdapter, sessionName: string, text: string, submitCount = 1): Promise<boolean> {
    if (!Number.isSafeInteger(submitCount) || submitCount < 1 || submitCount > 2) {
      throw new Error('tmux submitCount must be a safe integer between 1 and 2');
    }
    this.logger.info('Sending input to tmux session', { serverId: host.serverId, sessionName, inputLength: text.length });
    // Using -l sends the literal characters without duplicate newline before Enter
    const sanitizedText = text.replace(/\r?\n$/, '').replace(/\r$/, '');
    const sendCmd = `tmux send-keys -t ${escapeShellArg(sessionName)} -l -- ${escapeShellArg(sanitizedText)}`;
    const sendResult = await host.execute(sendCmd);
    if (sendResult.exitCode !== 0) return false;
    // TUI editors may classify an Enter arriving with the text burst as paste
    // content. Submit after the burst has settled, including single-line input.
    await new Promise((resolve) => setTimeout(resolve, 500));
    let enterResult;
    try {
      enterResult = await host.execute(`tmux send-keys -t ${escapeShellArg(sessionName)} Enter`);
    } catch {
      throw new PromptSubmissionError('tmux');
    }
    if (enterResult.exitCode !== 0) throw new PromptSubmissionError('tmux');
    for (let index = 1; index < submitCount; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const confirmation = await host.execute(`tmux send-keys -t ${escapeShellArg(sessionName)} Enter`);
      if (confirmation.exitCode !== 0) throw new PromptSubmissionError('tmux');
    }
    return true;
  }

  /**
   * Opens an interactive PTY channel attached to the running tmux session.
   */
  async attachPty(host: HostAdapter, sessionName: string, options: PtyOptions): Promise<PtyStream> {
    this.logger.info('Attaching PTY to tmux session', { serverId: host.serverId, sessionName });
    const attachCmd = `tmux attach-session -t ${escapeShellArg(sessionName)}`;
    return host.openPty(attachCmd, options);
  }

  private async applyConfiguredSessionSettings(
    host: HostAdapter,
    sessionName: string,
    tmuxOptions: Record<string, string | number | boolean> = {},
    tmuxCommands: string[][] = []
  ): Promise<void> {
    for (const [option, value] of Object.entries(tmuxOptions)) {
      try {
        const optionValue = typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
        const result = await host.execute(
          `tmux set-option -t ${escapeShellArg(sessionName)} ${escapeShellArg(option)} ${escapeShellArg(optionValue)}`
        );
        if (result.exitCode === 0) continue;
        this.logger.warn('Configured tmux option could not be applied', { sessionName, option });
      } catch (error) {
        this.logger.warn('Configured tmux option could not be applied', { sessionName, option, error });
      }
    }

    for (const command of tmuxCommands) {
      try {
        const expandedArgs = command.map((arg) => arg === '{{session}}' ? sessionName : arg);
        const expandedCommand = expandedArgs.map(escapeShellArg).join(' ');
        const result = await host.execute(`tmux ${expandedCommand}`);
        if (result.exitCode === 0) continue;
        this.logger.warn('Configured tmux command could not be applied', {
          sessionName,
          argumentCount: expandedArgs.length,
        });
      } catch (error) {
        this.logger.warn('Configured tmux command could not be applied', {
          sessionName,
          argumentCount: command.length,
          error,
        });
      }
    }
  }

  /**
   * Inspects the foreground process and liveness of a specific session pane.
   */
  async getPaneInspection(host: HostAdapter, sessionName: string): Promise<PaneInspectionResult | null> {
    const cmd = `tmux list-panes -t ${escapeShellArg(sessionName)} -F "#{pane_id}:::#{pane_pid}:::#{pane_current_command}:::#{pane_dead}"`;
    const result = await host.execute(cmd, { timeoutMs: 5000 });
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return null;
    }

    const lines = result.stdout.trim().split('\n');
    let firstPaneResult: PaneInspectionResult | null = null;

    for (const line of lines) {
      const parts = line.split(':::');
      let paneId: string | undefined;
      let pidStr: string;
      let currentCommand: string;
      let deadStr: string;

      if (parts.length >= 4) {
        [paneId, pidStr, currentCommand, deadStr] = parts;
      } else {
        [pidStr, currentCommand, deadStr] = parts;
      }

      const pid = parseInt(pidStr, 10);
      const isDead = deadStr === '1';
      const parsed: PaneInspectionResult = {
        sessionName,
        paneId,
        panePid: isNaN(pid) ? undefined : pid,
        paneCurrentCommand: currentCommand || undefined,
        paneDead: isDead,
      };

      if (!firstPaneResult) {
        firstPaneResult = parsed;
        break;
      }
    }

    return firstPaneResult;
  }

  /**
   * Finds any dead panes in the session that can be respawned during resurrection.
   */
  async listDeadPanes(host: HostAdapter, sessionName: string): Promise<DeadPaneInfo[]> {
    const cmd = `tmux list-panes -s -t ${escapeShellArg(sessionName)} -F "#{pane_id}:::#{pane_dead}:::#{window_index}:::#{pane_index}"`;
    const result = await host.execute(cmd, { timeoutMs: 5000 });
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return [];
    }

    const deadPanes: DeadPaneInfo[] = [];
    const lines = result.stdout.trim().split('\n');
    for (const line of lines) {
      const parts = line.split(':::');
      if (parts.length >= 2) {
        const paneId = parts[0];
        const isDead = parts[1] === '1';
        const winIdx = parts[2] !== undefined && parts[2] !== '' ? parseInt(parts[2], 10) : undefined;
        const paneIdx = parts[3] !== undefined && parts[3] !== '' ? parseInt(parts[3], 10) : undefined;
        if (isDead && paneId) {
          deadPanes.push({
            paneId,
            windowIndex: winIdx !== undefined && !isNaN(winIdx) ? winIdx : undefined,
            paneIndex: paneIdx !== undefined && !isNaN(paneIdx) ? paneIdx : undefined,
          });
        }
      }
    }

    return deadPanes;
  }

  /**
   * Finds any dead pane in the session that can be respawned during resurrection.
   */
  async findDeadPane(host: HostAdapter, sessionName: string): Promise<PaneInspectionResult | null> {
    const deadPanes = await this.listDeadPanes(host, sessionName);
    if (deadPanes.length === 0) {
      return null;
    }
    return {
      sessionName,
      paneId: deadPanes[0].paneId,
      paneDead: true,
    };
  }

  /**
   * Inspects all panes across all active tmux sessions on the host in a single fast command.
   */
  async listSessionPanes(host: HostAdapter): Promise<Map<string, PaneInspectionResult>> {
    const map = new Map<string, PaneInspectionResult>();
    const cmd = `tmux list-panes -a -F "#{session_name}:::#{pane_pid}:::#{pane_current_command}:::#{pane_dead}"`;
    const result = await host.execute(cmd, { timeoutMs: 5000 });
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return map;
    }

    const lines = result.stdout.trim().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const [sessName, pidStr, currentCommand, deadStr] = line.split(':::');
      if (!sessName) continue;
      const pid = parseInt(pidStr, 10);
      map.set(sessName, {
        sessionName: sessName,
        panePid: isNaN(pid) ? undefined : pid,
        paneCurrentCommand: currentCommand || undefined,
        paneDead: deadStr === '1',
      });
    }

    return map;
  }

  /**
   * Captures the tail buffer lines of a tmux pane without altering terminal state.
   */
  async capturePaneTail(
    host: HostAdapter,
    sessionName: string,
    lines: number = 25,
    windowIndex?: number
  ): Promise<string[]> {
    // A session target without a window selects whichever tab the user last
    // viewed. Hermes can leave its metrics footer in the first tab while a
    // later tab is focused, so resolve the first window explicitly.
    const windowsResult = await host.execute(
      `tmux list-windows -t ${escapeShellArg(sessionName)} -F '#{window_index}'`,
      { timeoutMs: 5000 }
    );
    const firstWindow = windowsResult.stdout
      .split('\n')
      .map((value) => value.trim())
      .filter((value) => /^\d+$/.test(value))
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value >= 0)
      .sort((a, b) => a - b)[0];
    const targetWindow = windowIndex !== undefined && Number.isSafeInteger(windowIndex) && windowIndex >= 0 ? windowIndex : firstWindow;
    const target = targetWindow === undefined ? sessionName : `${sessionName}:${targetWindow}`;
    const safeLines = Number.isFinite(lines) ? Math.min(Math.max(0, Math.trunc(lines)), 2_147_483_647) : 25;
    const cmd = `tmux capture-pane -p -t ${escapeShellArg(target)} -S -${safeLines}`;
    const result = await host.execute(cmd, { timeoutMs: 5000 });
    if (result.exitCode !== 0) {
      return [];
    }
    return result.stdout.split('\n');
  }

  /**
   * Discovers active tmux sessions on the host that are not currently tracked by Spawnea.
   */
  async listExternalSessions(
    host: HostAdapter,
    knownSessionNames: Set<string> = new Set()
  ): Promise<import('@spawnea/domain').DiscoveredTmuxSession[]> {
    this.logger.debug('Discovering external tmux sessions on host', { serverId: host.serverId });

    const cmd = `tmux list-sessions -F "#{session_name}:::#{session_windows}:::#{session_created}:::#{pane_pid}:::#{pane_current_command}:::#{pane_current_path}"`;
    const result = await host.execute(cmd).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return [];
    }

    const discovered: import('@spawnea/domain').DiscoveredTmuxSession[] = [];
    const lines = result.stdout.trim().split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split(':::');
      const sessionName = parts[0]?.trim();
      if (!sessionName) continue;

      // Filter out tmux sessions already registered in Spawnea
      if (knownSessionNames.has(sessionName)) {
        continue;
      }

      const windowsCount = parseInt(parts[1], 10) || 1;
      const createdEpoch = parseInt(parts[2], 10);
      const createdAt = !isNaN(createdEpoch) && createdEpoch > 0 ? new Date(createdEpoch * 1000) : undefined;
      const pid = parseInt(parts[3], 10);
      const panePid = !isNaN(pid) && pid > 0 ? pid : undefined;
      const currentCommand = parts[4]?.trim() || undefined;
      const currentPath = parts[5]?.trim() || undefined;

      discovered.push({
        sessionName,
        windowsCount,
        createdAt,
        panePid,
        currentCommand,
        currentPath,
      });
    }

    return discovered;
  }

  /**
   * Kills a tmux session intentionally and validates that execution actually ended (FG-2.7.3).
   */
  async killSession(host: HostAdapter, sessionName: string): Promise<boolean> {
    this.logger.info('Killing tmux session', { serverId: host.serverId, sessionName });
    const killCmd = `tmux kill-session -t ${escapeShellArg(sessionName)}`;
    const killResult = await host.execute(killCmd);
    // Keep diagnostics deterministic without changing the host or session locale.
    const verification = await host.execute(`LC_ALL=C tmux has-session -t ${escapeShellArg(sessionName)}`);
    if (verification.exitCode === 0) return false;
    if (verification.exitCode === 1 && /^(can't find session(?:\b|:)|no server running on |error connecting to .+ \(No such file or directory\))/m.test(verification.stderr.trim())) {
      return true;
    }
    if (verification.exitCode === 1 && verification.stderr.trim() === 'no current target') {
      const remainingSessions = await host.execute('LC_ALL=C tmux list-sessions -F "#{session_name}"');
      const listedNames = remainingSessions.stdout.split('\n').map((name) => name.trim()).filter(Boolean);
      if (remainingSessions.exitCode === 0) return !listedNames.includes(sessionName);
      if (remainingSessions.exitCode === 1 && /^no server running on /m.test(remainingSessions.stderr.trim())) return true;
    }
    if (killResult.exitCode === 0 && verification.exitCode === 1 && verification.stderr.trim() === 'server exited unexpectedly') {
      return true;
    }
    throw new Error(`Failed to verify termination of tmux session '${sessionName}': ${verification.stderr.trim() || `exit code ${verification.exitCode}`}`);
  }

  /**
   * Captures the full session layout (windows, layouts, panes, working directories)
   * for resurrection after restart or crash.
   */
  async captureSessionTopology(host: HostAdapter, sessionName: string): Promise<SessionTopologySnapshot> {
    this.logger.info('Capturing tmux session topology', { serverId: host.serverId, sessionName });
    const exists = await this.hasSession(host, sessionName);
    if (!exists) {
      throw new Error(`Tmux session '${sessionName}' does not exist on host '${host.serverId}'`);
    }

    // 1. List windows: index, active flag, layout, and free-text name placed last
    const winCmd = `tmux list-windows -t ${escapeShellArg(sessionName)} -F "#{window_index}:::#{window_active}:::#{window_layout}:::#{window_name}"`;
    const winResult = await host.execute(winCmd, { timeoutMs: 5000 });
    if (winResult.exitCode !== 0) {
      throw new Error(`Failed to list tmux windows for session '${sessionName}': ${winResult.stderr || winResult.stdout}`);
    }

    // 2. List panes across all windows of this session: window index, pane index, active flag, path, and free-text title last
    const paneCmd = `tmux list-panes -s -t ${escapeShellArg(sessionName)} -F "#{window_index}:::#{pane_index}:::#{pane_active}:::#{pane_current_path}:::#{pane_title}"`;
    const paneResult = await host.execute(paneCmd, { timeoutMs: 5000 });
    if (paneResult.exitCode !== 0) {
      throw new Error(`Failed to list tmux panes for session '${sessionName}': ${paneResult.stderr || paneResult.stdout}`);
    }

    const panesByWindow = new Map<number, TmuxPaneSnapshot[]>();
    for (const line of paneResult.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(':::');
      if (parts.length < 5) continue;

      const windowIndex = parseInt(parts[0], 10);
      const paneIndex = parseInt(parts[1], 10);
      const active = parts[2] === '1';
      const cleanCwd = parts[3]?.trim();
      const title = parts.slice(4).join(':::').trim() || undefined;

      if (isNaN(windowIndex) || isNaN(paneIndex) || !cleanCwd) continue;

      const pane: TmuxPaneSnapshot = {
        windowIndex,
        paneIndex,
        cwd: cleanCwd,
        title,
        active,
      };
      const list = panesByWindow.get(windowIndex) || [];
      list.push(pane);
      panesByWindow.set(windowIndex, list);
    }

    const windows: TmuxWindowSnapshot[] = [];
    for (const line of winResult.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(':::');
      if (parts.length < 4) continue;

      const index = parseInt(parts[0], 10);
      const active = parts[1] === '1';
      const layout = parts[2];
      const name = parts.slice(3).join(':::');

      if (isNaN(index)) continue;

      const panes = (panesByWindow.get(index) || []).sort((a, b) => a.paneIndex - b.paneIndex);
      if (panes.length === 0) continue;

      windows.push({
        index,
        name: name || `win-${index}`,
        active,
        layout: layout || undefined,
        panes,
      });
    }

    if (windows.length === 0) {
      throw new Error(`No active windows with valid working directories found in tmux session '${sessionName}'`);
    }

    windows.sort((a, b) => a.index - b.index);

    return {
      savedAt: new Date(),
      sessionName,
      windows,
    };
  }

  /**
   * Resurrects a tmux session from a saved topology or default worktree path cleanly,
   * opening the shell in the saved paths without injecting arbitrary commands.
   */
  async resurrectSession(options: ResurrectSessionOptions): Promise<TmuxSessionResult> {
    const { host, sessionName, defaultCwd, defaultWindowName, topology } = options;

    this.logger.info('Resurrecting tmux session on target host', {
      serverId: host.serverId,
      sessionName,
      defaultCwd,
      hasTopology: Boolean(topology),
      windowCount: topology?.windows.length,
    });

    // 1. Verify tmux is installed
    const whichTmux = await host.execute('which tmux');
    if (whichTmux.exitCode !== 0) {
      const err = `tmux is not installed or not in PATH on host ${host.serverId}`;
      this.logger.error('tmux missing on host during resurrect', new Error(err));
      return { success: false, sessionName, error: err };
    }

    // 2. Resolve default shell to launch cleanly without invoking unintended default-commands
    let resolvedShell = options.defaultShell;
    if (!resolvedShell) {
      const showShell = await host.execute('tmux show-options -g -v default-shell').catch(() => null);
      if (showShell && showShell.exitCode === 0 && showShell.stdout.trim()) {
        resolvedShell = showShell.stdout.trim();
      } else {
        resolvedShell = 'sh';
      }
    }
    const shellArg = ` ${escapeShellArg(resolvedShell)}`;

    // Build fallback shell command containing environment prefix for tmux versions that lack '-e' support
    const envEntries = options.env ? Object.entries(options.env) : [];
    const envFlags = envEntries.map(([k, v]) => `-e ${escapeShellArg(`${k}=${v}`)}`).join(' ');
    const envArg = envFlags ? ` ${envFlags}` : '';
    const fallbackEnvPrefix = envEntries.map(([k, v]) => `${k}=${escapeShellArg(v)}`).join(' ');
    const fallbackShellCmd = fallbackEnvPrefix
      ? `env ${fallbackEnvPrefix} ${escapeShellArg(resolvedShell)}`
      : resolvedShell;
    const fallbackShellArg = ` ${escapeShellArg(fallbackShellCmd)}`;

    // 3. Check if session already exists
    const exists = await this.hasSession(host, sessionName);
    if (exists) {
      const deadPanes = await this.listDeadPanes(host, sessionName).catch(() => []);
      if (deadPanes.length > 0) {
        this.logger.info('Tmux session exists with dead panes during resurrect; respawning dead panes', {
          sessionName,
          deadPaneCount: deadPanes.length,
        });

        for (const deadPane of deadPanes) {
          let targetCwd = defaultCwd;
          if (topology?.windows && deadPane.windowIndex !== undefined && deadPane.paneIndex !== undefined) {
            const win = topology.windows.find((w) => w.index === deadPane.windowIndex);
            let pane = win?.panes.find((p) => p.paneIndex === deadPane.paneIndex);
            if (!pane && win?.panes && win.panes.length > 0) {
              const baseIndex = win.panes[0]?.paneIndex ?? 0;
              const relativeIndex = deadPane.paneIndex - baseIndex;
              if (relativeIndex >= 0 && relativeIndex < win.panes.length) {
                pane = win.panes[relativeIndex];
              }
            }
            if (pane?.cwd) {
              targetCwd = pane.cwd;
            }
          }

          let respawnRes = await host.execute(`tmux respawn-pane -k -t ${escapeShellArg(deadPane.paneId)}${envArg} -c ${escapeShellArg(targetCwd)}${shellArg}`);
          if (respawnRes.exitCode !== 0 && envArg) {
            respawnRes = await host.execute(`tmux respawn-pane -k -t ${escapeShellArg(deadPane.paneId)} -c ${escapeShellArg(targetCwd)}${fallbackShellArg}`);
          }
          if (respawnRes.exitCode !== 0 && targetCwd !== defaultCwd) {
            respawnRes = await host.execute(`tmux respawn-pane -k -t ${escapeShellArg(deadPane.paneId)}${envArg} -c ${escapeShellArg(defaultCwd)}${shellArg}`);
            if (respawnRes.exitCode !== 0 && envArg) {
              respawnRes = await host.execute(`tmux respawn-pane -k -t ${escapeShellArg(deadPane.paneId)} -c ${escapeShellArg(defaultCwd)}${fallbackShellArg}`);
            }
          }
          if (respawnRes.exitCode !== 0) {
            const err = respawnRes.stderr.trim() || respawnRes.stdout.trim() || `Exit code ${respawnRes.exitCode}`;
            this.logger.error('Failed to respawn dead pane during resurrect', new Error(err), { sessionName, paneId: deadPane.paneId, targetCwd });
            return { success: false, sessionName, error: `Failed to respawn dead pane: ${maskSensitiveString(err)}` };
          }
        }
      } else {
        this.logger.info('Tmux session already exists during resurrect; skipping recreation', { sessionName });
      }

      if (options.env) {
        for (const [key, value] of Object.entries(options.env)) {
          await host.execute(`tmux set-environment -t ${escapeShellArg(sessionName)} ${escapeShellArg(key)} ${escapeShellArg(value)}`).catch(() => {});
        }
      }

      return { success: true, sessionName, alreadyRunning: deadPanes.length === 0 };
    }

    // Verify base working directory exists on target host before resurrecting
    const defaultCwdCheck = await host.execute(`test -d ${escapeShellArg(defaultCwd)}`);
    if (defaultCwdCheck.exitCode !== 0) {
      this.logger.error('Base working directory does not exist for resurrection', undefined, { sessionName });
      return { success: false, sessionName, error: 'Session working directory no longer exists on the host' };
    }

    const resolveVerifiedCwd = async (targetCwd: string | undefined): Promise<string> => {
      if (!targetCwd || targetCwd === defaultCwd) {
        return defaultCwd;
      }
      const check = await host.execute(`test -d ${escapeShellArg(targetCwd)}`);
      return check.exitCode === 0 ? targetCwd : defaultCwd;
    };

    const windows = (topology?.windows && topology.windows.length > 0)
      ? [...topology.windows].sort((a, b) => a.index - b.index)
      : null;

    let translatedTopology: SessionTopologySnapshot | undefined;

    if (!windows || windows.length === 0) {
      const winArg = defaultWindowName ? ` -n ${escapeShellArg(defaultWindowName)}` : '';
      let createCmd = `tmux new-session -d -s ${escapeShellArg(sessionName)}${envArg} -c ${escapeShellArg(defaultCwd)}${winArg}${shellArg}`;
      let createResult = await host.execute(createCmd);
      if (createResult.exitCode !== 0 && envArg) {
        createCmd = `tmux new-session -d -s ${escapeShellArg(sessionName)} -c ${escapeShellArg(defaultCwd)}${winArg}${fallbackShellArg}`;
        createResult = await host.execute(createCmd);
      }
      if (createResult.exitCode !== 0) {
        const err = createResult.stderr.trim() || createResult.stdout.trim() || `Exit code ${createResult.exitCode}`;
        this.logger.error('Failed to resurrect tmux session', new Error(err), { sessionName, defaultCwd });
        return { success: false, sessionName, error: `Failed to resurrect tmux session: ${maskSensitiveString(err)}` };
      }
    } else {
      const firstWindow = windows[0];
      const initialPane = firstWindow.panes[0];
      const initialCwd = await resolveVerifiedCwd(initialPane?.cwd);
      const initialWindowName = firstWindow.name || defaultWindowName || 'main';

      // Size the detached session to accommodate saved window geometry and pane count
      // so temporary splits do not exhaust vertical or horizontal canvas space before layout application.
      let maxWidth = 0;
      let maxHeight = 0;
      for (const win of windows) {
        const dims = parseLayoutDimensions(win.layout);
        if (dims) {
          maxWidth = Math.max(maxWidth, dims.width);
          maxHeight = Math.max(maxHeight, dims.height);
        }
        maxWidth = Math.max(maxWidth, (win.panes.length + 1) * 30);
        maxHeight = Math.max(maxHeight, (win.panes.length + 1) * 5);
      }
      const sizeArg = maxWidth > 0 && maxHeight > 0 ? ` -x ${maxWidth} -y ${maxHeight}` : '';

      let createCmd = `tmux new-session -d -s ${escapeShellArg(sessionName)}${envArg} -c ${escapeShellArg(initialCwd)} -n ${escapeShellArg(initialWindowName)}${sizeArg}${shellArg}`;
      let createResult = await host.execute(createCmd);
      if (createResult.exitCode !== 0 && envArg) {
        createCmd = `tmux new-session -d -s ${escapeShellArg(sessionName)} -c ${escapeShellArg(initialCwd)} -n ${escapeShellArg(initialWindowName)}${sizeArg}${fallbackShellArg}`;
        createResult = await host.execute(createCmd);
      }
      if (createResult.exitCode !== 0) {
        const err = createResult.stderr.trim() || createResult.stdout.trim() || `Exit code ${createResult.exitCode}`;
        this.logger.error('Failed to resurrect tmux session', new Error(err), { sessionName, initialCwd });
        return { success: false, sessionName, error: `Failed to resurrect tmux session: ${maskSensitiveString(err)}` };
      }

      let sessionCreated = true;
      try {
        const configuredWindowSize = options.tmuxOptions?.['window-size'];

        // Map saved window index to actual created window index
        const windowIndexMap = new Map<number, string>();
        const paneIndexMapByWindow = new Map<number, (number | undefined)[]>();

        const resolvePaneIndex = async (target: string): Promise<number | undefined> => {
          const query = await host.execute(`tmux display-message -p -t ${escapeShellArg(target)} "#{pane_index}"`).catch(() => null);
          if (query && query.exitCode === 0 && query.stdout.trim()) {
            const idx = Number.parseInt(query.stdout.trim(), 10);
            if (!Number.isNaN(idx)) return idx;
          }
          return undefined;
        };

        // Query actual index of the initial created window to account for base-index settings
        const firstWinQuery = await host.execute(`tmux display-message -p -t ${escapeShellArg(sessionName)} "#{window_index}"`);
        let firstWinIndex = firstWinQuery.exitCode === 0 && firstWinQuery.stdout.trim()
          ? firstWinQuery.stdout.trim()
          : String(firstWindow.index);

        if (firstWinIndex !== String(firstWindow.index)) {
          const moveRes = await host.execute(
            `tmux move-window -s ${escapeShellArg(`${sessionName}:${firstWinIndex}`)} -t ${escapeShellArg(`${sessionName}:${firstWindow.index}`)}`
          );
          if (moveRes.exitCode === 0) {
            firstWinIndex = String(firstWindow.index);
          }
        }
        const firstWinTarget = `${sessionName}:${firstWinIndex}`;
        windowIndexMap.set(firstWindow.index, firstWinIndex);

        // Track created pane IDs and actual pane indices for first window
        const firstWinPaneIds: (string | null)[] = [];
        const firstWinPaneIndices: (number | undefined)[] = [];
        const firstPaneQuery = await host.execute(`tmux display-message -p -t ${escapeShellArg(firstWinTarget)} "#{pane_id}:::#{pane_index}"`);
        let firstPaneId: string | null = null;
        let firstPaneIndex: number | undefined;
        if (firstPaneQuery.exitCode === 0 && firstPaneQuery.stdout.trim()) {
          const parts = firstPaneQuery.stdout.trim().split(':::');
          firstPaneId = parts[0] || null;
          if (parts[1] !== undefined) {
            const idx = Number.parseInt(parts[1], 10);
            if (!Number.isNaN(idx)) firstPaneIndex = idx;
          }
        }
        if (firstPaneIndex === undefined) {
          firstPaneIndex = await resolvePaneIndex(firstWinTarget);
        }
        firstWinPaneIds.push(firstPaneId);
        firstWinPaneIndices.push(firstPaneIndex);

        if (maxWidth > 0 && maxHeight > 0) {
          await host.execute(`tmux resize-window -t ${escapeShellArg(firstWinTarget)} -x ${maxWidth} -y ${maxHeight}`).catch(() => {});
        }

        const isFirstWinHoriz = isHorizontalLayout(firstWindow.layout, firstWindow.panes.length);
        const firstWinSplitFlags = isFirstWinHoriz ? [' -h', ' -v'] : [' -v', ' -h'];

        // Recreate extra panes in first window
        for (let pIdx = 1; pIdx < firstWindow.panes.length; pIdx++) {
          const pane = firstWindow.panes[pIdx];
          const paneCwd = await resolveVerifiedCwd(pane.cwd);
          const splitRes = await this.splitPane(host, firstWinTarget, paneCwd, defaultCwd, firstWinSplitFlags, envArg, shellArg, fallbackShellArg);
          if (splitRes.success) {
            firstWinPaneIds.push(splitRes.paneId);
            let pIndex = splitRes.paneIndex;
            if (pIndex === undefined && splitRes.paneId) {
              pIndex = await resolvePaneIndex(splitRes.paneId);
            }
            if (pIndex === undefined && firstPaneIndex !== undefined) {
              pIndex = firstPaneIndex + pIdx;
            }
            firstWinPaneIndices.push(pIndex);
          } else {
            firstWinPaneIds.push(null);
            firstWinPaneIndices.push(undefined);
            const err = splitRes.error || 'Failed to split pane';
            this.logger.error('Failed to split pane in first window during resurrect', new Error(err), { sessionName, windowTarget: firstWinTarget });
            await this.killSession(host, sessionName).catch(() => {});
            return { success: false, sessionName, error: `Failed to create pane in window '${firstWinTarget}': ${maskSensitiveString(err)}` };
          }
        }
        paneIndexMapByWindow.set(firstWindow.index, firstWinPaneIndices);
        if (firstWindow.layout) {
          await host.execute(`tmux select-layout -t ${escapeShellArg(firstWinTarget)} ${escapeShellArg(firstWindow.layout)}`).catch(() => {});
        }
        const firstWinDims = parseLayoutDimensions(firstWindow.layout);
        if (firstWinDims) {
          await host.execute(`tmux resize-window -t ${escapeShellArg(firstWinTarget)} -x ${firstWinDims.width} -y ${firstWinDims.height}`).catch(() => {});
        }
        // Restore automatic window sizing after geometry reconstruction
        if (configuredWindowSize !== undefined) {
          await host.execute(`tmux set-option -w -t ${escapeShellArg(firstWinTarget)} window-size ${escapeShellArg(String(configuredWindowSize))}`).catch(() => {});
        } else {
          await host.execute(`tmux set-option -w -u -t ${escapeShellArg(firstWinTarget)} window-size`).catch(() => {});
        }

        const activePane1Idx = firstWindow.panes.findIndex((p) => p.active);
        const chosenPane1Idx = activePane1Idx >= 0 ? activePane1Idx : 0;
        const targetPane1 = firstWinPaneIds[chosenPane1Idx];
        if (targetPane1) {
          await host.execute(`tmux select-pane -t ${escapeShellArg(targetPane1)}`).catch(() => {});
        } else {
          const chosenPane1ActualIndex = firstWinPaneIndices[chosenPane1Idx] ?? chosenPane1Idx;
          await host.execute(`tmux select-pane -t ${escapeShellArg(`${firstWinTarget}.${chosenPane1ActualIndex}`)}`).catch(() => {});
        }

        // Create additional windows
        for (let wIdx = 1; wIdx < windows.length; wIdx++) {
          const win = windows[wIdx];
          const winPane = win.panes[0];
          const winCwd = await resolveVerifiedCwd(winPane?.cwd);
          const winName = win.name || `win-${wIdx}`;
          let newWinRes = await host.execute(`tmux new-window -P -F "#{window_index}" -t ${escapeShellArg(`${sessionName}:${win.index}`)}${envArg} -c ${escapeShellArg(winCwd)} -n ${escapeShellArg(winName)}${shellArg}`);
          if (newWinRes.exitCode !== 0 && envArg) {
            newWinRes = await host.execute(`tmux new-window -P -F "#{window_index}" -t ${escapeShellArg(`${sessionName}:${win.index}`)} -c ${escapeShellArg(winCwd)} -n ${escapeShellArg(winName)}${fallbackShellArg}`);
          }
          if (newWinRes.exitCode !== 0) {
            newWinRes = await host.execute(`tmux new-window -P -F "#{window_index}" -t ${escapeShellArg(sessionName)}${envArg} -c ${escapeShellArg(winCwd)} -n ${escapeShellArg(winName)}${shellArg}`);
            if (newWinRes.exitCode !== 0 && envArg) {
              newWinRes = await host.execute(`tmux new-window -P -F "#{window_index}" -t ${escapeShellArg(sessionName)} -c ${escapeShellArg(winCwd)} -n ${escapeShellArg(winName)}${fallbackShellArg}`);
            }
          }
          if (newWinRes.exitCode !== 0) {
            const err = newWinRes.stderr.trim() || newWinRes.stdout.trim() || `Exit code ${newWinRes.exitCode}`;
            this.logger.error('Failed to create new window during resurrect', new Error(err), { sessionName, windowIndex: win.index });
            await this.killSession(host, sessionName).catch(() => {});
            return { success: false, sessionName, error: `Failed to create window '${winName}': ${maskSensitiveString(err)}` };
          }

          const createdWinIndex = newWinRes.stdout.trim() || String(win.index);
          windowIndexMap.set(win.index, createdWinIndex);
          const winTarget = `${sessionName}:${createdWinIndex}`;

          const winPaneIds: (string | null)[] = [];
          const winPaneIndices: (number | undefined)[] = [];
          const winPaneQuery = await host.execute(`tmux display-message -p -t ${escapeShellArg(winTarget)} "#{pane_id}:::#{pane_index}"`);
          let initialPaneId: string | null = null;
          let initialPaneIndex: number | undefined;
          if (winPaneQuery.exitCode === 0 && winPaneQuery.stdout.trim()) {
            const parts = winPaneQuery.stdout.trim().split(':::');
            initialPaneId = parts[0] || null;
            if (parts[1] !== undefined) {
              const idx = Number.parseInt(parts[1], 10);
              if (!Number.isNaN(idx)) initialPaneIndex = idx;
            }
          }
          if (initialPaneIndex === undefined) {
            initialPaneIndex = await resolvePaneIndex(winTarget);
          }
          winPaneIds.push(initialPaneId);
          winPaneIndices.push(initialPaneIndex);

          if (maxWidth > 0 && maxHeight > 0) {
            await host.execute(`tmux resize-window -t ${escapeShellArg(winTarget)} -x ${maxWidth} -y ${maxHeight}`).catch(() => {});
          }

          const isWinHoriz = isHorizontalLayout(win.layout, win.panes.length);
          const winSplitFlags = isWinHoriz ? [' -h', ' -v'] : [' -v', ' -h'];

          // Extra panes for this window
          for (let pIdx = 1; pIdx < win.panes.length; pIdx++) {
            const pane = win.panes[pIdx];
            const paneCwd = await resolveVerifiedCwd(pane.cwd);
            const splitRes = await this.splitPane(host, winTarget, paneCwd, defaultCwd, winSplitFlags, envArg, shellArg, fallbackShellArg);
            if (splitRes.success) {
              winPaneIds.push(splitRes.paneId);
              let pIndex = splitRes.paneIndex;
              if (pIndex === undefined && splitRes.paneId) {
                pIndex = await resolvePaneIndex(splitRes.paneId);
              }
              if (pIndex === undefined && initialPaneIndex !== undefined) {
                pIndex = initialPaneIndex + pIdx;
              }
              winPaneIndices.push(pIndex);
            } else {
              winPaneIds.push(null);
              winPaneIndices.push(undefined);
              const err = splitRes.error || 'Failed to split pane';
              this.logger.error('Failed to split pane in window during resurrect', new Error(err), { sessionName, windowTarget: winTarget });
              await this.killSession(host, sessionName).catch(() => {});
              return { success: false, sessionName, error: `Failed to create pane in window '${winTarget}': ${maskSensitiveString(err)}` };
            }
          }
          paneIndexMapByWindow.set(win.index, winPaneIndices);
          if (win.layout) {
            await host.execute(`tmux select-layout -t ${escapeShellArg(winTarget)} ${escapeShellArg(win.layout)}`).catch(() => {});
          }
          const winDims = parseLayoutDimensions(win.layout);
          if (winDims) {
            await host.execute(`tmux resize-window -t ${escapeShellArg(winTarget)} -x ${winDims.width} -y ${winDims.height}`).catch(() => {});
          }
          // Restore automatic window sizing after geometry reconstruction
          if (configuredWindowSize !== undefined) {
            await host.execute(`tmux set-option -w -t ${escapeShellArg(winTarget)} window-size ${escapeShellArg(String(configuredWindowSize))}`).catch(() => {});
          } else {
            await host.execute(`tmux set-option -w -u -t ${escapeShellArg(winTarget)} window-size`).catch(() => {});
          }

          const activePaneIdx = win.panes.findIndex((p) => p.active);
          const chosenPaneIdx = activePaneIdx >= 0 ? activePaneIdx : 0;
          const targetPane = winPaneIds[chosenPaneIdx];
          if (targetPane) {
            await host.execute(`tmux select-pane -t ${escapeShellArg(targetPane)}`).catch(() => {});
          } else {
            const chosenPaneActualIndex = winPaneIndices[chosenPaneIdx] ?? chosenPaneIdx;
            await host.execute(`tmux select-pane -t ${escapeShellArg(`${winTarget}.${chosenPaneActualIndex}`)}`).catch(() => {});
          }
        }

        // Select active window using windowIndexMap
        const activeWin = windows.find((w) => w.active);
        if (activeWin) {
          const resolvedWinIndex = windowIndexMap.get(activeWin.index) ?? firstWinIndex;
          const activeTarget = `${sessionName}:${resolvedWinIndex}`;
          await host.execute(`tmux select-window -t ${escapeShellArg(activeTarget)}`).catch(() => {});
        }

        if (options.topology) {
          let topologyChanged = false;
          const remappedWindows = options.topology.windows.map((w) => {
            const mappedIndexStr = windowIndexMap.get(w.index);
            const mappedIndex = mappedIndexStr ? Number.parseInt(mappedIndexStr, 10) : w.index;
            const targetWinIndex = !Number.isNaN(mappedIndex) ? mappedIndex : w.index;
            const winIndexChanged = targetWinIndex !== w.index;

            const actualPaneIndices = paneIndexMapByWindow.get(w.index);
            let panesChanged = false;
            const remappedPanes = w.panes.map((p, pIdx) => {
              const actualPaneIndex = actualPaneIndices ? actualPaneIndices[pIdx] : undefined;
              const newPaneIndex = actualPaneIndex !== undefined ? actualPaneIndex : p.paneIndex;
              if (newPaneIndex !== p.paneIndex || targetWinIndex !== p.windowIndex) {
                panesChanged = true;
              }
              return {
                ...p,
                windowIndex: targetWinIndex,
                paneIndex: newPaneIndex,
              };
            });

            if (winIndexChanged || panesChanged) {
              topologyChanged = true;
              return {
                ...w,
                index: targetWinIndex,
                panes: remappedPanes,
              };
            }
            return w;
          });
          if (topologyChanged) {
            translatedTopology = {
              ...options.topology,
              windows: remappedWindows,
            };
          }
        }
      } catch (err: any) {
        if (sessionCreated) {
          await this.killSession(host, sessionName).catch(() => {});
        }
        throw err;
      }
    }

    const effectiveCommands = options.topology
      ? (options.tmuxCommands ?? []).filter((cmd) => !TOPOLOGY_MUTATING_COMMANDS.has(cmd[0]))
      : options.tmuxCommands;

    await this.applyConfiguredSessionSettings(host, sessionName, options.tmuxOptions, effectiveCommands);

    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        await host.execute(`tmux set-environment -t ${escapeShellArg(sessionName)} ${escapeShellArg(key)} ${escapeShellArg(value)}`).catch(() => {});
      }
    }

    this.logger.info('Tmux session resurrected successfully', { sessionName });
    return {
      success: true,
      sessionName,
      translatedTopology,
    };
  }
}
