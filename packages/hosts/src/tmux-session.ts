import type { HostAdapter, PtyOptions, PtyStream, Logger } from '@spawnea/domain';
import { createLogger, maskSensitiveString } from '@spawnea/domain';

export interface CreateTmuxSessionOptions {
  host: HostAdapter;
  sessionName: string;
  cwd: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  logger?: Logger;
}

export interface TmuxSessionResult {
  success: boolean;
  sessionName: string;
  error?: string;
}

export interface PaneInspectionResult {
  sessionName?: string;
  panePid?: number;
  paneCurrentCommand?: string;
  paneDead: boolean;
}

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export class TmuxManager {
  private readonly logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger || createLogger('TmuxManager');
  }

  /**
   * Checks whether a tmux session with the given name currently exists on the target host.
   */
  async hasSession(host: HostAdapter, sessionName: string): Promise<boolean> {
    const result = await host.execute(`tmux has-session -t ${escapeShellArg(sessionName)}`);
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
      command,
      args,
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

    // Enable mouse wheel scrolling and high scrollback buffer on this tmux session
    await host.execute(`tmux set-option -t ${escapeShellArg(sessionName)} mouse on`).catch(() => {});
    await host.execute(`tmux set-option -t ${escapeShellArg(sessionName)} history-limit 50000`).catch(() => {});

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

    this.logger.info('Sending harness command to tmux session', { sessionName, fullCommand });

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
   * Opens an interactive PTY channel attached to the running tmux session.
   */
  async attachPty(host: HostAdapter, sessionName: string, options: PtyOptions): Promise<PtyStream> {
    this.logger.info('Attaching PTY to tmux session', { serverId: host.serverId, sessionName });
    // Ensure mouse mode is active for mouse wheel scrolling
    await host.execute(`tmux set-option -t ${escapeShellArg(sessionName)} mouse on`).catch(() => {});
    const attachCmd = `tmux attach-session -t ${escapeShellArg(sessionName)}`;
    return host.openPty(attachCmd, options);
  }

  /**
   * Inspects the foreground process and liveness of a specific session pane.
   */
  async getPaneInspection(host: HostAdapter, sessionName: string): Promise<PaneInspectionResult | null> {
    const cmd = `tmux list-panes -t ${escapeShellArg(sessionName)} -F "#{pane_pid}:::#{pane_current_command}:::#{pane_dead}"`;
    const result = await host.execute(cmd);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return null;
    }

    const firstLine = result.stdout.trim().split('\n')[0];
    const [pidStr, currentCommand, deadStr] = firstLine.split(':::');
    const pid = parseInt(pidStr, 10);

    return {
      sessionName,
      panePid: isNaN(pid) ? undefined : pid,
      paneCurrentCommand: currentCommand || undefined,
      paneDead: deadStr === '1',
    };
  }

  /**
   * Inspects all panes across all active tmux sessions on the host in a single fast command.
   */
  async listSessionPanes(host: HostAdapter): Promise<Map<string, PaneInspectionResult>> {
    const map = new Map<string, PaneInspectionResult>();
    const cmd = `tmux list-panes -a -F "#{session_name}:::#{pane_pid}:::#{pane_current_command}:::#{pane_dead}"`;
    const result = await host.execute(cmd);
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
  async capturePaneTail(host: HostAdapter, sessionName: string, lines: number = 25): Promise<string[]> {
    const cmd = `tmux capture-pane -p -t ${escapeShellArg(sessionName)} -S -${lines}`;
    const result = await host.execute(cmd);
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
    await host.execute(killCmd);
    const stillExists = await this.hasSession(host, sessionName);
    return !stillExists;
  }
}
