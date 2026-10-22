import type { WebContents } from 'electron';
import { join } from 'node:path';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import type {

  SessionSignals,
  SessionStatusResult,
  SessionStatus,
  StateFeedbackSnapshot,
  StateFeedbackReport,
  StateFeedbackResult,
  Logger,
} from '@spawnea/domain';
import { createLogger } from '@spawnea/domain';
import type { Repositories } from '@spawnea/db';
import { TmuxManager } from '@spawnea/hosts';
import { StateDetector } from '@spawnea/state';
import type { SessionManager } from './session-manager.js';
import type { SessionContextStore } from './session-context-store.js';
import type { PtyBroker } from './pty-broker.js';
import type { ArtifactManager } from './artifact-manager.js';
import {
  buildFeedbackPayload,
  FEEDBACK_CAPTURE_FAILED_REASON,
  feedbackDecision,
  feedbackRulesConfig,
} from './state-feedback.js';

/** Terminal lines used for status detection (unchanged). */
const STATUS_DETECTION_TAIL_LINES = 50;
/** Terminal lines scanned for artifact paths. */
const ARTIFACT_DETECTION_TAIL_LINES = 250;

export interface SessionSupervisorOptions {
  repositories: Repositories;
  sessionManager: SessionManager;
  contextStore: SessionContextStore;
  ptyBroker: PtyBroker;
  artifactManager?: ArtifactManager;
  tmuxManager?: TmuxManager;
  stateDetector?: StateDetector;
  logger?: Logger;
  pollIntervalMs?: number;
  maxConcurrentChecks?: number;
  feedbackDir?: string;
}

export type StatusChangeListener = (
  sessionId: string,
  result: SessionStatusResult
) => void;

export class SessionSupervisor {
  private readonly repos: Repositories;
  private readonly sessionManager: SessionManager;
  private readonly contextStore: SessionContextStore;
  private readonly ptyBroker: PtyBroker;
  private readonly artifactManager?: ArtifactManager;
  private readonly tmuxManager: TmuxManager;
  private readonly stateDetector: StateDetector;
  private readonly logger: Logger;
  private readonly defaultPollIntervalMs: number;
  private readonly maxConcurrentChecks: number;
  private readonly feedbackDir?: string;


  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private pollingGeneration = 0;
  private readonly inFlightChecks: Set<string> = new Set();
  private pollingCursor = 0;
  private readonly activityDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly lastStatusMap: Map<string, SessionStatus> = new Map();
  private readonly statusChangeListeners: Set<StatusChangeListener> = new Set();
  private webContentsGetter?: () => WebContents | null;

  constructor(options: SessionSupervisorOptions) {
    this.repos = options.repositories;
    this.sessionManager = options.sessionManager;
    this.contextStore = options.contextStore;
    this.ptyBroker = options.ptyBroker;
    this.artifactManager = options.artifactManager;
    this.logger = options.logger || createLogger('SessionSupervisor');
    this.tmuxManager = options.tmuxManager || new TmuxManager(this.logger.child('tmux'));
    this.stateDetector = options.stateDetector || new StateDetector();
    this.defaultPollIntervalMs = options.pollIntervalMs || 10000;
    this.maxConcurrentChecks = Math.max(1, Math.trunc(options.maxConcurrentChecks ?? 4));
    this.feedbackDir = options.feedbackDir;


    // Listen to real-time PTY activity bursts (debounced to avoid flooding commands on stream bursts)
    this.ptyBroker.onActivity((channelId, type) => {
      if (channelId.startsWith('pty-') && type === 'output') {
        const sessionId = channelId.substring(4);
        const existing = this.activityDebounceTimers.get(sessionId);
        if (existing) {
          clearTimeout(existing);
        }
        this.activityDebounceTimers.set(
          sessionId,
          setTimeout(() => {
            this.activityDebounceTimers.delete(sessionId);
            this.checkSession(sessionId).catch(() => {});
          }, 1500)
        );
      }
    });
  }

  setWebContentsGetter(getter: () => WebContents | null): void {
    this.webContentsGetter = getter;
  }

  onStatusChange(listener: StatusChangeListener): () => void {
    this.statusChangeListeners.add(listener);
    return () => {
      this.statusChangeListeners.delete(listener);
    };
  }

