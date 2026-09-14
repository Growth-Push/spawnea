import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SSHHostAdapter } from '../src/ssh-host.js';

class FakeCommandStream extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly close = vi.fn();
}

describe('SSHHostAdapter execution', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes a timed-out command channel and releases its timer and listeners', async () => {
    vi.useFakeTimers();
    const stream = new FakeCommandStream();
    const exec = vi.fn((
      _command: string,
      _options: unknown,
      callback: (error: Error | undefined, channel: FakeCommandStream) => void
    ) => callback(undefined, stream));
    const adapter = new SSHHostAdapter({
      serverId: 'ssh-timeout-test',
      target: 'ssh-timeout.example.test',
    });
    (adapter as unknown as { client: unknown }).client = { exec };
    (adapter as unknown as { connected: boolean }).connected = true;

    const execution = adapter.execute('sleep forever', { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(0);

    expect(stream.listenerCount('data')).toBe(1);
    expect(stream.stderr.listenerCount('data')).toBe(1);
    expect(stream.listenerCount('close')).toBe(1);
    expect(stream.listenerCount('error')).toBe(1);

    const rejection = expect(execution).rejects.toThrow('Command timed out after 100ms');
    await vi.advanceTimersByTimeAsync(100);
    await rejection;

    expect(stream.close).toHaveBeenCalledTimes(1);
    expect(stream.listenerCount('data')).toBe(0);
    expect(stream.stderr.listenerCount('data')).toBe(0);
    expect(stream.listenerCount('close')).toBe(1);
    expect(stream.listenerCount('error')).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    expect(() => stream.emit('error', new Error('late cancellation error'))).not.toThrow();
    stream.emit('close', 0);
    expect(stream.listenerCount('close')).toBe(0);
    expect(stream.listenerCount('error')).toBe(0);
    expect(stream.close).toHaveBeenCalledTimes(1);
  });
});
