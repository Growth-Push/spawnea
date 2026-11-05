import * as fs from 'node:fs';

export type UserPromptCheck = (
  record: Record<string, unknown>,
  recordOffset: number
) => boolean;

export const MAX_TAIL_RECORD_BYTES = 4 * 1024 * 1024; // 4 MiB
export const DEFAULT_MAX_TAIL_SCAN_BYTES = 8 * 1024 * 1024; // 8 MiB

export interface TailScannerStats {
  trailingFragmentsCount: number;
  trailingBytes: number;
  recordTooLarge: boolean;
}

/**
 * Scans a Codex JSONL file backwards in bounded chunks (default 64 KiB),
 * collecting event_msg.user_message and response_item.user_message offsets separately in a single pass.
 * Stops when event offsets reach targetExchanges (using event offsets),
 * or when response offsets reach targetExchanges while no event has been seen (using response offsets).
 * At the start of the file, uses events if any, else responses.
 * Never reads the whole file if the target exchanges are found in the tail.
 * Returns -1 if no matching user prompt records exist in the scanned file.
 * If maxScanBytes is reached with no prompt offset collected, returns the start
 * of the last scanned chunk. That offset can fall inside a record, so the caller
 * must discard the partial first line.
 */
export function findCodexTailExchangeOffset(
  fd: number,
  fileSize: number,
  isEventMsgPrompt: UserPromptCheck,
  isResponseItemPrompt: UserPromptCheck,
  targetExchanges = 20,
  chunkSize = 64 * 1024,
  onChunk?: (stats: TailScannerStats) => void,
  maxScanBytes = DEFAULT_MAX_TAIL_SCAN_BYTES
): number {
  if (fileSize <= 0) return 0;
  if (targetExchanges <= 0) return fileSize;

  let currentEnd = fileSize;
  let totalScannedBytes = 0;
  let trailingFragments: Buffer[] = [];
  let trailingBytes = 0;
  let recordTooLarge = false;
  const eventOffsets: number[] = [];
  const responseOffsets: number[] = [];

  const checkRecord = (
    buf: Buffer,
    lineOffset: number
  ): { isEvent: boolean; isResponse: boolean } => {
    if (!buf.includes('user')) {
      return { isEvent: false, isResponse: false };
    }
    const lineStr = buf.toString('utf8').trim();
    if (!lineStr) return { isEvent: false, isResponse: false };
    try {
      const record = JSON.parse(lineStr);
      if (record && typeof record === 'object') {
        if (isEventMsgPrompt(record, lineOffset)) {
          return { isEvent: true, isResponse: false };
        }
        if (isResponseItemPrompt(record, lineOffset)) {
          return { isEvent: false, isResponse: true };
        }
      }
    } catch {
      // Skip malformed
    }
    return { isEvent: false, isResponse: false };
  };

  while (currentEnd > 0) {
    const readStart = Math.max(0, currentEnd - chunkSize);
    const readLength = currentEnd - readStart;
    const chunkBuf = Buffer.alloc(readLength);
    const bytesRead = fs.readSync(fd, chunkBuf, 0, readLength, readStart);
    if (bytesRead <= 0) break;

    const actualChunk = chunkBuf.subarray(0, bytesRead);
    totalScannedBytes += bytesRead;
    const firstNl = actualChunk.indexOf(0x0a);
    const lastNl = actualChunk.lastIndexOf(0x0a);

    if (firstNl === -1) {
      // Entire chunk has no newline; it is a fragment of a multi-chunk line
      if (recordTooLarge) {
        // Discard chunk immediately without retaining any bytes
        if (readStart === 0) {
          trailingFragments = [];
          trailingBytes = 0;
          recordTooLarge = false;
        }
      } else {
        if (trailingBytes + actualChunk.length > MAX_TAIL_RECORD_BYTES) {
          recordTooLarge = true;
          trailingFragments = [];
          trailingBytes = 0;
        } else {
          trailingFragments.unshift(actualChunk);
          trailingBytes += actualChunk.length;
          if (readStart === 0) {
            const fullLineBuf =
              trailingFragments.length === 1
                ? trailingFragments[0]
                : Buffer.concat(trailingFragments);
            const res = checkRecord(fullLineBuf, 0);
            if (res.isEvent) eventOffsets.unshift(0);
            else if (res.isResponse) responseOffsets.unshift(0);
            trailingFragments = [];
            trailingBytes = 0;
            recordTooLarge = false;
          }
        }
      }
    } else {
      // Chunk contains at least one newline
      // 1. Tail part after lastNl completes the trailing line
      const tailPart = actualChunk.subarray(lastNl + 1);
      if (recordTooLarge) {
        // The oversized record terminates at lastNl; discard tailPart and reset
        trailingFragments = [];
        trailingBytes = 0;
        recordTooLarge = false;
      } else if (tailPart.length > 0 || trailingFragments.length > 0) {
        if (trailingBytes + tailPart.length > MAX_TAIL_RECORD_BYTES) {
          recordTooLarge = true;
          trailingFragments = [];
          trailingBytes = 0;
          recordTooLarge = false;
        } else {
          if (tailPart.length > 0) {
            trailingFragments.unshift(tailPart);
            trailingBytes += tailPart.length;
          }
          const fullLineBuf =
            trailingFragments.length === 1
              ? trailingFragments[0]
              : Buffer.concat(trailingFragments);
          const lineOffset = readStart + lastNl + 1;
          const res = checkRecord(fullLineBuf, lineOffset);
          if (res.isEvent) eventOffsets.unshift(lineOffset);
          else if (res.isResponse) responseOffsets.unshift(lineOffset);
          trailingFragments = [];
          trailingBytes = 0;
          recordTooLarge = false;
        }
      }

      // 2. All complete lines strictly within actualChunk between firstNl and lastNl
      let searchStart = firstNl + 1;
      const innerEvents: number[] = [];
      const innerResponses: number[] = [];
      while (searchStart <= lastNl) {
        const nextNl = actualChunk.indexOf(0x0a, searchStart);
        const lineEnd = nextNl === -1 ? actualChunk.length : nextNl;
        const lineBuf = actualChunk.subarray(searchStart, lineEnd);
        const lineOffset = readStart + searchStart;
        searchStart = lineEnd + 1;

        if (lineBuf.length > MAX_TAIL_RECORD_BYTES) {
          continue;
        }
        const res = checkRecord(lineBuf, lineOffset);
        if (res.isEvent) innerEvents.push(lineOffset);
        else if (res.isResponse) innerResponses.push(lineOffset);
      }
      eventOffsets.unshift(...innerEvents);
      responseOffsets.unshift(...innerResponses);

      // 3. The head part before firstNl (from 0 to firstNl)
      if (readStart === 0) {
        const headLineBuf = actualChunk.subarray(0, firstNl);
        if (headLineBuf.length <= MAX_TAIL_RECORD_BYTES) {
          const res = checkRecord(headLineBuf, 0);
          if (res.isEvent) eventOffsets.unshift(0);
          else if (res.isResponse) responseOffsets.unshift(0);
        }
        trailingFragments = [];
        trailingBytes = 0;
        recordTooLarge = false;
      } else {
        const headPart = actualChunk.subarray(0, firstNl);
        if (headPart.length > MAX_TAIL_RECORD_BYTES) {
          recordTooLarge = true;
          trailingFragments = [];
          trailingBytes = 0;
        } else {
          recordTooLarge = false;
          trailingFragments = [headPart];
          trailingBytes = headPart.length;
        }
      }
    }

    onChunk?.({
      trailingFragmentsCount: trailingFragments.length,
      trailingBytes,
      recordTooLarge,
    });

    if (eventOffsets.length >= targetExchanges) {
      const targetIndex = eventOffsets.length - targetExchanges;
      return eventOffsets[targetIndex];
    }
    if (eventOffsets.length === 0 && responseOffsets.length >= targetExchanges) {
      const targetIndex = responseOffsets.length - targetExchanges;
      return responseOffsets[targetIndex];
    }

    if (totalScannedBytes >= maxScanBytes) {
      if (eventOffsets.length > 0) {
        return eventOffsets[0];
      }
      if (responseOffsets.length > 0) {
        return responseOffsets[0];
      }
      return readStart;
    }

    currentEnd = readStart;
  }

  if (eventOffsets.length > 0) {
    return eventOffsets[0];
  }
  if (responseOffsets.length > 0) {
    return responseOffsets[0];
  }
  return -1;
}

/**
 * Scans a JSONL file backwards in bounded chunks (default 64 KiB)
 * to locate the byte offset of the N-th most recent user exchange start.
 * Never reads the whole file if the target exchanges are found in the tail.
 * Returns -1 if no matching user prompt records exist in the scanned file.
 * If maxScanBytes is reached with no prompt offset collected, returns the start
 * of the last scanned chunk. That offset can fall inside a record, so the caller
 * must discard the partial first line.
 */
export function findTailExchangeOffset(
  fd: number,
  fileSize: number,
  isUserPrompt: UserPromptCheck,
  targetExchanges = 20,
  chunkSize = 64 * 1024,
  onChunk?: (stats: TailScannerStats) => void,
  maxScanBytes = DEFAULT_MAX_TAIL_SCAN_BYTES
): number {
  return findCodexTailExchangeOffset(
    fd,
    fileSize,
    isUserPrompt,
    () => false,
    targetExchanges,
    chunkSize,
    onChunk,
    maxScanBytes
  );
}
