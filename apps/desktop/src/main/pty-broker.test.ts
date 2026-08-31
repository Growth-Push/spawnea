import { describe, it, expect, vi } from 'vitest';
import { PtyBroker } from './pty-broker.js';
import type { PtyStream } from '@spawnea/domain';
import type { WebContents } from 'electron';

describe('PtyBroker', () => {
  it('tracks lastOutputAt, lastInputAt, and recentOutputBytes accurately', () => {
    const broker = new PtyBroker();

    let dataCb: (d: string) => void = () => {};
    let _exitCb: (c: number) => void = () => {};

    const mockStream: PtyStream = {
      id: 'pty-1',
      onData: (cb) => {
        dataCb = cb;
        return () => {};
      },
      onExit: (cb) => {
        _exitCb = cb;
        return () => {};
      },
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
    };

    const mockWebContents = {
      isDestroyed: () => false,
      send: vi.fn(),
    } as unknown as WebContents;

    broker.registerPty('pty-1', mockStream, mockWebContents);

    const initialMetrics = broker.getMetrics('pty-1');
    expect(initialMetrics).toBeDefined();
    expect(initialMetrics?.recentOutputBytes).toBe(0);
    expect(initialMetrics?.lastOutputAt).toBeUndefined();
    expect(initialMetrics?.lastInputAt).toBeUndefined();

    // 1. Simulate output
    dataCb('Hello agent world!');
    const outputMetrics = broker.getMetrics('pty-1');
    expect(outputMetrics?.recentOutputBytes).toBe('Hello agent world!'.length);
    expect(outputMetrics?.lastOutputAt).toBeDefined();
    expect(mockWebContents.send).toHaveBeenCalledWith('pty:data', 'pty-1', 'Hello agent world!');

    // 2. Simulate user keyboard input
    broker.write('pty-1', 'ls -la\n');
    const inputMetrics = broker.getMetrics('pty-1');
    expect(inputMetrics?.lastInputAt).toBeDefined();
    expect(mockStream.write).toHaveBeenCalledWith('ls -la\n');

    // 3. Clean up
    broker.close('pty-1');
    expect(broker.getMetrics('pty-1')).toBeUndefined();
    expect(mockStream.close).toHaveBeenCalled();
  });
});
