const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Seven-day retention window for persisted session snapshots, turns, and request metadata. */
export const SESSION_HISTORY_RETENTION_DAYS = 7;
export const SESSION_HISTORY_RETENTION_MS = SESSION_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Maximum persisted control turns retained per session. */
export const MAX_PERSISTED_TURNS_PER_SESSION = 200;

/** Maximum persisted control turns retained globally across all sessions. */
export const MAX_PERSISTED_TURNS_GLOBAL = 1_000;

/** Maximum UTF-8 bytes retained for a session's latest terminal output snapshot (64 KiB). */
export const MAX_SNAPSHOT_OUTPUT_BYTES = 65_536;

/** Maximum UTF-8 bytes retained for a single control turn's captured output (256 KiB). */
export const MAX_PERSISTED_TURN_OUTPUT_BYTES = 262_144;

/** Maximum aggregate serialized payload bytes across all persisted session history records (32 MiB). */
export const MAX_AGGREGATE_HISTORY_PAYLOAD_BYTES = 33_554_432;

/** Maximum parsed screen history items kept inside a single latest session snapshot observation. */
export const MAX_SNAPSHOT_HISTORY_ITEMS = 50;

/** Maximum UTF-8 bytes retained for a persisted turn prompt. */
export const MAX_PERSISTED_TURN_PROMPT_BYTES = 32_768;

/**
 * Maximum request metadata entries retained per session.
 * Kept lower than turn retention as a bounded reversible metadata detail inside the 32 MiB budget.
 */
export const MAX_TURN_REQUESTS_PER_SESSION = 50;

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).length;
}

/**
 * Retains the trailing UTF-8 bytes up to `maxBytes`, advancing past any partial
 * leading multi-byte continuation bytes so valid UTF-8 codepoint boundaries are preserved.
 */
export function truncateUtf8Tail(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean; byteLength: number; droppedBytes: number } {
  const bytes = utf8Encoder.encode(value);
  if (maxBytes <= 0) {
    return {
      text: '',
      truncated: bytes.length > 0,
      byteLength: 0,
      droppedBytes: bytes.length,
    };
  }
  if (bytes.length <= maxBytes) {
    return {
      text: value,
      truncated: false,
      byteLength: bytes.length,
      droppedBytes: 0,
    };
  }

  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  const sliced = bytes.subarray(start);
  return {
    text: utf8Decoder.decode(sliced),
    truncated: true,
    byteLength: sliced.length,
    droppedBytes: start,
  };
}

/**
 * Retains the leading UTF-8 bytes up to `maxBytes`, backing up before any split
 * multi-byte sequence so valid UTF-8 codepoint boundaries are preserved.
 */
export function truncateUtf8Head(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean; byteLength: number } {
  const bytes = utf8Encoder.encode(value);
  if (maxBytes <= 0) {
    return {
      text: '',
      truncated: bytes.length > 0,
      byteLength: 0,
    };
  }
  if (bytes.length <= maxBytes) {
    return {
      text: value,
      truncated: false,
      byteLength: bytes.length,
    };
  }

  let end = maxBytes;
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  const sliced = bytes.subarray(0, end);
  return {
    text: utf8Decoder.decode(sliced),
    truncated: true,
    byteLength: sliced.length,
  };
}
