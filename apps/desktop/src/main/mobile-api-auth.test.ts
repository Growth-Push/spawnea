import { describe, it, expect } from 'vitest';
import {
  hashKey,
  verifyKey,
  isValidArgon2idHash,
  validateArgon2idConfigHash,
  extractBearerToken,
  ARGON2ID_PREFIX,
} from './mobile-api-auth.js';

describe('mobile-api-auth', () => {
  it('hashes a secret key with Argon2id and verifies it successfully', async () => {
    const secret = 'super-secret-mobile-key-32-chars-long';
    const hash = await hashKey(secret);

    expect(hash.startsWith(ARGON2ID_PREFIX)).toBe(true);
    expect(isValidArgon2idHash(hash)).toBe(true);

    const matches = await verifyKey(hash, secret);
    expect(matches).toBe(true);

    const wrongMatches = await verifyKey(hash, 'wrong-password-32-chars-long-here');
    expect(wrongMatches).toBe(false);
  });

  it('rejects empty, non-string, or too short keys in hashKey', async () => {
    await expect(hashKey('')).rejects.toThrow('Key must be a non-empty string');
    await expect(hashKey(null as any)).rejects.toThrow('Key must be a non-empty string');
    await expect(hashKey('too-short-secret-key')).rejects.toThrow('Key must be at least 32 characters long');
  });

  it('validates canonical Argon2id hash format and rejects invalid formats', () => {
    expect(isValidArgon2idHash('$argon2id$v=19$m=19456,t=2,p=1$sampleSalt123$sampleHash456')).toBe(true);
    expect(isValidArgon2idHash('$argon2id$v=16$m=19456,t=2,p=1$sampleSalt123$sampleHash456')).toBe(true);
    expect(isValidArgon2idHash('$argon2id$v=garbage$m=nope,t=bad,p=x$someSalt$someHash')).toBe(false);
    expect(isValidArgon2idHash('$argon2id$v=19$m=0,t=2,p=1$sampleSalt123$sampleHash456')).toBe(false);
    expect(isValidArgon2idHash('$argon2id$v=19$m=19456,t=0,p=1$sampleSalt123$sampleHash456')).toBe(false);
    expect(isValidArgon2idHash('$argon2id$v=19$m=19456,t=2,p=0$sampleSalt123$sampleHash456')).toBe(false);
    expect(isValidArgon2idHash('$argon2id$v=99$m=19456,t=2,p=1$sampleSalt123$sampleHash456')).toBe(false);
    expect(isValidArgon2idHash('$argon2i$v=19$m=19456,t=2,p=1$sampleSalt123$sampleHash456')).toBe(false);
    expect(isValidArgon2idHash('$argon2d$v=19$m=19456,t=2,p=1$sampleSalt123$sampleHash456')).toBe(false);
    expect(isValidArgon2idHash('plaintext-secret')).toBe(false);
    expect(isValidArgon2idHash('')).toBe(false);
    expect(isValidArgon2idHash(null)).toBe(false);
    expect(isValidArgon2idHash(undefined)).toBe(false);
    expect(isValidArgon2idHash('$argon2id$invalid')).toBe(false);
  });

  it('runs native verifier probe in validateArgon2idConfigHash and rejects malformed hashes like $argon2id$v=19$m=19456,t=2,p=1$a$a', async () => {
    const validHash = await hashKey('test-secret-probe-32-chars-long-minimum');
    expect(await validateArgon2idConfigHash(validHash)).toBe(true);

    // Native verifier throws Decoding failed on invalid salt/digest length
    expect(await validateArgon2idConfigHash('$argon2id$v=19$m=19456,t=2,p=1$a$a')).toBe(false);
    expect(await validateArgon2idConfigHash('$argon2id$v=garbage$m=nope,t=bad,p=x$someSalt$someHash')).toBe(false);
    expect(await validateArgon2idConfigHash('')).toBe(false);
    expect(await validateArgon2idConfigHash(null)).toBe(false);
    expect(await validateArgon2idConfigHash('invalid')).toBe(false);
  });

  it('gracefully returns false for invalid hash or key in verifyKey without throwing', async () => {
    expect(await verifyKey(undefined, 'secret')).toBe(false);
    expect(await verifyKey('', 'secret')).toBe(false);
    expect(await verifyKey('invalid-hash', 'secret')).toBe(false);
    expect(await verifyKey('$argon2id$v=19$m=19456,t=2,p=1$invalid$hash', '')).toBe(false);
    expect(await verifyKey('$argon2id$v=19$m=19456,t=2,p=1$invalid$hash', null as any)).toBe(false);
  });

  it('extracts bearer token from authorization header correctly', () => {
    expect(extractBearerToken('Bearer my-secret-token')).toBe('my-secret-token');
    expect(extractBearerToken('bearer my-secret-token')).toBe('my-secret-token');
    expect(extractBearerToken('BEARER my-secret-token')).toBe('my-secret-token');
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBe(null);
    expect(extractBearerToken('Bearer ')).toBe(null);
    expect(extractBearerToken('')).toBe(null);
    expect(extractBearerToken(undefined)).toBe(null);
    expect(extractBearerToken(null)).toBe(null);
    expect(extractBearerToken('InvalidTokenWithoutPrefix')).toBe(null);
  });
});
