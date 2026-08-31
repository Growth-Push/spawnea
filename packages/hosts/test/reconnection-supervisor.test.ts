import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HostReconnectionSupervisor } from '../src/reconnection-supervisor.js';
import type { HostConnectionState } from '@spawnea/domain';

describe('HostReconnectionSupervisor', () => {
  let supervisor: HostReconnectionSupervisor;

  beforeEach(() => {
    vi.useFakeTimers();
    supervisor = new HostReconnectionSupervisor({
      backoffScheduleMs: [1000, 2000, 5000, 10000, 30000],
      maxAttempts: 5,
    });
  });

  afterEach(() => {
    supervisor.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('calculates correct exponential backoff delays', () => {
    expect(supervisor.getBackoffDelay(1)).toBe(1000);
    expect(supervisor.getBackoffDelay(2)).toBe(2000);
    expect(supervisor.getBackoffDelay(3)).toBe(5000);
    expect(supervisor.getBackoffDelay(4)).toBe(10000);
    expect(supervisor.getBackoffDelay(5)).toBe(30000);
    expect(supervisor.getBackoffDelay(6)).toBe(30000);
  });

  it('initializes host state as connected by default', () => {
    const state = supervisor.getState('srv-1');
    expect(state.serverId).toBe('srv-1');
    expect(state.status).toBe('connected');
    expect(state.attempt).toBe(0);
    expect(state.maxAttempts).toBe(5);
  });

  it('handles connection drop and transitions through reconnecting attempts', async () => {
    const events: HostConnectionState[] = [];
    supervisor.onStateChange((s) => {
      events.push(s);
    });

    let attemptCount = 0;
    const mockReconnect = vi.fn(async () => {
      attemptCount++;
      if (attemptCount < 3) {
        throw new Error('Connection refused');
      }
      return true;
    });

    supervisor.handleConnectionDrop('srv-1', 'SSH transport closed', mockReconnect);

    // Initial drop notification: attempt 1, 1000ms delay
    expect(events.length).toBe(1);
    expect(events[0].status).toBe('reconnecting');
    expect(events[0].attempt).toBe(1);
    expect(events[0].nextRetryDelayMs).toBe(1000);

    // Advance 1s -> attempt 1 fails, schedules attempt 2 with 2000ms delay
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockReconnect).toHaveBeenCalledTimes(1);
    expect(events[events.length - 1].status).toBe('reconnecting');
    expect(events[events.length - 1].attempt).toBe(2);
    expect(events[events.length - 1].nextRetryDelayMs).toBe(2000);

    // Advance 2s -> attempt 2 fails, schedules attempt 3 with 5000ms delay
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockReconnect).toHaveBeenCalledTimes(2);
    expect(events[events.length - 1].status).toBe('reconnecting');
    expect(events[events.length - 1].attempt).toBe(3);
    expect(events[events.length - 1].nextRetryDelayMs).toBe(5000);

    // Advance 5s -> attempt 3 succeeds! Transitions to connected
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockReconnect).toHaveBeenCalledTimes(3);
    expect(events[events.length - 1].status).toBe('connected');
    expect(events[events.length - 1].attempt).toBe(0);
    expect(supervisor.getState('srv-1').status).toBe('connected');
  });

  it('transitions to disconnected when maximum attempts are exhausted', async () => {
    const events: HostConnectionState[] = [];
    supervisor.onStateChange((s) => {
      events.push(s);
    });

    const mockReconnect = vi.fn(async () => {
      throw new Error('Network unreachable');
    });

    supervisor.handleConnectionDrop('srv-1', 'Socket reset by peer', mockReconnect);

    // Advance through 1s (att 1), 2s (att 2), 5s (att 3), 10s (att 4), 30s (att 5)
    await vi.advanceTimersByTimeAsync(1000); // after attempt 1
    await vi.advanceTimersByTimeAsync(2000); // after attempt 2
    await vi.advanceTimersByTimeAsync(5000); // after attempt 3
    await vi.advanceTimersByTimeAsync(10000); // after attempt 4
    await vi.advanceTimersByTimeAsync(30000); // after attempt 5

    expect(mockReconnect).toHaveBeenCalledTimes(5);
    const finalState = supervisor.getState('srv-1');
    expect(finalState.status).toBe('disconnected');
    expect(finalState.attempt).toBe(5);
    expect(finalState.error).toContain('Stopped after 5 attempts');
  });

  it('supports immediate manual retry (retryNow) canceling scheduled timer', async () => {
    const events: HostConnectionState[] = [];
    supervisor.onStateChange((s) => {
      events.push(s);
    });

    let canConnect = false;
    const mockReconnect = vi.fn(async () => {
      if (!canConnect) throw new Error('Host unavailable');
      return true;
    });

    supervisor.handleConnectionDrop('srv-1', 'WiFi disconnected', mockReconnect);

    // Advance 500ms (timer is still waiting for 1000ms)
    await vi.advanceTimersByTimeAsync(500);
    expect(mockReconnect).toHaveBeenCalledTimes(0);

    // Operator clicks "Retry Now"
    canConnect = true;
    const resPromise = supervisor.retryNow('srv-1', mockReconnect);
    const res = await resPromise;

    expect(res).toBe(true);
    expect(mockReconnect).toHaveBeenCalledTimes(1);
    expect(supervisor.getState('srv-1').status).toBe('connected');
  });
});
