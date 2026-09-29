import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'ssh2';
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

  it('does not use IdentityAgent for automatic health probes when agent auth is disabled', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spawnea-ssh-health-'));
    const configPath = join(tempDir, 'ssh_config');
    writeFileSync(configPath, 'Host health-probe\n  HostName health-probe.example.test\n  IdentityAgent /tmp/onepassword-agent.sock\n');
    let capturedConfig: import('ssh2').ConnectConfig | undefined;
    const connect = vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client, config) {
      capturedConfig = config;
      queueMicrotask(() => this.emit('ready'));
      return this;
    });
    const end = vi.spyOn(Client.prototype, 'end').mockImplementation(function (this: Client) {
      this.emit('close');
      return this;
    });
    const adapter = new SSHHostAdapter({
      serverId: 'health-probe',
      target: 'health-probe',
      configPath,
    });

    try {
      await adapter.connect({ allowAgentAuth: false });
      expect(capturedConfig).not.toHaveProperty('agent');
      await adapter.disconnect();
    } finally {
      connect.mockRestore();
      end.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('waits for manual retry after 1Password SSH agent authentication is declined', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spawnea-ssh-auth-'));
    const configPath = join(tempDir, 'ssh_config');
    writeFileSync(configPath, 'Host secure-host\n  HostName secure.example.test\n  IdentityAgent /tmp/1password-agent.sock\n');
    const connect = vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client) {
      queueMicrotask(() => this.emit('error', new Error('All configured authentication methods failed')));
      return this;
    });
    const adapter = new SSHHostAdapter({ serverId: 'secure-host', target: 'secure-host', configPath });

    try {
      await expect(adapter.connect()).rejects.toThrow('1Password SSH authentication failed');
      await expect(adapter.connect()).rejects.toThrow('1Password SSH authentication failed');
      expect(connect).toHaveBeenCalledTimes(1);
      expect(adapter.getConnectionState().status).toBe('disconnected');

      expect(await adapter.retryNow()).toBe(false);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(adapter.getConnectionState().status).toBe('disconnected');
    } finally {
      connect.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not retry an authentication failure when the agent socket has an arbitrary name', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spawnea-ssh-auth-'));
    const configPath = join(tempDir, 'ssh_config');
    writeFileSync(configPath, 'Host secure-host\n  HostName secure.example.test\n  IdentityAgent /tmp/custom-agent.sock\n');
    const connect = vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client) {
      queueMicrotask(() => this.emit('error', new Error('All configured authentication methods failed')));
      return this;
    });
    const adapter = new SSHHostAdapter({ serverId: 'secure-host', target: 'secure-host', configPath });

    try {
      await expect(adapter.connect()).rejects.toThrow('SSH authentication failed');
      await expect(adapter.connect()).rejects.toThrow('SSH authentication failed');
      expect(connect).toHaveBeenCalledTimes(1);
      expect(adapter.getConnectionState().status).toBe('disconnected');
      expect(await adapter.retryNow()).toBe(false);
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      connect.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('allows a fresh connection after explicit session creation clears authentication failure', async () => {
    const connect = vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client) {
      queueMicrotask(() => this.emit('error', new Error('All configured authentication methods failed')));
      return this;
    });
    const adapter = new SSHHostAdapter({ serverId: 'secure-host', target: 'secure.example.test' });
    try {
      await expect(adapter.connect()).rejects.toThrow('SSH authentication failed');
      await expect(adapter.connect()).rejects.toThrow('SSH authentication failed');
      expect(connect).toHaveBeenCalledTimes(1);
      adapter.allowManualAuthenticationRetry();
      await expect(adapter.connect()).rejects.toThrow('SSH authentication failed');
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      connect.mockRestore();
    }
  });
});
