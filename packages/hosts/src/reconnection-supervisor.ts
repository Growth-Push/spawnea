import type {
  HostConnectionState,

  Logger,
} from '@spawnea/domain';
import { createLogger } from '@spawnea/domain';

export interface ReconnectionSupervisorOptions {
  backoffScheduleMs?: number[];
  maxAttempts?: number;
  logger?: Logger;
}

export type ConnectionStateListener = (state: HostConnectionState) => void | Promise<void>;
export type ReconnectAction = (serverId: string) => Promise<boolean | void>;

export class HostReconnectionSupervisor {
  private readonly backoffScheduleMs: number[];
  private readonly maxAttempts: number;
  private readonly logger: Logger;
  private readonly hostStates: Map<string, HostConnectionState> = new Map();
  private readonly retryTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly listeners: Set<ConnectionStateListener> = new Set();
  private readonly inFlightReconnections: Set<string> = new Set();

  constructor(options?: ReconnectionSupervisorOptions) {
    this.backoffScheduleMs = options?.backoffScheduleMs || [1000, 2000, 5000, 10000, 30000];
    this.maxAttempts = options?.maxAttempts || this.backoffScheduleMs.length;
    this.logger = options?.logger || createLogger('ReconnectionSupervisor');
  }

  getBackoffDelay(attempt: number): number {
    const idx = Math.max(0, Math.min(attempt - 1, this.backoffScheduleMs.length - 1));
    return this.backoffScheduleMs[idx];
  }

  getState(serverId: string): HostConnectionState {
    if (!this.hostStates.has(serverId)) {
      return {
        serverId,
        status: 'connected',
        attempt: 0,
        maxAttempts: this.maxAttempts,
      };
    }
    return { ...this.hostStates.get(serverId)! };
  }

  onStateChange(listener: ConnectionStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async notify(state: HostConnectionState): Promise<void> {
    this.hostStates.set(state.serverId, { ...state });
    for (const listener of this.listeners) {
      try {
        await listener({ ...state });
      } catch (err) {
        this.logger.error('Error in connection state change listener', err);
      }
    }
  }

  async markConnected(serverId: string): Promise<void> {
    this.clearTimer(serverId);
    const state: HostConnectionState = {
      serverId,
      status: 'connected',
      attempt: 0,
      maxAttempts: this.maxAttempts,
      lastConnectedAt: new Date().toISOString(),
    };
    this.logger.info('Host connection marked as connected', { serverId });
    await this.notify(state);
  }

  async markDisconnected(serverId: string, error?: string): Promise<void> {
    this.clearTimer(serverId);
    const current = this.getState(serverId);
    const state: HostConnectionState = {
      serverId,
      status: 'disconnected',
      attempt: current.attempt,
      maxAttempts: this.maxAttempts,
      error: error || current.error,
      lastConnectedAt: current.lastConnectedAt,
    };
    this.logger.info('Host connection marked as disconnected', { serverId, error });
    await this.notify(state);
  }

  /**
   * Called when a connection drop or failure is detected.
   * Begins the exponential backoff reconnection sequence.
   */
  handleConnectionDrop(serverId: string, error: string, reconnectAction: ReconnectAction): void {
    const current = this.getState(serverId);
    if (current.status === 'reconnecting' && this.retryTimers.has(serverId)) {
      this.logger.debug('Reconnection already scheduled for host', { serverId, attempt: current.attempt });
      return;
    }

    const attempt = 1;
    const nextRetryDelayMs = this.getBackoffDelay(attempt);
    const state: HostConnectionState = {
      serverId,
      status: 'reconnecting',
      attempt,
      maxAttempts: this.maxAttempts,
      nextRetryDelayMs,
      error,
      lastConnectedAt: current.lastConnectedAt,
    };

    this.logger.warn('Connection drop detected. Scheduling backoff reconnection', {
      serverId,
      attempt,
      nextRetryDelayMs,
      error,
    });

    this.notify(state);
    this.scheduleRetry(serverId, attempt, nextRetryDelayMs, reconnectAction);
  }

  private scheduleRetry(
    serverId: string,
    attempt: number,
    delayMs: number,
    reconnectAction: ReconnectAction
  ): void {
    this.clearTimer(serverId);

    const timer = setTimeout(async () => {
      this.retryTimers.delete(serverId);
      await this.executeReconnectAttempt(serverId, attempt, reconnectAction);
    }, delayMs);

    this.retryTimers.set(serverId, timer);
  }

  private async executeReconnectAttempt(
    serverId: string,
    attempt: number,
    reconnectAction: ReconnectAction
  ): Promise<boolean> {
    if (this.inFlightReconnections.has(serverId)) {
      return false;
    }

    this.inFlightReconnections.add(serverId);
    this.logger.info('Executing host reconnection attempt', {
      serverId,
      attempt,
      maxAttempts: this.maxAttempts,
    });

    try {
      const res = await reconnectAction(serverId);
      const success = res !== false;

      if (success) {
        await this.markConnected(serverId);
        return true;
      }
      throw new Error('Reconnection attempt returned false');
    } catch (err: any) {
      const nextAttempt = attempt + 1;
      const errorMsg = err?.message || String(err);

      if (nextAttempt > this.maxAttempts) {
        this.logger.error('Max reconnection attempts exhausted for host', err, {
          serverId,
          attempts: attempt,
          maxAttempts: this.maxAttempts,
        });

        const state: HostConnectionState = {
          serverId,
          status: 'disconnected',
          attempt,
          maxAttempts: this.maxAttempts,
          error: `Connection lost (${errorMsg}). Stopped after ${this.maxAttempts} attempts.`,
          lastConnectedAt: this.getState(serverId).lastConnectedAt,
        };
        await this.notify(state);
        return false;
      }

      const nextDelayMs = this.getBackoffDelay(nextAttempt);
      this.logger.warn('Reconnection attempt failed, scheduling next retry', {
        serverId,
        failedAttempt: attempt,
        nextAttempt,
        nextDelayMs,
        error: errorMsg,
      });

      const state: HostConnectionState = {
        serverId,
        status: 'reconnecting',
        attempt: nextAttempt,
        maxAttempts: this.maxAttempts,
        nextRetryDelayMs: nextDelayMs,
        error: errorMsg,
        lastConnectedAt: this.getState(serverId).lastConnectedAt,
      };
      await this.notify(state);
      this.scheduleRetry(serverId, nextAttempt, nextDelayMs, reconnectAction);
      return false;
    } finally {
      this.inFlightReconnections.delete(serverId);
    }
  }

  /**
   * Immediately triggers a reconnection attempt, cancelling any pending scheduled timer.
   */
  async retryNow(serverId: string, reconnectAction: ReconnectAction): Promise<boolean> {
    this.logger.info('Manual reconnection requested (Retry Now)', { serverId });
    this.clearTimer(serverId);

    const current = this.getState(serverId);
    const attempt = current.status === 'reconnecting' ? current.attempt : 1;

    const state: HostConnectionState = {
      serverId,
      status: 'reconnecting',
      attempt,
      maxAttempts: this.maxAttempts,
      nextRetryDelayMs: 0,
      error: undefined,
      lastConnectedAt: current.lastConnectedAt,
    };
    await this.notify(state);

    return this.executeReconnectAttempt(serverId, attempt, reconnectAction);
  }

  private clearTimer(serverId: string): void {
    const existing = this.retryTimers.get(serverId);
    if (existing) {
      clearTimeout(existing);
      this.retryTimers.delete(serverId);
    }
  }

  dispose(): void {
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.listeners.clear();
    this.hostStates.clear();
    this.inFlightReconnections.clear();
  }
}
