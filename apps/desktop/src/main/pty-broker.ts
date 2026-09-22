import type { WebContents } from 'electron';
import type { PtyStream, Logger } from '@spawnea/domain';
import { createLogger } from '@spawnea/domain';

export interface PtyChannelMetrics {
  lastOutputAt?: Date;
  lastInputAt?: Date;
  recentOutputBytes: number;
}

interface ManagedPty {
  channelId: string;
  stream: PtyStream;
  webContents: WebContents;
  cleanupFns: (() => void)[];
  metrics: PtyChannelMetrics;
  inFlightBytes: number;
  isPaused: boolean;
  isReady: boolean;
  pendingData: string[];
  pendingBytes: number;
}

export type PtyActivityListener = (
  channelId: string,
  type: 'output' | 'input',
  bytes: number
) => void;

export interface PtyBrokerOptions {
  /** Maximum unacknowledged output bytes in flight before pausing the PTY stream (default: 64KB) */
  highWaterMarkBytes?: number;
  /** In-flight output byte threshold below which a paused PTY stream is resumed (default: 16KB) */
  lowWaterMarkBytes?: number;
}

export class PtyBroker {
  private readonly logger: Logger;
  private readonly channels: Map<string, ManagedPty> = new Map();
  private readonly activityListeners: Set<PtyActivityListener> = new Set();
  private readonly highWaterMarkBytes: number;
  private readonly lowWaterMarkBytes: number;

  constructor(logger?: Logger, options?: PtyBrokerOptions) {
    this.logger = logger || createLogger('PtyBroker');
    this.highWaterMarkBytes = options?.highWaterMarkBytes ?? 64 * 1024;
    this.lowWaterMarkBytes = options?.lowWaterMarkBytes ?? 16 * 1024;
  }

  /**
   * Registers a listener for PTY stream activity (input or output).
   */
  onActivity(listener: PtyActivityListener): () => void {
    this.activityListeners.add(listener);
    return () => {
      this.activityListeners.delete(listener);
    };
  }

  /**
   * Returns current stream metrics for an active PTY channel.
   */
  getMetrics(channelId: string): PtyChannelMetrics | undefined {
    const managed = this.channels.get(channelId);
    return managed ? { ...managed.metrics } : undefined;
  }

  /**
   * Returns flow-control state for an active PTY channel (used in tests and diagnostics).
   */
  getFlowState(channelId: string): { inFlightBytes: number; isPaused: boolean; isReady: boolean } | undefined {
    const managed = this.channels.get(channelId);
    if (!managed) return undefined;
    return {
      inFlightBytes: managed.inFlightBytes,
      isPaused: managed.isPaused,
      isReady: managed.isReady,
    };
  }

  /**
   * Marks that the renderer has attached its listener and is ready to acknowledge output.
   * Flushes bounded output received during the attachment handshake.
   */
  ready(channelId: string): void {
    const managed = this.channels.get(channelId);
    if (!managed) return;

    managed.isReady = true;
    for (const data of managed.pendingData) {
      managed.webContents.send('pty:data', channelId, data);
    }
    managed.inFlightBytes += managed.pendingBytes;
    managed.pendingData = [];
    managed.pendingBytes = 0;
  }

  /**
   * Acknowledges that the renderer has processed/rendered output bytes.
   */
  ack(channelId: string, bytes: number): void {
    const managed = this.channels.get(channelId);
    if (!managed) return;

    if (!managed.isReady) return;
    const validBytes =
      typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
    managed.inFlightBytes = Math.max(0, managed.inFlightBytes - validBytes);

    if (managed.isPaused && managed.inFlightBytes <= this.lowWaterMarkBytes) {
      managed.isPaused = false;
      this.logger.debug('Resuming PTY stream after renderer ack', {
        channelId,
        inFlightBytes: managed.inFlightBytes,
      });
      try {
        managed.stream.resume?.();
      } catch (err) {
        this.logger.warn('Failed to resume PTY stream', { channelId, err });
      }
    }
  }

