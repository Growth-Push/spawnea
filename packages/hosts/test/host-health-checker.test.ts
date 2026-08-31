import { describe, it, expect } from 'vitest';
import { HostHealthChecker } from '../src/host-health-checker.js';
import { MockHostAdapter } from '../src/mock-host.js';
import type { HostAdapter, HostTestResult } from '@spawnea/domain';

describe('HostHealthChecker', () => {
  it('checks health of a single healthy host', async () => {
    const hostMap = new Map<string, HostAdapter>();
    const mockLocal = new MockHostAdapter('local-host');
    hostMap.set('local-host', mockLocal);

    const checker = new HostHealthChecker({
      getHostAdapter: async (id) => {
        const host = hostMap.get(id);
        if (!host) throw new Error(`Host ${id} not found`);
        return host;
      },
      timeoutMs: 1000,
      degradedLatencyThresholdMs: 300,
    });

    const result = await checker.checkHost('local-host');
    expect(result.hostId).toBe('local-host');
    expect(result.status).toBe('healthy');
    expect(result.latencyMs).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(checker.getCachedHealth('local-host')).toEqual(result);
  });

  it('marks failing host as unreachable', async () => {
    const mockFailing = new MockHostAdapter('failing-host');
    mockFailing.shouldFailConnection = true;
    mockFailing.connectionErrorMessage = 'Connection refused';

    const checker = new HostHealthChecker({
      getHostAdapter: async () => mockFailing,
      timeoutMs: 1000,
    });

    const result = await checker.checkHost('failing-host');
    expect(result.hostId).toBe('failing-host');
    expect(result.status).toBe('unreachable');
    expect(result.error).toContain('Connection refused');
  });

  it('marks high-latency or warning hosts as degraded', async () => {
    const slowHost: HostAdapter = {
      serverId: 'slow-host',
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      testConnection: async (): Promise<HostTestResult> => {
        return {
          success: true,
          hostId: 'slow-host',
          target: 'slow.example.com',
          latencyMs: 350,
          details: 'Connected slowly',
        };
      },
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      openPty: async () => ({} as any),
      listFiles: async () => [],
      readFile: async () => ({} as any),
      stat: async () => ({} as any),
      uploadFile: async () => {},
      downloadFile: async () => {},
      writeFile: async () => {},
      mkdir: async () => {},
    };

    const checker = new HostHealthChecker({
      getHostAdapter: async () => slowHost,
      timeoutMs: 1000,
      degradedLatencyThresholdMs: 200,
    });

    const result = await checker.checkHost('slow-host');
    expect(result.status).toBe('degraded');
    expect(result.latencyMs).toBe(350);
  });

  it('checks multiple hosts concurrently in parallel without blocking', async () => {
    const fastHost = new MockHostAdapter('fast-host');
    
    // Slow host takes 150ms
    const slowHost: HostAdapter = {
      serverId: 'slow-host',
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      testConnection: async () => {
        await new Promise((r) => setTimeout(r, 150));
        return {
          success: true,
          hostId: 'slow-host',
          target: 'slow.example.test',
          latencyMs: 150,
        };
      },
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      openPty: async () => ({} as any),
      listFiles: async () => [],
      readFile: async () => ({} as any),
      stat: async () => ({} as any),
      uploadFile: async () => {},
      downloadFile: async () => {},
      writeFile: async () => {},
      mkdir: async () => {},
    };

    const hostMap: Record<string, HostAdapter> = {
      'fast-host': fastHost,
      'slow-host': slowHost,
    };

    const checker = new HostHealthChecker({
      getHostAdapter: async (id) => hostMap[id],
      timeoutMs: 1000,
    });

    const start = Date.now();
    const results = await checker.checkAllHosts(['fast-host', 'slow-host']);
    const elapsed = Date.now() - start;

    expect(results['fast-host']).toBeDefined();
    expect(results['fast-host'].status).toBe('healthy');
    expect(results['slow-host']).toBeDefined();
    expect(results['slow-host'].status).toBe('healthy');

    // Both ran concurrently, total duration shouldn't be sequential (approx ~150ms, well below 500ms)
    expect(elapsed).toBeLessThan(400);
  });

  it('times out hanging hosts without delaying responsive hosts', async () => {
    const responsiveHost = new MockHostAdapter('responsive-host');

    // Hanging host hangs indefinitely (simulated timeout)
    const hangingHost: HostAdapter = {
      serverId: 'hanging-host',
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => false,
      testConnection: async () => {
        await new Promise((r) => setTimeout(r, 2000));
        return {
          success: true,
          hostId: 'hanging-host',
          target: 'hanging.example.test',
        };
      },
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      openPty: async () => ({} as any),
      listFiles: async () => [],
      readFile: async () => ({} as any),
      stat: async () => ({} as any),
      uploadFile: async () => {},
      downloadFile: async () => {},
      writeFile: async () => {},
      mkdir: async () => {},
    };

    const hostMap: Record<string, HostAdapter> = {
      'responsive-host': responsiveHost,
      'hanging-host': hangingHost,
    };

    // Low timeout of 80ms for test
    const checker = new HostHealthChecker({
      getHostAdapter: async (id) => hostMap[id],
      timeoutMs: 80,
    });

    const start = Date.now();
    const results = await checker.checkAllHosts(['responsive-host', 'hanging-host']);
    const elapsed = Date.now() - start;

    expect(results['responsive-host'].status).toBe('healthy');
    expect(results['hanging-host'].status).toBe('unreachable');
    expect(results['hanging-host'].error).toContain('timed out');
    expect(elapsed).toBeLessThan(300);
  });

  it('deduplicates simultaneous in-flight checks for the same host', async () => {
    let callCount = 0;
    const testHost: HostAdapter = {
      serverId: 'test-host',
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      testConnection: async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 50));
        return {
          success: true,
          hostId: 'test-host',
          target: 'test.example.test',
          latencyMs: 50,
        };
      },
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      openPty: async () => ({} as any),
      listFiles: async () => [],
      readFile: async () => ({} as any),
      stat: async () => ({} as any),
      uploadFile: async () => {},
      downloadFile: async () => {},
      writeFile: async () => {},
      mkdir: async () => {},
    };

    const checker = new HostHealthChecker({
      getHostAdapter: async () => testHost,
      timeoutMs: 1000,
    });

    const [res1, res2] = await Promise.all([
      checker.checkHost('test-host'),
      checker.checkHost('test-host'),
    ]);

    expect(res1).toEqual(res2);
    expect(callCount).toBe(1);
  });

  it('emits onHealthUpdated and onAllUpdated events', async () => {
    const mockHost = new MockHostAdapter('event-host');
    const checker = new HostHealthChecker({
      getHostAdapter: async () => mockHost,
      timeoutMs: 1000,
    });

    const singleUpdates: any[] = [];
    const allUpdates: any[] = [];

    const unsub1 = checker.onHealthUpdated((h) => singleUpdates.push(h));
    const unsub2 = checker.onAllUpdated((all) => allUpdates.push(all));

    await checker.checkAllHosts(['event-host']);

    expect(singleUpdates.length).toBe(1);
    expect(singleUpdates[0].hostId).toBe('event-host');
    expect(allUpdates.length).toBe(1);
    expect(allUpdates[0]['event-host']).toBeDefined();

    unsub1();
    unsub2();
  });
});