  /**
   * Tells the renderer that a status inspection started or finished so it can show a refresh indicator.
   */
  private notifyCheckState(sessionId: string, checking: boolean): void {
    const wc = this.webContentsGetter?.();
    if (wc && !wc.isDestroyed()) {
      wc.send('session:checkStateChanged', sessionId, checking);
    }
  }

  /**
   * Evaluates and updates status for a single session.
   */
  async checkSession(sessionId: string, generation = this.pollingGeneration): Promise<SessionStatusResult> {
    if (this.inFlightChecks.has(sessionId)) {
      const session = await this.repos.sessions.findById(sessionId);
      return {
        status: session?.status || 'working',
        confidence: 0.8,
        source: 'process',
        reason: 'Session inspection currently in flight',
        updatedAt: new Date(),
      };
    }

    this.inFlightChecks.add(sessionId);
    this.notifyCheckState(sessionId, true);
    try {
      return await this.executeSessionInspection(sessionId, generation);
    } finally {
      this.inFlightChecks.delete(sessionId);
      this.notifyCheckState(sessionId, false);
    }
  }

  private async executeSessionInspection(sessionId: string, generation: number): Promise<SessionStatusResult> {
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const ptyChannelId = `pty-${sessionId}`;
    const ptyMetrics = this.ptyBroker.getMetrics(ptyChannelId);
    const isPtyAttached = ptyMetrics !== undefined;

    let hostReachable = true;
    let tmuxSessionExists = false;
    let paneExists = false;
    let paneDead = false;
    let paneCurrentCommand: string | undefined = undefined;
    let panePid: number | undefined = undefined;
    let tailLines: string[] = [];
    let artifactTailLines: string[] = [];

    let harnessName: string | undefined = undefined;
    let harnessCommand: string | undefined = undefined;
    if (session.agentId) {
      try {
        const agent = await this.repos.agents.findById(session.agentId);
        harnessName = agent?.harness;
        harnessCommand = agent?.command;
      } catch {
        // Fall back to paneCurrentCommand
      }
    }

    try {
      const host = await this.sessionManager.getHostAdapter(session.serverId);
      tmuxSessionExists = await this.tmuxManager.hasSession(host, session.tmuxSessionName);

      if (tmuxSessionExists) {
        const pane = await this.tmuxManager.getPaneInspection(host, session.tmuxSessionName);
        if (pane) {
          paneExists = true;
          paneDead = pane.paneDead;
          paneCurrentCommand = pane.paneCurrentCommand;
          panePid = pane.panePid;
        }

        if (!paneDead) {
          tailLines = await this.tmuxManager.capturePaneTail(
            host,
            session.tmuxSessionName,
            STATUS_DETECTION_TAIL_LINES
          );
          // Artifact detection scans a longer, separate capture so the status
          // detector keeps receiving exactly the capture it always had.
          if (this.artifactManager) {
            artifactTailLines = await this.tmuxManager
              .capturePaneTail(host, session.tmuxSessionName, ARTIFACT_DETECTION_TAIL_LINES)
              .catch((error: unknown) => {
                this.logger.debug('Could not capture terminal tail for artifact detection', { error });
                return [];
              });
          }
        }
      }
    } catch (err) {
      this.logger.warn('Host communication error during status check', {
        sessionId,
        serverId: session.serverId,
        error: err,
      });
      hostReachable = false;
    }

    const signals: SessionSignals = {
      sessionId,
      hostReachable,
      tmuxSessionExists,
      paneExists,
      paneDead,
      paneCurrentCommand,
      panePid,
      isPtyAttached,
      lastOutputAt: ptyMetrics?.lastOutputAt,
      lastInputAt: ptyMetrics?.lastInputAt,
      recentOutputBytes: ptyMetrics?.recentOutputBytes,
      tailLines,
    };

    const result = this.stateDetector.detectStatus(signals, harnessName, { harnessCommand });

    if (generation !== this.pollingGeneration) {
      return result;
    }

    // Auto-detect candidate output artifacts from terminal tail lines
    if (this.artifactManager && artifactTailLines && artifactTailLines.length > 0) {
      try {
        const createdArtifacts = await this.artifactManager.processOutputChunk(
          sessionId,
          artifactTailLines,
          harnessName
        );

        for (const created of createdArtifacts) {
          this.logger.info('Auto-registered output artifact from session stream', {
            sessionId,
            artifactId: created.id,
            filename: created.filename,
            remotePath: created.remotePath,
          });
          const wc = this.webContentsGetter?.();
          if (wc && !wc.isDestroyed()) {
            wc.send('session:artifactCreated', sessionId, created);
          }
        }
      } catch (err) {
        this.logger.debug('Error detecting output artifacts from tailLines', { error: err });
      }
    }

    // If status changed, update storage and broadcast
    const prevStatus = this.lastStatusMap.get(sessionId) || session.status;
    this.lastStatusMap.set(sessionId, result.status);


    if (result.status !== session.status || result.status !== prevStatus) {
      this.logger.info('Session status transition detected', {
        sessionId,
        from: session.status,
        to: result.status,
        confidence: result.confidence,
        source: result.source,
        reason: result.reason,
      });

      await this.repos.sessions.updateStatus(sessionId, result.status);
      await this.contextStore.updateStatus(sessionId, result.status);

      // Notify listeners
      for (const listener of this.statusChangeListeners) {
        try {
          listener(sessionId, result);
        } catch {
          // Ignore listener errors
        }
      }

      // Broadcast to Renderer via IPC
      const wc = this.webContentsGetter?.();
      if (wc && !wc.isDestroyed()) {
        wc.send('session:statusChanged', sessionId, result.status, result);
      }
    }

    return result;
  }

