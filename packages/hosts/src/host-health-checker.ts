import type {
  HostAdapter,
  HostHealthResult,
  HostHealthStatus,
  Logger,
} from '@spawnea/domain';
import { createLogger } from '@spawnea/domain';

export interface HostHealthCheckerOptions {
  getHostAdapter: (hostId: string) => Promise<HostAdapter>;
  timeoutMs?: number;
  degradedLatencyThresholdMs?: number;
  logger?: Logger;
}

export type HealthUpdateListener = (health: HostHealthResult) => void;
export type AllHealthUpdateListener = (healthMap: Record<string, HostHealthResult>) => void;

export interface TargetHostItem {
  id: string;
  target?: string;
}

export class HostHealthChecker {
  private readonly getHostAdapter: (hostId: string) => Promise<HostAdapter>;
  private readonly timeoutMs: number;
  private readonly degradedLatencyThresholdMs: number;
  private readonly logger: Logger;

  private readonly cache: Map<string, HostHealthResult> = new Map();
  private readonly inFlightChecks: Map<string, Promise<HostHealthResult>> = new Map();
  private readonly updateListeners: Set<HealthUpdateListener> = new Set();
  private readonly allUpdateListeners: Set<AllHealthUpdateListener> = new Set();

  private pollIntervalTimer: NodeJS.Timeout | null = null;

  constructor(options: HostHealthCheckerOptions) {
    this.getHostAdapter = options.getHostAdapter;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.degradedLatencyThresholdMs = options.degradedLatencyThresholdMs ?? 300;
    this.logger = options.logger ?? createLogger('HostHealthChecker');
  }

  /**
   * Returns cached health for a specific host, if available.
   */
  getCachedHealth(hostId: string): HostHealthResult | undefined {
    return this.cache.get(hostId);
  }

  /**
   * Returns a dictionary of all cached host health records.
   */
  getAllCachedHealth(): Record<string, HostHealthResult> {
    const result: Record<string, HostHealthResult> = {};
    for (const [id, health] of this.cache.entries()) {
      result[id] = { ...health };
    }
    return result;
  }

  /**
   * Manually sets or overrides cached health for a host.
   */
  setCachedHealth(hostId: string, health: HostHealthResult): void {
    this.cache.set(hostId, health);
    this.notifyUpdate(health);
  }

  /**
   * Subscribes to single host health updates.
   */
  onHealthUpdated(listener: HealthUpdateListener): () => void {
    this.updateListeners.add(listener);
    return () => {
      this.updateListeners.delete(listener);
    };
  }

  /**
   * Subscribes to full batch health check completions.
   */
  onAllUpdated(listener: AllHealthUpdateListener): () => void {
    this.allUpdateListeners.add(listener);
    return () => {
      this.allUpdateListeners.delete(listener);
    };
  }

  private notifyUpdate(health: HostHealthResult): void {
    for (const listener of this.updateListeners) {
      try {
        listener(health);
      } catch (err) {
        this.logger.warn('Error in host health update listener', { hostId: health.hostId, error: err });
      }
    }
  }

  private notifyAllUpdated(healthMap: Record<string, HostHealthResult>): void {
    for (const listener of this.allUpdateListeners) {
      try {
        listener(healthMap);
      } catch (err) {
        this.logger.warn('Error in all host health update listener', { error: err });
      }
    }
  }

  /**
   * Performs a non-blocking health and latency probe on a single host with bounded timeout.
   * Concurrent requests for the same host ID share the active in-flight check.
   */
  async checkHost(hostId: string, target?: string): Promise<HostHealthResult> {
    const existing = this.inFlightChecks.get(hostId);
    if (existing) {
      return existing;
    }

    const checkPromise = this.performCheck(hostId, target).finally(() => {
      this.inFlightChecks.delete(hostId);
    });

    this.inFlightChecks.set(hostId, checkPromise);
    return checkPromise;
  }

