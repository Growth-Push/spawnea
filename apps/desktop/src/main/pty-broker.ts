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
}

export type PtyActivityListener = (
  channelId: string,
  type: 'output' | 'input',
  bytes: number
) => void;

export class PtyBroker {
  private readonly logger: Logger;
  private readonly channels: Map<string, ManagedPty> = new Map();
  private readonly activityListeners: Set<PtyActivityListener> = new Set();

  constructor(logger?: Logger) {
    this.logger = logger || createLogger('PtyBroker');
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

    // Forward PTY output data to Renderer and track metrics
    const unData = stream.onData((data: string) => {
      metrics.lastOutputAt = new Date();
      metrics.recentOutputBytes += data.length;

      for (const listener of this.activityListeners) {
        try {
          listener(channelId, 'output', data.length);
        } catch {
          // Ignore listener errors
        }
      }

      if (!webContents.isDestroyed()) {
        webContents.send('pty:data', channelId, data);
      }
    });
    cleanupFns.push(unData);

    // Forward PTY exit event to Renderer
    const unExit = stream.onExit((code: number) => {
      this.logger.info('PTY stream exited', { channelId, code });
      if (!webContents.isDestroyed()) {
        webContents.send('pty:exit', channelId, code);
      }
      this.channels.delete(channelId);
    });
    cleanupFns.push(unExit);

    this.channels.set(channelId, {
      channelId,
      stream,
      webContents,
      cleanupFns,
      metrics,
    });
  }

  /**
   * Writes input data (keyboard typing) to the PTY stream and tracks input activity.
   */
  write(channelId: string, data: string): void {
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
    } else {
      this.logger.debug('Attempted to write to unknown or closed PTY channel', { channelId });
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