  /**
   * Evaluates all known sessions in database.
   */
  async checkAllSessions(): Promise<Map<string, SessionStatusResult>> {
    const results = new Map<string, SessionStatusResult>();
    const generation = this.pollingGeneration;
    const allSessions = await this.repos.sessions.findAll();

    if (allSessions.length === 0) return results;
    const start = this.pollingCursor % allSessions.length;
    this.pollingCursor = (start + 1) % allSessions.length;
    const orderedSessions = [...allSessions.slice(start), ...allSessions.slice(0, start)];
    let nextIndex = 0;
    const workerCount = Math.min(this.maxConcurrentChecks, orderedSessions.length);

    const worker = async (): Promise<void> => {
      while (nextIndex < orderedSessions.length && generation === this.pollingGeneration) {
        const session = orderedSessions[nextIndex++];
        try {
          const res = await this.checkSession(session.id, generation);
          results.set(session.id, res);
        } catch (err) {
          this.logger.warn('Failed to check status for session', { sessionId: session.id, error: err });
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
  }

  /**
   * Starts periodic polling for live session attention supervision.
   */
  startPolling(intervalMs?: number): void {
    const effectiveInterval = intervalMs || this.defaultPollIntervalMs || 10000;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    this.logger.info('Starting SessionSupervisor periodic polling', { intervalMs: effectiveInterval });
    this.pollTimer = setInterval(async () => {
      if (this.isPolling) return;
      this.isPolling = true;
      try {
        await this.checkAllSessions();
      } catch (err) {
        this.logger.warn('Error during periodic session check', { error: err });
      } finally {
        this.isPolling = false;
      }
    }, effectiveInterval);
  }

  /**
   * Stops periodic polling.
   *
   * An inspection already executing is intentionally not cancelled here. Host
   * inspection commands have five-second deadlines and may be remote; stopping the
   * scheduler and invalidating the polling generation prevents any late result
   * from being published while allowing the owned command to finish safely.
   * This never targets the persistent tmux session or the agent process.
   */
  stopPolling(): void {
    if (this.pollTimer) {
      this.logger.info('Stopping SessionSupervisor periodic polling');
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollingGeneration += 1;
    for (const timer of this.activityDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.activityDebounceTimers.clear();
  }

  /**
   * Captures a detailed feedback snapshot of the active session, including recent terminal lines,
   * pane inspection, and the evaluated status result.
   */
  async captureFeedbackSnapshot(sessionId: string): Promise<StateFeedbackSnapshot> {
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    let harnessName: string | undefined = undefined;
    let harnessCommand: string | undefined = undefined;
    if (session.agentId) {
      try {
        const agent = await this.repos.agents.findById(session.agentId);
        harnessName = agent?.harness;
        harnessCommand = agent?.command;
      } catch {
        // Fall back
      }
    }

    const ptyChannelId = `pty-${sessionId}`;
    const ptyMetrics = this.ptyBroker.getMetrics(ptyChannelId);
    const isPtyAttached = ptyMetrics !== undefined;

    let tmuxSessionExists = false;
    let paneExists = false;
    let paneDead = false;
    let paneCurrentCommand: string | undefined = undefined;
    let panePid: number | undefined = undefined;
    let tailLines: string[] = [];
    let captureFailed = false;

    try {
      const host = await this.sessionManager.getHostAdapter(session.serverId);
      tmuxSessionExists = await this.tmuxManager.hasSession(host, session.tmuxSessionName);

      if (tmuxSessionExists) {
        const pane = await this.tmuxManager.getPaneInspection(host, session.tmuxSessionName);
        if (pane) {
          paneExists = true;
          paneDead = pane.paneDead;
          paneCurrentCommand = pane.paneCurrentCommand;
          panePid = pane.panePid;
        }

        if (!paneDead) {
          tailLines = await this.tmuxManager.capturePaneTail(host, session.tmuxSessionName, 50);
        }
      }
    } catch (err) {
      this.logger.warn('Host communication error during feedback capture', {
        sessionId,
        serverId: session.serverId,
        error: err,
      });
      captureFailed = true;
    }

    const base = {
      sessionId: session.id,
      sessionName: session.name,
      harness: harnessName || paneCurrentCommand,
      worktreePath: session.worktreePath,
      branch: session.branch,
      rulesConfig: feedbackRulesConfig(this.stateDetector.rules),
      capturedAt: new Date().toISOString(),
    };

    if (captureFailed) {
      // Unlike status polling, a report does not turn a failed capture into a
      // detected state: without evidence there is no status, source, or confidence.
      return {
        ...base,
        capture: { status: 'failed', reason: FEEDBACK_CAPTURE_FAILED_REASON },
        tailLines: [],
      };
    }

    const signals: SessionSignals = {
      sessionId,
      hostReachable: true,
      tmuxSessionExists,
      paneExists,
      paneDead,
      paneCurrentCommand,
      panePid,
      isPtyAttached,
      lastOutputAt: ptyMetrics?.lastOutputAt,
      lastInputAt: ptyMetrics?.lastInputAt,
      recentOutputBytes: ptyMetrics?.recentOutputBytes,
      tailLines,
    };

    const result = this.stateDetector.detectStatus(signals, harnessName, { harnessCommand });

    return {
      ...base,
      capture: { status: 'captured' },
      detectedStatus: result.status,
      confidence: result.confidence,
      source: result.source,
      reason: result.reason,
      detectedPrompt: result.detectedPrompt,
      decision: feedbackDecision(result),
      tailLines,
    };
  }

  /**
   * Saves an explicitly requested state detection feedback report under private application storage.
   */
  async saveFeedbackReport(report: StateFeedbackReport, customDir?: string): Promise<StateFeedbackResult> {
    const feedbackDir =
      customDir ||
      process.env.SPAWNEA_FEEDBACK_DIR ||
      this.feedbackDir ||
      join(process.cwd(), '.spawnea', 'feedback');

    await mkdir(feedbackDir, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') {
      try { await chmod(feedbackDir, 0o700); } catch { /* Windows has no equivalent POSIX mode contract. */ }
    } else {
      await chmod(feedbackDir, 0o700);
    }

    const safeSessionId = report.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now();
    const filename = `state-feedback-${safeSessionId}-${timestamp}.json`;
    const filePath = join(feedbackDir, filename);

    // The rules configuration is this process's own; a renderer-supplied value is ignored.
    const fixturePayload = buildFeedbackPayload(report, feedbackRulesConfig(this.stateDetector.rules));

    const fixtureJson = JSON.stringify(fixturePayload, null, 2);
    await writeFile(filePath, fixtureJson, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    try { await chmod(filePath, 0o600); } catch { /* Platform permissions may be unavailable. */ }

    this.logger.info('Saved state detection feedback report fixture', {
      filePath,
      sessionId: report.sessionId,
      observedStatus: report.observedStatus,
      expectedStatus: report.expectedStatus,
      capture: report.capture?.status,
    });

    return {
      success: true,
      filePath,
      fixtureJson,
    };
  }
}
