import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnownHostsVerifier } from '../src/known-hosts.js';

describe('known_hosts verification', () => {
  const tempDirs: string[] = [];
  const key = Buffer.from('ssh-ed25519\0server-key');

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function knownHosts(content: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'spawnea-known-hosts-'));
    tempDirs.push(directory);
    const path = join(directory, 'known_hosts');
    writeFileSync(path, content, 'utf8');
    return path;
  }

  it('accepts an exact known host and matching key', () => {
    const verifier = createKnownHostsVerifier('server.example.test', 22, knownHosts(
      `server.example.test ssh-ed25519 ${key.toString('base64')} comment\n`,
    ));

    expect(verifier(key)).toBe(true);
    expect(verifier(Buffer.from('different-key'))).toBe(false);
  });

  it('rejects unknown hosts, changed keys, missing files, and malformed entries', () => {
    const path = knownHosts([
      `other.example.test ssh-ed25519 ${key.toString('base64')}`,
      'server.example.test ssh-ed25519 not-base64',
      'malformed-entry',
    ].join('\n'));

    expect(createKnownHostsVerifier('server.example.test', 22, path)(key)).toBe(false);
    expect(createKnownHostsVerifier('unknown.example.test', 22, path)(key)).toBe(false);
    expect(createKnownHostsVerifier('server.example.test', 22, join(tmpdir(), 'does-not-exist'))(key)).toBe(false);
  });

  it('supports non-default ports and hashed host names', () => {
    const salt = Buffer.from('known-host-salt');
    const host = '[server.example.test]:2222';
    const hash = createHmac('sha1', salt).update(host).digest().toString('base64');
    const path = knownHosts([
      `${host} ssh-ed25519 ${key.toString('base64')}`,
      `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${key.toString('base64')}`,
    ].join('\n'));

    expect(createKnownHostsVerifier('server.example.test', 2222, path)(key)).toBe(true);
    expect(createKnownHostsVerifier('server.example.test', 2223, path)(key)).toBe(false);
  });
});