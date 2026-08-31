import { describe, it, expect } from 'vitest';
import { LocalHostAdapter } from '../src/local-host.js';

describe('LocalHostAdapter', () => {
  const adapter = new LocalHostAdapter({ serverId: 'local' });

  it('tests local connection successfully', async () => {
    const result = await adapter.testConnection();
    expect(result.success).toBe(true);
    expect(result.hostId).toBe('local');
    expect(result.target).toBe('localhost');
  });

  it('executes a command locally and returns output', async () => {
    const result = await adapter.execute('echo "hello from localhost"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello from localhost');
  });

  it('opens a local PTY stream and receives data', async () => {
    const ptyStream = await adapter.openPty('echo "pty-test-output"', { cols: 80, rows: 24 });

    const receivedData = await new Promise<string>((resolve) => {
      let buf = '';
      ptyStream.onData((d) => {
        buf += d;
      });
      ptyStream.onExit(() => {
        resolve(buf);
      });
    });

    expect(receivedData).toContain('pty-test-output');
    ptyStream.close();
  });
});
