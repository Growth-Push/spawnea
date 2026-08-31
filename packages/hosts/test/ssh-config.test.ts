import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSshConfigFile, resolveSshTarget } from '../src/ssh-config.js';

describe('ssh-config parser', () => {
  const sampleConfig = `
# Sample OpenSSH Config
Host example-host
  HostName 198.51.100.50
  User developer
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
  IdentityAgent ~/.1password/agent.sock

Host *.example.test
  User devops
  Port 22

Host *
  Port 22
`;

  it('parses host blocks and directives accurately', () => {
    const parsed = parseSshConfigFile(sampleConfig);
    expect(parsed['example-host']).toBeDefined();
    expect(parsed['example-host']?.hostname).toBe('198.51.100.50');
    expect(parsed['example-host']?.user).toBe('developer');
    expect(parsed['example-host']?.port).toBe(2222);
    expect(parsed['example-host']?.identityAgent).toBe(join(homedir(), '.1password', 'agent.sock'));
  });

  it('inherits a global IdentityAgent for hosts without an alias block', () => {
    const parsed = parseSshConfigFile('Host *\n  IdentityAgent ~/.1password/agent.sock\n');
    expect(parsed['*']?.identityAgent).toBe(join(homedir(), '.1password', 'agent.sock'));

    const tempDir = mkdtempSync(join(tmpdir(), 'spawnea-ssh-config-'));
    try {
      const configPath = join(tempDir, 'config');
      writeFileSync(configPath, 'Host *\n  IdentityAgent ~/.1password/agent.sock\n', 'utf8');
      expect(resolveSshTarget('server.example.test', undefined, undefined, configPath).identityAgent)
        .toBe(join(homedir(), '.1password', 'agent.sock'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves direct hostnames when no alias matches', () => {
    const resolved = resolveSshTarget('192.0.2.1', 'admin', 2200, '/nonexistent/path');
    expect(resolved.hostname).toBe('192.0.2.1');
    expect(resolved.user).toBe('admin');
    expect(resolved.port).toBe(2200);
  });
});
