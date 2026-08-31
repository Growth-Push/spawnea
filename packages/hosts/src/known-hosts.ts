import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface KnownHostEntry {
  hosts: string[];
  key: Buffer;
}

/**
 * Creates a synchronous ssh2 host verifier using OpenSSH known_hosts entries.
 * Unknown hosts, malformed entries, and key mismatches are rejected.
 */
export function createKnownHostsVerifier(
  hostname: string,
  port: number,
  knownHostsPath = join(homedir(), '.ssh', 'known_hosts')
): (key: Buffer) => boolean {
  const entries = loadKnownHostEntries(knownHostsPath);
  const hostCandidates = [formatHost(hostname, port), hostname];

  return (key: Buffer): boolean => entries.some((entry) => {
    if (!entry.hosts.some((host) => hostCandidates.some((candidate) => matchesHost(host, candidate)))) {
      return false;
    }

    return entry.key.length === key.length && timingSafeEqual(entry.key, key);
  });
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
    if (fields[0]?.startsWith('@')) continue;
    if (fields.length < 3) continue;

    const key = decodeBase64(fields[2]);
    if (!key) continue;
    entries.push({ hosts: fields[0].split(','), key });
  }

  return entries;
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

  return pattern === candidate;
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