  /**
   * Registers an active PtyStream to stream data bidirectionally with a WebContents instance.
   */
  registerPty(channelId: string, stream: PtyStream, webContents: WebContents): void {
    // If a channel already exists for this ID, close it first
    if (this.channels.has(channelId)) {
      this.close(channelId);
    }

    this.logger.info('Registering PTY stream channel', { channelId });

    const cleanupFns: (() => void)[] = [];
    const metrics: PtyChannelMetrics = {
      lastOutputAt: undefined,
      lastInputAt: undefined,
      recentOutputBytes: 0,
    };

    const managed: ManagedPty = {
      channelId,
      stream,
      webContents,
      cleanupFns,
      metrics,
      inFlightBytes: 0,
      isPaused: false,
      isReady: false,
      pendingData: [],
      pendingBytes: 0,
    };

    // Forward PTY output data to Renderer and track metrics
    const unData = stream.onData((data: string) => {
      const byteLen = Buffer.byteLength(data, 'utf8');
      metrics.lastOutputAt = new Date();
      metrics.recentOutputBytes += byteLen;

      for (const listener of this.activityListeners) {
        try {
          listener(channelId, 'output', byteLen);
        } catch {
          // Ignore listener errors
        }
      }

      if (webContents.isDestroyed()) {
        // If webContents is already destroyed, immediately close and clean up
        this.close(channelId);
        return;
      }

      if (managed.isReady) {
        webContents.send('pty:data', channelId, data);
        managed.inFlightBytes += byteLen;
      } else {
        managed.pendingData.push(data);
        managed.pendingBytes += byteLen;
      }
      if (!managed.isPaused && managed.inFlightBytes + managed.pendingBytes >= this.highWaterMarkBytes) {
          managed.isPaused = true;
          this.logger.debug('Pausing PTY stream due to high in-flight buffer', {
            channelId,
            inFlightBytes: managed.inFlightBytes,
            highWaterMark: this.highWaterMarkBytes,
          });
          try {
            stream.pause?.();
          } catch (err) {
            this.logger.warn('Failed to pause PTY stream', { channelId, err });
          }
      }
    });
    cleanupFns.push(unData);

    // Forward PTY exit event to Renderer and use standard close cleanup
    const unExit = stream.onExit((code: number) => {
      this.logger.info('PTY stream exited', { channelId, code });
      if (!webContents.isDestroyed()) {
        webContents.send('pty:exit', channelId, code);
      }
      this.close(channelId);
    });
    cleanupFns.push(unExit);

    const onDestroyed = () => this.close(channelId);
    webContents.on('destroyed', onDestroyed);
    cleanupFns.push(() => webContents.removeListener('destroyed', onDestroyed));

    this.channels.set(channelId, managed);
  }

  /**
   * Writes input data (keyboard typing) to the PTY stream and tracks input activity.
   */
  write(channelId: string, data: string): boolean {
    const managed = this.channels.get(channelId);
    if (managed) {
      managed.metrics.lastInputAt = new Date();
      for (const listener of this.activityListeners) {
        try {
          listener(channelId, 'input', data.length);
        } catch {
          // Ignore listener errors
        }
      }
      managed.stream.write(data);
      return true;
    } else {
      this.logger.debug('Attempted to write to unknown or closed PTY channel', { channelId });
      return false;
    }
  }

  /**
   * Resizes the PTY stream dimensions.
   */
  resize(channelId: string, cols: number, rows: number): void {
    const managed = this.channels.get(channelId);
    if (managed) {
      managed.stream.resize(cols, rows);
    }
  }

  /**
   * Closes and cleans up a specific PTY channel.
   */
  close(channelId: string): void {
    const managed = this.channels.get(channelId);
    if (managed) {
      this.logger.info('Closing PTY channel', { channelId });
      this.channels.delete(channelId);
      for (const fn of managed.cleanupFns) {
        try {
          fn();
        } catch {
          // Ignore cleanup errors
        }
      }
      try {
        managed.stream.close();
      } catch {
        // Ignore stream close errors
      }
    }
  }

  /**
   * Closes all active PTY channels (e.g. on application exit).
   */
  closeAll(): void {
    this.logger.info('Closing all active PTY channels', { count: this.channels.size });
    for (const channelId of Array.from(this.channels.keys())) {
      this.close(channelId);
    }
  }
}
