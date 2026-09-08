import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface KnownHostEntry {
  marker?: string;
  hosts: string[];
  key: Buffer;
}

/**
 * Creates a synchronous ssh2 host verifier using OpenSSH known_hosts entries.
 * Unknown hosts, malformed entries, revoked keys, and key mismatches are rejected.
 * Revocation takes precedence over positive entries regardless of entry order.
 */
export function createKnownHostsVerifier(
  hostname: string,
  port: number,
  knownHostsPath = join(homedir(), '.ssh', 'known_hosts')
): (key: Buffer) => boolean {
  const entries = loadKnownHostEntries(knownHostsPath);
  const targetHost = formatHost(hostname, port);

  return (key: Buffer): boolean => {
    let hasMatchingPositive = false;

    for (const entry of entries) {
      if (!keysEqual(entry.key, key)) {
        continue;
      }

      if (!matchesHostList(entry.hosts, targetHost)) {
        continue;
      }

      if (entry.marker === '@revoked') {
        return false;
      }

      if (!entry.marker) {
        hasMatchingPositive = true;
      }
    }

    return hasMatchingPositive;
  };
}

function loadKnownHostEntries(path: string): KnownHostEntry[] {
  if (!existsSync(path)) return [];

  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  const entries: KnownHostEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const fields = trimmed.split(/\s+/);
    let marker: string | undefined;
    let hostField: string;
    let keyField: string | undefined;

    if (fields[0]?.startsWith('@')) {
      marker = fields[0];
      if (marker !== '@revoked') {
        // Unknown or unsupported marker (e.g. @cert-authority).
        // Must fail-closed and never authorize a key.
        continue;
      }
      if (fields.length < 4) continue;
      hostField = fields[1];
      keyField = fields[3];
    } else {
      if (fields.length < 3) continue;
      hostField = fields[0];
      keyField = fields[2];
    }

    const key = decodeBase64(keyField);
    if (!key) continue;

    entries.push({
      marker,
      hosts: hostField.split(','),
      key,
    });
  }

  return entries;
}

function keysEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function matchesHostList(hosts: string[], candidate: string): boolean {
  let matchedPositive = false;

  for (const hostPattern of hosts) {
    const isNegated = hostPattern.startsWith('!');
    const rawPattern = isNegated ? hostPattern.slice(1) : hostPattern;

    if (matchesHost(rawPattern, candidate)) {
      if (isNegated) {
        return false;
      }
      matchedPositive = true;
    }
  }

  return matchedPositive;
}

function matchesHost(pattern: string, candidate: string): boolean {
  if (pattern.startsWith('|1|')) {
    const [, version, saltText, hashText] = pattern.split('|');
    if (version !== '1' || !saltText || !hashText) return false;

    const salt = decodeBase64(saltText);
    const expected = decodeBase64(hashText);
    if (!salt || !expected) return false;

    const actual = createHmac('sha1', salt).update(candidate).digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  if (pattern.includes('*') || pattern.includes('?')) {
    return matchWildcard(pattern, candidate);
  }

  return pattern === candidate;
}

function matchWildcard(pattern: string, text: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexPattern = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  return new RegExp(regexPattern).test(text);
}


function formatHost(hostname: string, port: number): string {
  if (port === 22) return hostname;
  return `[${hostname}]:${port}`;
}

function decodeBase64(value: string | undefined): Buffer | null {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length > 0 && decoded.toString('base64') === value ? decoded : null;
  } catch {
    return null;
  }
}