  private async performCheck(hostId: string, defaultTarget?: string): Promise<HostHealthResult> {
    const startTime = Date.now();
    const resolvedTarget = defaultTarget || hostId;

    try {
      // 1. Resolve host adapter
      const adapterPromise = this.getHostAdapter(hostId);

      // 2. Bound entire connection and probe with timeoutMs
      const testPromise = adapterPromise.then((adapter) => adapter.testConnection());

      let timeoutTimer: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          reject(new Error(`Connection check timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
      });

      const testResult = await Promise.race([testPromise, timeoutPromise]).finally(() => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
      });

      const latencyMs = testResult.latencyMs ?? (Date.now() - startTime);
      const isSuccessful = testResult.success === true;

      let status: HostHealthStatus;
      if (!isSuccessful) {
        status = 'unreachable';
      } else if (
        latencyMs >= this.degradedLatencyThresholdMs ||
        (testResult.details && testResult.details.toLowerCase().includes('warning'))
      ) {
        status = 'degraded';
      } else {
        status = 'healthy';
      }

      const healthResult: HostHealthResult = {
        hostId,
        target: testResult.target || resolvedTarget,
        status,
        latencyMs,
        lastCheckedAt: new Date().toISOString(),
        error: testResult.error,
        details: testResult.details,
      };

      this.cache.set(hostId, healthResult);
      this.notifyUpdate(healthResult);
      return healthResult;
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = err?.message || String(err);

      const healthResult: HostHealthResult = {
        hostId,
        target: resolvedTarget,
        status: 'unreachable',
        latencyMs,
        lastCheckedAt: new Date().toISOString(),
        error: errorMessage,
      };

      this.cache.set(hostId, healthResult);
      this.notifyUpdate(healthResult);
      return healthResult;
    }
  }

  /**
   * Checks multiple hosts in parallel without blocking.
   * Offline or slow hosts timing out will not delay responsive hosts.
   */
  async checkAllHosts(
    hosts: string[] | TargetHostItem[]
  ): Promise<Record<string, HostHealthResult>> {
    const normalizedHosts: TargetHostItem[] = hosts.map((h) =>
      typeof h === 'string' ? { id: h } : h
    );

    if (normalizedHosts.length === 0) {
      return {};
    }

    this.logger.debug('Starting parallel health checks for hosts', {
      count: normalizedHosts.length,
      hostIds: normalizedHosts.map((h) => h.id),
    });

    const checkPromises = normalizedHosts.map((item) =>
      this.checkHost(item.id, item.target)
    );

    const settled = await Promise.allSettled(checkPromises);
    const resultMap: Record<string, HostHealthResult> = {};

    for (let i = 0; i < normalizedHosts.length; i++) {
      const hostId = normalizedHosts[i].id;
      const res = settled[i];
      if (res.status === 'fulfilled') {
        resultMap[hostId] = res.value;
      } else {
        resultMap[hostId] = {
          hostId,
          target: normalizedHosts[i].target || hostId,
          status: 'unreachable',
          lastCheckedAt: new Date().toISOString(),
          error: res.reason?.message || 'Check failed',
        };
      }
    }

    this.notifyAllUpdated(resultMap);
    return resultMap;
  }

  /**
   * Starts periodic parallel background checks for a dynamic list of hosts.
   */
  startPeriodicChecks(
    getHosts: () => string[] | TargetHostItem[],
    intervalMs = 30000
  ): () => void {
    this.stopPeriodicChecks();

    const run = () => {
      try {
        const hosts = getHosts();
        if (hosts && hosts.length > 0) {
          this.checkAllHosts(hosts).catch((err) => {
            this.logger.warn('Periodic host health check encountered error', { error: err });
          });
        }
      } catch (err) {
        this.logger.warn('Failed to retrieve host list for periodic health check', { error: err });
      }
    };

    // Run first check immediately in background
    run();

    this.pollIntervalTimer = setInterval(run, intervalMs);

    return () => {
      this.stopPeriodicChecks();
    };
  }

  /**
   * Stops active periodic background checks.
   */
  stopPeriodicChecks(): void {
    if (this.pollIntervalTimer) {
      clearInterval(this.pollIntervalTimer);
      this.pollIntervalTimer = null;
    }
  }
}
