import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalHostAdapter } from '../src/local-host.js';

describe('LocalHostAdapter', () => {
  const adapter = new LocalHostAdapter({ serverId: 'local' });
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

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

  it('honors an explicit small image read limit while preserving the larger browser default', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'spawnea-local-host-'));
    const imagePath = join(tempDir, 'image.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await adapter.readFile(imagePath, 1);

    expect(Buffer.from(result.content.split('base64,')[1], 'base64')).toHaveLength(1);
    expect(result.isTruncated).toBe(true);
  });
});
