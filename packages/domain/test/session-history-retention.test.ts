import { describe, expect, it } from 'vitest';
import {
  MAX_AGGREGATE_HISTORY_PAYLOAD_BYTES,
  MAX_PERSISTED_TURN_OUTPUT_BYTES,
  MAX_PERSISTED_TURN_PROMPT_BYTES,
  MAX_PERSISTED_TURNS_GLOBAL,
  MAX_PERSISTED_TURNS_PER_SESSION,
  MAX_SNAPSHOT_HISTORY_ITEMS,
  MAX_SNAPSHOT_OUTPUT_BYTES,
  MAX_TURN_REQUESTS_PER_SESSION,
  SESSION_HISTORY_RETENTION_DAYS,
  SESSION_HISTORY_RETENTION_MS,
  truncateUtf8Head,
  truncateUtf8Tail,
  utf8ByteLength,
} from '../src/session-history-retention.js';

describe('session history retention helpers', () => {
  it('defines the approved retention defaults', () => {
    expect(SESSION_HISTORY_RETENTION_DAYS).toBe(7);
    expect(SESSION_HISTORY_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(MAX_PERSISTED_TURNS_PER_SESSION).toBe(200);
    expect(MAX_PERSISTED_TURNS_GLOBAL).toBe(1_000);
    expect(MAX_SNAPSHOT_OUTPUT_BYTES).toBe(65_536);
    expect(MAX_PERSISTED_TURN_OUTPUT_BYTES).toBe(262_144);
    expect(MAX_AGGREGATE_HISTORY_PAYLOAD_BYTES).toBe(33_554_432);
    expect(MAX_SNAPSHOT_HISTORY_ITEMS).toBe(50);
    expect(MAX_PERSISTED_TURN_PROMPT_BYTES).toBe(32_768);
    expect(MAX_TURN_REQUESTS_PER_SESSION).toBe(50);
  });

  it('truncates UTF-8 tails on valid codepoint boundaries without U+FFFD replacement characters', () => {
    // 4-byte emoji (🚀) + 3-byte CJK (漢) + ASCII
    const text = 'abc🚀漢xyz🚀end';
    for (let maxBytes = 0; maxBytes <= utf8ByteLength(text) + 2; maxBytes++) {
      const result = truncateUtf8Tail(text, maxBytes);
      expect(result.text.includes('\uFFFD')).toBe(false);
      expect(utf8ByteLength(result.text)).toBe(result.byteLength);
      expect(result.byteLength).toBeLessThanOrEqual(Math.max(0, maxBytes));
      expect(text.endsWith(result.text)).toBe(true);
      expect(result.truncated).toBe(result.byteLength < utf8ByteLength(text));
    }
  });

  it('truncates UTF-8 heads on valid codepoint boundaries without U+FFFD replacement characters', () => {
    const text = 'start🚀漢middle🚀end';
    for (let maxBytes = 0; maxBytes <= utf8ByteLength(text) + 2; maxBytes++) {
      const result = truncateUtf8Head(text, maxBytes);
      expect(result.text.includes('\uFFFD')).toBe(false);
      expect(utf8ByteLength(result.text)).toBe(result.byteLength);
      expect(result.byteLength).toBeLessThanOrEqual(Math.max(0, maxBytes));
      expect(text.startsWith(result.text)).toBe(true);
      expect(result.truncated).toBe(result.byteLength < utf8ByteLength(text));
    }
  });
});
