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
      on: vi.fn(),
      removeListener: vi.fn(),
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
    expect(mockWebContents.send).not.toHaveBeenCalled();
    broker.ready('pty-1');
    expect(mockWebContents.send).toHaveBeenCalledWith('pty:data', 'pty-1', 'Hello agent world!');

    // 2. Simulate user keyboard input
    expect(broker.write('pty-1', 'ls -la\n')).toBe(true);
    const inputMetrics = broker.getMetrics('pty-1');
    expect(inputMetrics?.lastInputAt).toBeDefined();
    expect(mockStream.write).toHaveBeenCalledWith('ls -la\n');

    // 3. Clean up
    broker.close('pty-1');
    expect(broker.getMetrics('pty-1')).toBeUndefined();
    expect(broker.write('pty-1', 'after-close\n')).toBe(false);
    expect(mockStream.close).toHaveBeenCalled();
  });

  it('bounds in-flight buffering, pauses producer under slow renderer, and resumes on ack', () => {
    const pauseFn = vi.fn();
    const resumeFn = vi.fn();
    let dataCb: (d: string) => void = () => {};

    const mockStream: PtyStream = {
      id: 'pty-flow',
      onData: (cb) => {
        dataCb = cb;
        return () => {};
      },
      onExit: () => () => {},
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      pause: pauseFn,
      resume: resumeFn,
    };

    const mockWebContents = {
      isDestroyed: () => false,
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as WebContents;

    // Use small 100-byte high water mark and 20-byte low water mark for deterministic test
    const broker = new PtyBroker(undefined, {
      highWaterMarkBytes: 100,
      lowWaterMarkBytes: 20,
    });

    broker.registerPty('pty-flow', mockStream, mockWebContents);

    // Initial state: not paused, 0 in flight, not ready
    expect(broker.getFlowState('pty-flow')).toEqual({ inFlightBytes: 0, isPaused: false, isReady: false });

    // Mark channel ready (renderer connected and listening)
    broker.ready('pty-flow');
    expect(broker.getFlowState('pty-flow')?.isReady).toBe(true);

    // Send 60 bytes (below 100) -> not paused
    dataCb('A'.repeat(60));
    expect(broker.getFlowState('pty-flow')?.inFlightBytes).toBe(60);
    expect(broker.getFlowState('pty-flow')?.isPaused).toBe(false);
    expect(pauseFn).not.toHaveBeenCalled();

    // Send another 50 bytes (total 110 >= 100) -> pauses producer
    dataCb('B'.repeat(50));
    expect(broker.getFlowState('pty-flow')?.inFlightBytes).toBe(110);
    expect(broker.getFlowState('pty-flow')?.isPaused).toBe(true);
    expect(pauseFn).toHaveBeenCalledTimes(1);

    // Partial ACK of 50 bytes (in flight remains 60, which is > low water mark 20) -> remains paused
    broker.ack('pty-flow', 50);
    expect(broker.getFlowState('pty-flow')?.inFlightBytes).toBe(60);
    expect(broker.getFlowState('pty-flow')?.isPaused).toBe(true);
    expect(resumeFn).not.toHaveBeenCalled();

    // Acknowledge another 45 bytes (in flight drops to 15 <= 20) -> resumes producer
    broker.ack('pty-flow', 45);
    expect(broker.getFlowState('pty-flow')?.inFlightBytes).toBe(15);
    expect(broker.getFlowState('pty-flow')?.isPaused).toBe(false);
    expect(resumeFn).toHaveBeenCalledTimes(1);

    // Keyboard input remains functional even while under heavy output
    expect(broker.write('pty-flow', 'user input\n')).toBe(true);
    expect(mockStream.write).toHaveBeenCalledWith('user input\n');

    // Clean up channel
    broker.close('pty-flow');
    expect(broker.getFlowState('pty-flow')).toBeUndefined();
  });

  it('buffers output before readiness and flushes it with flow control', () => {
    const pauseFn = vi.fn();
    const resumeFn = vi.fn();
    let dataCb: (d: string) => void = () => {};

    const mockStream: PtyStream = {
      id: 'pty-race',
      onData: (cb) => {
        dataCb = cb;
        return () => {};
      },
      onExit: () => () => {},
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      pause: pauseFn,
      resume: resumeFn,
    };

    const mockWebContents = {
      isDestroyed: () => false,
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as WebContents;

    const broker = new PtyBroker(undefined, {
      highWaterMarkBytes: 50,
      lowWaterMarkBytes: 10,
    });

    broker.registerPty('pty-race', mockStream, mockWebContents);

    // Output emitted before renderer registers ready handshake (e.g. initial tmux banner/scrollback)
    dataCb('Initial tmux output burst before attachSession returns');
    expect(mockWebContents.send).not.toHaveBeenCalled();
    expect(broker.getFlowState('pty-race')).toEqual({
      inFlightBytes: 0,
      isPaused: true,
      isReady: false,
    });
    expect(pauseFn).toHaveBeenCalledTimes(1);

    // Renderer signals ready
    broker.ready('pty-race');
    expect(broker.getFlowState('pty-race')?.isReady).toBe(true);
    expect(mockWebContents.send).toHaveBeenCalledWith('pty:data', 'pty-race', 'Initial tmux output burst before attachSession returns');
    expect(broker.getFlowState('pty-race')?.inFlightBytes).toBe(54);

    // Now post-ready output is accounted for
    dataCb('X'.repeat(60));
    expect(broker.getFlowState('pty-race')?.inFlightBytes).toBe(114);
    expect(broker.getFlowState('pty-race')?.isPaused).toBe(true);
    expect(pauseFn).toHaveBeenCalledTimes(1);

    // ACK brings it down and resumes
    broker.ack('pty-race', 109);
    expect(broker.getFlowState('pty-race')?.inFlightBytes).toBe(5);
    expect(broker.getFlowState('pty-race')?.isPaused).toBe(false);
    expect(resumeFn).toHaveBeenCalledTimes(1);

    broker.close('pty-race');
  });

  it('keeps multiple channels isolated and cleans up properly on exit or destruction', () => {
    const pauseStream1 = vi.fn();
    const pauseStream2 = vi.fn();
    let dataCb1: (d: string) => void = () => {};
    let dataCb2: (d: string) => void = () => {};
    let exitCb1: (c: number) => void = () => {};

    const mockStream1: PtyStream = {
      id: 'pty-chan-1',
      onData: (cb) => {
        dataCb1 = cb;
        return () => {};
      },
      onExit: (cb) => {
        exitCb1 = cb;
        return () => {};
      },
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      pause: pauseStream1,
      resume: vi.fn(),
    };

    const mockStream2: PtyStream = {
      id: 'pty-chan-2',
      onData: (cb) => {
        dataCb2 = cb;
        return () => {};
      },
      onExit: () => () => {},
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      pause: pauseStream2,
      resume: vi.fn(),
    };

    const mockWebContents = {
      isDestroyed: () => false,
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as WebContents;

    const broker = new PtyBroker(undefined, {
      highWaterMarkBytes: 50,
      lowWaterMarkBytes: 10,
    });

    broker.registerPty('pty-chan-1', mockStream1, mockWebContents);
    broker.registerPty('pty-chan-2', mockStream2, mockWebContents);
    broker.ready('pty-chan-1');
    broker.ready('pty-chan-2');

    // Flood channel 1 to pause it
    dataCb1('X'.repeat(60));
    expect(broker.getFlowState('pty-chan-1')?.isPaused).toBe(true);
    expect(pauseStream1).toHaveBeenCalledTimes(1);

    // Channel 2 is unaffected and free to stream
    expect(broker.getFlowState('pty-chan-2')?.isPaused).toBe(false);
    expect(pauseStream2).not.toHaveBeenCalled();
    dataCb2('Y'.repeat(20));
    expect(broker.getFlowState('pty-chan-2')?.inFlightBytes).toBe(20);

    // Natural process exit on channel 1 invokes cleanup and removes channel
    exitCb1(0);
    expect(broker.getFlowState('pty-chan-1')).toBeUndefined();
    expect(mockStream1.close).toHaveBeenCalled();

    // Channel 2 is still alive and operational
    expect(broker.getFlowState('pty-chan-2')).toBeDefined();
    broker.closeAll();
    expect(broker.getFlowState('pty-chan-2')).toBeUndefined();
    expect(mockStream2.close).toHaveBeenCalled();
  });

  it('accurately accounts for multibyte UTF-8 characters and ignores invalid ack byte values', () => {
    let dataCb: (d: string) => void = () => {};
    const mockStream: PtyStream = {
      id: 'pty-utf8',
      onData: (cb) => {
        dataCb = cb;
        return () => {};
      },
      onExit: () => () => {},
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    };
    const mockWebContents = {
      isDestroyed: () => false,
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as WebContents;

    const broker = new PtyBroker(undefined, {
      highWaterMarkBytes: 100,
      lowWaterMarkBytes: 20,
    });
    broker.registerPty('pty-utf8', mockStream, mockWebContents);
    broker.ready('pty-utf8');

    // Emoji 🚀 is 2 code units in string length, but 4 bytes in UTF-8
    dataCb('🚀🚀'); // 2 emojis = 8 UTF-8 bytes
    expect(broker.getFlowState('pty-utf8')?.inFlightBytes).toBe(8);

    // Invalid ack values: negative, NaN, infinity, fractions, non-numbers
    broker.ack('pty-utf8', -10);
    expect(broker.getFlowState('pty-utf8')?.inFlightBytes).toBe(8);

    broker.ack('pty-utf8', NaN);
    expect(broker.getFlowState('pty-utf8')?.inFlightBytes).toBe(8);

    broker.ack('pty-utf8', 3.5);
    expect(broker.getFlowState('pty-utf8')?.inFlightBytes).toBe(8);

    broker.ack('pty-utf8', Infinity);
    expect(broker.getFlowState('pty-utf8')?.inFlightBytes).toBe(8);

    broker.ack('pty-utf8', '8' as any);
    expect(broker.getFlowState('pty-utf8')?.inFlightBytes).toBe(8);

    // Valid ack
    broker.ack('pty-utf8', 8);
    expect(broker.getFlowState('pty-utf8')?.inFlightBytes).toBe(0);

    broker.close('pty-utf8');
  });

  it('closes a paused channel when its renderer is destroyed', () => {
    let dataCb: (data: string) => void = () => {};
    let destroyed: () => void = () => {};
    const stream: PtyStream = {
      id: 'pty-destroyed',
      onData: (cb) => { dataCb = cb; return () => {}; },
      onExit: () => () => {},
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    };
    const webContents = {
      isDestroyed: () => false,
      send: vi.fn(),
      on: vi.fn((_event, listener) => { destroyed = listener; }),
      removeListener: vi.fn(),
    } as unknown as WebContents;
    const broker = new PtyBroker(undefined, { highWaterMarkBytes: 10 });
    broker.registerPty(stream.id, stream, webContents);
    broker.ready(stream.id);
    dataCb('X'.repeat(10));
    expect(stream.pause).toHaveBeenCalledOnce();
    destroyed();
    expect(stream.close).toHaveBeenCalledOnce();
    expect(webContents.removeListener).toHaveBeenCalledWith('destroyed', destroyed);
    expect(broker.getFlowState(stream.id)).toBeUndefined();
  });
});
