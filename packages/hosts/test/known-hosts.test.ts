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

  it('rejects revoked host keys regardless of entry order', () => {
    const keyB64 = key.toString('base64');

    // Positive entry first, then @revoked
    const pathPositiveFirst = knownHosts([
      `server.example.test ssh-ed25519 ${keyB64}`,
      `@revoked server.example.test ssh-ed25519 ${keyB64}`,
    ].join('\n'));
    expect(createKnownHostsVerifier('server.example.test', 22, pathPositiveFirst)(key)).toBe(false);

    // @revoked first, then positive entry
    const pathRevokedFirst = knownHosts([
      `@revoked server.example.test ssh-ed25519 ${keyB64}`,
      `server.example.test ssh-ed25519 ${keyB64}`,
    ].join('\n'));
    expect(createKnownHostsVerifier('server.example.test', 22, pathRevokedFirst)(key)).toBe(false);
  });

  it('enforces revocation on hashed host identities and multi-host entries', () => {
    const salt = Buffer.from('known-host-salt');
    const host = '[server.example.test]:2222';
    const hash = createHmac('sha1', salt).update(host).digest().toString('base64');
    const keyB64 = key.toString('base64');

    // Revocation via hashed host entry
    const pathHashedRevoked = knownHosts([
      `${host} ssh-ed25519 ${keyB64}`,
      `@revoked |1|${salt.toString('base64')}|${hash} ssh-ed25519 ${keyB64}`,
    ].join('\n'));
    expect(createKnownHostsVerifier('server.example.test', 2222, pathHashedRevoked)(key)).toBe(false);

    // Revocation via multi-host comma-separated entry
    const pathMultiHostRevoked = knownHosts([
      `server.example.test ssh-ed25519 ${keyB64}`,
      `@revoked other.example.test,server.example.test ssh-ed25519 ${keyB64}`,
    ].join('\n'));
    expect(createKnownHostsVerifier('server.example.test', 22, pathMultiHostRevoked)(key)).toBe(false);
  });

  it('isolates ports and prevents bare-hostname entry matching nondefault ports', () => {
    const keyA = Buffer.from('ssh-ed25519\0server-key-a');
    const keyB = Buffer.from('ssh-ed25519\0server-key-b');

    const path = knownHosts([
      `host.example.test ssh-ed25519 ${keyA.toString('base64')}`,
      `[host.example.test]:2222 ssh-ed25519 ${keyB.toString('base64')}`,
    ].join('\n'));

    // Bare hostname is valid for default port 22
    expect(createKnownHostsVerifier('host.example.test', 22, path)(keyA)).toBe(true);
    expect(createKnownHostsVerifier('host.example.test', 22, path)(keyB)).toBe(false);

    // Nondefault port 2222 requires explicit [host]:2222 entry and does NOT accept keyA
    expect(createKnownHostsVerifier('host.example.test', 2222, path)(keyA)).toBe(false);
    expect(createKnownHostsVerifier('host.example.test', 2222, path)(keyB)).toBe(true);

    // Another nondefault port 2223 does not match either
    expect(createKnownHostsVerifier('host.example.test', 2223, path)(keyA)).toBe(false);
    expect(createKnownHostsVerifier('host.example.test', 2223, path)(keyB)).toBe(false);
  });

  it('never authorizes a key using unsupported or malformed markers', () => {
    const keyB64 = key.toString('base64');
    const path = knownHosts([
      `@cert-authority server.example.test ssh-ed25519 ${keyB64}`,
      `@unknown-marker server.example.test ssh-ed25519 ${keyB64}`,
      `@revoked server.example.test`,
      `@revoked`,
    ].join('\n'));

    expect(createKnownHostsVerifier('server.example.test', 22, path)(key)).toBe(false);
  });

  it('supports wildcard patterns in revoked entries to prevent revocation bypass', () => {
    const keyB64 = key.toString('base64');

    // Global wildcard @revoked *
    const pathWildcardStar = knownHosts([
      `server.example.test ssh-ed25519 ${keyB64}`,
      `@revoked * ssh-ed25519 ${keyB64}`,
    ].join('\n'));
    expect(createKnownHostsVerifier('server.example.test', 22, pathWildcardStar)(key)).toBe(false);

    // Subdomain wildcard @revoked *.example.test
    const pathSubdomain = knownHosts([
      `server.example.test ssh-ed25519 ${keyB64}`,
      `other.other.test ssh-ed25519 ${keyB64}`,
      `@revoked *.example.test ssh-ed25519 ${keyB64}`,
    ].join('\n'));
    expect(createKnownHostsVerifier('server.example.test', 22, pathSubdomain)(key)).toBe(false);
    expect(createKnownHostsVerifier('other.other.test', 22, pathSubdomain)(key)).toBe(true);

    // Wildcard for nondefault port @revoked [*]:2222
    const pathPortWildcard = knownHosts([
      `[server.example.test]:2222 ssh-ed25519 ${keyB64}`,
      `@revoked [*]:2222 ssh-ed25519 ${keyB64}`,
    ].join('\n'));
    expect(createKnownHostsVerifier('server.example.test', 2222, pathPortWildcard)(key)).toBe(false);
    // Port 2223 is not affected by [*]:2222 revocation
    const pathPort2223 = knownHosts([
      `[server.example.test]:2223 ssh-ed25519 ${keyB64}`,
      `@revoked [*]:2222 ssh-ed25519 ${keyB64}`,
    ].join('\n'));
    expect(createKnownHostsVerifier('server.example.test', 2223, pathPort2223)(key)).toBe(true);

    // Wildcard with '?' single character match
    const pathSingleChar = knownHosts([
      `host1.example.test ssh-ed25519 ${keyB64}`,
      `host12.example.test ssh-ed25519 ${keyB64}`,
      `@revoked host?.example.test ssh-ed25519 ${keyB64}`,
    ].join('\n'));
    expect(createKnownHostsVerifier('host1.example.test', 22, pathSingleChar)(key)).toBe(false);
    expect(createKnownHostsVerifier('host12.example.test', 22, pathSingleChar)(key)).toBe(true);
  });

  it('honors negated known_hosts patterns and does not authorize excluded hosts', () => {
    const keyB64 = key.toString('base64');

    // Positive entry with wildcard and exclusion: *.example.test,!server.example.test
    const pathExcluded = knownHosts([
      `*.example.test,!server.example.test ssh-ed25519 ${keyB64}`,
    ].join('\n'));

    // Excluded server must NOT be authorized even though *.example.test matches
    expect(createKnownHostsVerifier('server.example.test', 22, pathExcluded)(key)).toBe(false);
    // Non-excluded server under the same wildcard pattern IS authorized
    expect(createKnownHostsVerifier('other.example.test', 22, pathExcluded)(key)).toBe(true);

    // Negation with port-specific endpoints: [*.example.test]:2222,![server.example.test]:2222
    const pathPortExcluded = knownHosts([
      `[*.example.test]:2222,![server.example.test]:2222 ssh-ed25519 ${keyB64}`,
    ].join('\n'));
    expect(createKnownHostsVerifier('server.example.test', 2222, pathPortExcluded)(key)).toBe(false);
    expect(createKnownHostsVerifier('other.example.test', 2222, pathPortExcluded)(key)).toBe(true);
  });
});