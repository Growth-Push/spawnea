import { describe, it, expect } from 'vitest';
import { MockHostAdapter } from '../src/mock-host.js';

describe('MockHostAdapter', () => {
  it('connects and tests connectivity successfully', async () => {
    const host = new MockHostAdapter('test-host');
    const result = await host.testConnection();
    expect(result.success).toBe(true);
    expect(result.hostId).toBe('test-host');
  });

  it('fails connectivity test when configured to fail', async () => {
    const host = new MockHostAdapter('failing-host');
    host.shouldFailConnection = true;
    host.connectionErrorMessage = 'Host key verification failed';

    const result = await host.testConnection();
    expect(result.success).toBe(false);
    expect(result.error).toContain('Host key verification failed');
  });

  it('handles execute with built-in test -d and mkdir -p', async () => {
    const host = new MockHostAdapter('test-host');

    // Initially does not exist
    const test1 = await host.execute('test -d /workspace/project');
    expect(test1.exitCode).toBe(1);

    // Create folder
    const mkdir = await host.execute('mkdir -p /workspace/project');
    expect(mkdir.exitCode).toBe(0);

    // Now exists
    const test2 = await host.execute('test -d /workspace/project');
    expect(test2.exitCode).toBe(0);
  });
});
