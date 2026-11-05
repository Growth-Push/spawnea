import type { Algorithm } from '@node-rs/argon2';

export const ARGON2ID_PREFIX = '$argon2id$';

// Canonical PHC string for Argon2id:
// $argon2id$v=(16|19)$m=(positive int),t=(positive int),p=(positive int)$<base64salt>$<base64hash>
const ARGON2ID_REGEX =
  /^\$argon2id\$v=(?:16|19)\$m=([1-9]\d*),t=([1-9]\d*),p=([1-9]\d*)\$([A-Za-z0-9+/=_-]+)\$([A-Za-z0-9+/=_-]+)$/;

/**
 * Validates that a string starts with the canonical Argon2id prefix and has basic PHC structure.
 */
export function isValidArgon2idHash(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return ARGON2ID_REGEX.test(trimmed);
}

let argon2Module: typeof import('@node-rs/argon2') | null = null;
export async function getArgon2() {
  if (!argon2Module) {
    argon2Module = await import('@node-rs/argon2');
  }
  return argon2Module;
}

export type Argon2ConfigHashValidation =
  | { ok: true }
  | { ok: false; reason: 'missing_or_invalid_hash' | 'native_load_failure'; error?: unknown };

/**
 * Validates configured Argon2id hash format and native decodability before opening the listener.
 * Runs the native Argon2 verifier against a dummy key.
 * Distinguishes native module loading failures from malformed hashes.
 */
export async function validateArgon2idConfigHashDetailed(
  hash: unknown
): Promise<Argon2ConfigHashValidation> {
  if (typeof hash !== 'string' || !hash.startsWith(ARGON2ID_PREFIX) || !isValidArgon2idHash(hash)) {
    return { ok: false, reason: 'missing_or_invalid_hash' };
  }
  let argon2: typeof import('@node-rs/argon2');
  try {
    argon2 = await getArgon2();
  } catch (err) {
    return { ok: false, reason: 'native_load_failure', error: err };
  }
  try {
    const result = await argon2.verify(hash.trim(), 'probe-dummy-key-validation');
    return typeof result === 'boolean'
      ? { ok: true }
      : { ok: false, reason: 'missing_or_invalid_hash' };
  } catch {
    return { ok: false, reason: 'missing_or_invalid_hash' };
  }
}

/**
 * Validates configured Argon2id hash format and native decodability before opening the listener.
 */
export async function validateArgon2idConfigHash(hash: unknown): Promise<boolean> {
  const result = await validateArgon2idConfigHashDetailed(hash);
  return result.ok;
}

export const MIN_MOBILE_API_KEY_LENGTH = 32;

/**
 * Hashes a plaintext secret key using Argon2id.
 * Lazily loads @node-rs/argon2 so a disabled API never loads native binaries.
 */
export async function hashKey(key: string): Promise<string> {
  if (!key || typeof key !== 'string') {
    throw new Error('Key must be a non-empty string');
  }
  if (key.length < MIN_MOBILE_API_KEY_LENGTH) {
    throw new Error(`Key must be at least ${MIN_MOBILE_API_KEY_LENGTH} characters long`);
  }
  const { hash } = await getArgon2();
  return hash(key, {
    // Argon2id is algorithm 2 in @node-rs/argon2.
    algorithm: 2 as unknown as Algorithm,
  });
}

/**
 * Verifies a candidate key against an Argon2id hash in constant time.
 * Never throws, never logs the candidate key.
 * Lazily loads @node-rs/argon2 only when verifying.
 */
export async function verifyKey(
  configuredHash: string | undefined | null,
  candidateKey: string | undefined | null
): Promise<boolean> {
  if (!isValidArgon2idHash(configuredHash)) {
    return false;
  }
  if (!candidateKey || typeof candidateKey !== 'string' || candidateKey.length === 0) {
    return false;
  }

  try {
    const { verify } = await getArgon2();
    return await verify(configuredHash.trim(), candidateKey);
  } catch {
    return false;
  }
}

/**
 * Extracts a Bearer token from the HTTP Authorization header.
 * Case-insensitive "Bearer" prefix, trims token.
 * Parsed without regex backtracking to prevent ReDoS.
 * Returns null if header is missing, malformed, or empty.
 */
export function extractBearerToken(authHeader: string | undefined | null): string | null {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const trimmed = authHeader.trim();
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) return null;
  const scheme = trimmed.slice(0, spaceIndex);
  if (scheme.toLowerCase() !== 'bearer') return null;
  const token = trimmed.slice(spaceIndex + 1).trim();
  return token.length > 0 ? token : null;
}
