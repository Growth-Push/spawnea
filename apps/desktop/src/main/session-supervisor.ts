import type { WebContents } from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
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


  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private readonly inFlightChecks: Set<string> = new Set();
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
   * Evaluates and updates status for a single session.
   */
  async checkSession(sessionId: string): Promise<SessionStatusResult> {
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
    try {
      return await this.executeSessionInspection(sessionId);
    } finally {
      this.inFlightChecks.delete(sessionId);
    }
  }

  private async executeSessionInspection(sessionId: string): Promise<SessionStatusResult> {
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

    let harnessName: string | undefined = undefined;
    if (session.agentId) {
      try {
        const agent = await this.repos.agents.findById(session.agentId);
        harnessName = agent?.harness;
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
          tailLines = await this.tmuxManager.capturePaneTail(host, session.tmuxSessionName, 50);
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

    const result = this.stateDetector.detectStatus(signals, harnessName);

    // Auto-detect candidate output artifacts from terminal tail lines
    if (this.artifactManager && tailLines && tailLines.length > 0) {
      try {
        const createdArtifacts = await this.artifactManager.processOutputChunk(
          sessionId,
          tailLines,
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
    const allSessions = await this.repos.sessions.findAll();

    for (const session of allSessions) {
      try {
        const res = await this.checkSession(session.id);
        results.set(session.id, res);
      } catch (err) {
        this.logger.warn('Failed to check status for session', { sessionId: session.id, error: err });
      }
    }

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
   */
  stopPolling(): void {
    if (this.pollTimer) {
      this.logger.info('Stopping SessionSupervisor periodic polling');
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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
    if (session.agentId) {
      try {
        const agent = await this.repos.agents.findById(session.agentId);
        harnessName = agent?.harness;
      } catch {
        // Fall back
      }
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

    const result = this.stateDetector.detectStatus(signals, harnessName);

    return {
      sessionId: session.id,
      sessionName: session.name,
      harness: harnessName || paneCurrentCommand,
      worktreePath: session.worktreePath,
      branch: session.branch,
      detectedStatus: result.status,
      confidence: result.confidence,
      source: result.source,
      reason: result.reason,
      detectedPrompt: result.detectedPrompt,
      tailLines,
      capturedAt: new Date().toISOString(),
    };
  }

  /**
   * Saves a state detection feedback report as a JSON fixture under ~/.config/spawnea/feedback/
   */
  async saveFeedbackReport(report: StateFeedbackReport, customDir?: string): Promise<StateFeedbackResult> {
    const feedbackDir =
      customDir ||
      process.env.SPAWNEA_FEEDBACK_DIR ||
      process.env.SPAWNEA_FEEDBACK_DIR ||
      join(homedir(), '.config', 'spawnea', 'feedback');

    await mkdir(feedbackDir, { recursive: true });

    const safeSessionId = report.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now();
    const filename = `state-feedback-${safeSessionId}-${timestamp}.json`;
    const filePath = join(feedbackDir, filename);

    const fixturePayload = {
      schemaVersion: '1.0.0',
      sessionId: report.sessionId,
      sessionName: report.sessionName,
      harness: report.harness,
      worktreePath: report.worktreePath,
      branch: report.branch,
      detectedStatus: report.detectedStatus,
      detectedSource: report.detectedSource,
      detectedConfidence: report.detectedConfidence,
      detectedPrompt: report.detectedPrompt,
      detectionReason: report.detectionReason,
      expectedStatus: report.expectedStatus,
      userNotes: report.userNotes || '',
      tailLines: report.tailLines || [],
      timestamp: report.timestamp || new Date().toISOString(),
    };

    const fixtureJson = JSON.stringify(fixturePayload, null, 2);
    await writeFile(filePath, fixtureJson, 'utf-8');

    this.logger.info('Saved state detection feedback report fixture', {
      filePath,
      sessionId: report.sessionId,
      detectedStatus: report.detectedStatus,
      expectedStatus: report.expectedStatus,
    });

    return {
      success: true,
      filePath,
      fixtureJson,
    };
  }
}
