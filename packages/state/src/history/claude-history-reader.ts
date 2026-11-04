/**
 * Portions adapted from stablyai/orca (src/main/ai-vault)
 *
 * Copyright (c) 2026 Lovecast Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  SessionHistoryItem,
  SessionHistoryQuery,
  SessionHistoryResult,
  SessionHistoryRole,
  TurnBoundary,
} from '@spawnea/domain';
import type { HarnessHistoryContext, HarnessHistoryReader } from './types.js';

const DEFAULT_MAX_ITEM_CHARS = 64 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_RECORD_BUFFER = 16 * 1024 * 1024;

/**
 * Encodes a filesystem path into Claude Code project directory name format.
 * Preserves alphanumeric characters and replaces any other character with a dash.
 */
export function encodeClaudeProjectPath(pathValue: string): string {
  const separated = pathValue.replaceAll('\\', '/');
  const trimmed =
    separated === '/' || /^[A-Za-z]:\/$/.test(separated) ? separated : separated.replace(/\/+$/, '');
  const sanitized = trimmed.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= 200) {
    return sanitized;
  }
  let hash = 0;
  for (let i = 0; i < trimmed.length; i++) {
    hash = (Math.imul(31, hash) + trimmed.charCodeAt(i)) | 0;
  }
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Resolves the transcript file path for a Claude Code session.
 */
export function resolveClaudeTranscriptPath(context: HarnessHistoryContext): string | null {
  if (context.resolvedTranscriptPath) {
    if (context.agentSessionId) {
      const base = path.basename(context.resolvedTranscriptPath, '.jsonl');
      if (base === context.agentSessionId) {
        return context.resolvedTranscriptPath;
      }
    } else {
      return context.resolvedTranscriptPath;
    }
  }
  if (!context.agentSessionId || !context.worktreePath) {
    return null;
  }
  const homeDir = context.homeDir || process.env['HOME'] || '';
  if (!homeDir) {
    return null;
  }
  const encodedPath = encodeClaudeProjectPath(context.worktreePath);
  return path.join(homeDir, '.claude', 'projects', encodedPath, `${context.agentSessionId}.jsonl`);
}

interface ParsedCursor {
  offset: number;
  turnId?: string;
  blockIndex?: number;
  file?: string;
  head?: string;
  turnClosed?: boolean;
  pendingOffset?: number;
}

function parseOffsetCursor(cursor?: string): ParsedCursor {
  if (!cursor || !cursor.startsWith('offset:')) return { offset: 0 };
  let rest = cursor.slice('offset:'.length);
  let turnClosed = false;
  if (rest.includes(':closed:1')) {
    turnClosed = true;
    rest = rest.replace(':closed:1', '');
  }

  let pendingOffset: number | undefined = undefined;
  const pendingIdx = rest.indexOf(':pending:');
  if (pendingIdx !== -1) {
    const afterPending = rest.slice(pendingIdx + ':pending:'.length);
    const nextColon = afterPending.indexOf(':');
    const pStr = nextColon === -1 ? afterPending : afterPending.slice(0, nextColon);
    const pNum = parseInt(pStr, 10);
    if (!isNaN(pNum) && pNum >= 0) {
      pendingOffset = pNum;
    }
    rest = rest.slice(0, pendingIdx) + (nextColon === -1 ? '' : afterPending.slice(nextColon));
  }

  let file: string | undefined = undefined;
  const fileIdx = rest.indexOf(':file:');
  if (fileIdx !== -1) {
    const afterFile = rest.slice(fileIdx + ':file:'.length);
    const nextColon = afterFile.indexOf(':');
    if (nextColon === -1) {
      file = afterFile;
      rest = rest.slice(0, fileIdx);
    } else {
      file = afterFile.slice(0, nextColon);
      rest = rest.slice(0, fileIdx) + afterFile.slice(nextColon);
    }
  }

  let head: string | undefined = undefined;
  const headIdx = rest.indexOf(':head:');
  if (headIdx !== -1) {
    const afterHead = rest.slice(headIdx + ':head:'.length);
    const nextColon = afterHead.indexOf(':');
    if (nextColon === -1) {
      head = afterHead;
      rest = rest.slice(0, headIdx);
    } else {
      head = afterHead.slice(0, nextColon);
      rest = rest.slice(0, headIdx) + afterHead.slice(nextColon);
    }
  }

  let blockIndex: number | undefined = undefined;
  const blockIdx = rest.indexOf(':block:');
  if (blockIdx !== -1) {
    const bNum = parseInt(rest.slice(blockIdx + ':block:'.length), 10);
    blockIndex = isNaN(bNum) || bNum < 0 ? undefined : bNum;
    rest = rest.slice(0, blockIdx);
  }

  const turnIdx = rest.indexOf(':turn:');
  if (turnIdx === -1) {
    const num = parseInt(rest, 10);
    return {
      offset: isNaN(num) || num < 0 ? 0 : num,
      turnClosed,
      blockIndex,
      file,
      head,
      pendingOffset,
    };
  }

  const num = parseInt(rest.slice(0, turnIdx), 10);
  const turnId = rest.slice(turnIdx + ':turn:'.length);
  return {
    offset: isNaN(num) || num < 0 ? 0 : num,
    turnId: turnId || undefined,
    turnClosed,
    blockIndex,
    file,
    head,
    pendingOffset,
  };
}

function isClaudeTurnCompletionRecord(record: Record<string, unknown>): boolean {
  const type = typeof record.type === 'string' ? record.type : '';
  return (
    (type === 'system' && (record.subtype === 'turn_duration' || typeof record.duration_ms === 'number' || record.subtype === 'turn_complete')) ||
    type === 'turn_duration' ||
    record.subtype === 'turn_duration'
  );
}

function parseTurnCompletionLine(lineStr: string): boolean {
  try {
    const rec = JSON.parse(lineStr);
    return isClaudeTurnCompletionRecord(rec);
  } catch {
    return false;
  }
}

function tryPeekTurnCompletion(
  fd: number,
  statSize: number,
  unconsumed: Buffer,
  unconsumedFileOffset: number
): { found: boolean; nextOffset?: number } {
  const newlineIdx = unconsumed.indexOf(0x0a);
  if (newlineIdx !== -1) {
    const line = unconsumed.subarray(0, newlineIdx).toString('utf8').trim();
    if (line && parseTurnCompletionLine(line)) {
      return { found: true, nextOffset: unconsumedFileOffset + newlineIdx + 1 };
    }
    return { found: false };
  }

  const nextReadPos = unconsumedFileOffset + unconsumed.length;
  if (nextReadPos < statSize) {
    const peekBuf = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, peekBuf, 0, 4096, nextReadPos);
    if (bytes > 0) {
      const merged = unconsumed.length > 0
        ? Buffer.concat([unconsumed, peekBuf.subarray(0, bytes)])
        : peekBuf.subarray(0, bytes);
      const nl = merged.indexOf(0x0a);
      if (nl !== -1) {
        const line = merged.subarray(0, nl).toString('utf8').trim();
        if (line && parseTurnCompletionLine(line)) {
          return { found: true, nextOffset: unconsumedFileOffset + nl + 1 };
        }
      }
    }
  }

  return { found: false };
}

function computeHeadFingerprint(fd: number, statSize: number, sampleLen = 256): string {
  const len = Math.min(sampleLen, statSize);
  if (len === 0) return '0-0';
  const buf = Buffer.alloc(len);
  const bytesRead = fs.readSync(fd, buf, 0, len, 0);
  let hash = 0;
  for (let i = 0; i < bytesRead; i++) {
    hash = (Math.imul(31, hash) + buf[i]) | 0;
  }
  return `${bytesRead}-${(hash >>> 0).toString(16)}`;
}

function isHeadMatching(fd: number, statSize: number, cursorHead: string): boolean {
  const dashIdx = cursorHead.indexOf('-');
  const sampleLen = dashIdx === -1 ? 256 : parseInt(cursorHead.slice(0, dashIdx), 10);
  if (isNaN(sampleLen) || sampleLen <= 0) return false;
  const currentFp = computeHeadFingerprint(fd, statSize, sampleLen);
  return currentFp === cursorHead;
}

function boundText(
  value: string,
  maxChars: number
): { text: string; textTruncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, textTruncated: false };
  }
  return { text: value.slice(0, maxChars), textTruncated: true };
}

function formatToolCall(name: unknown, input: unknown): string {
  const toolName = typeof name === 'string' && name ? name : 'tool';
  let inputStr = '';
  if (typeof input === 'string') {
    inputStr = input;
  } else if (input && typeof input === 'object') {
    try {
      inputStr = JSON.stringify(input);
    } catch {
      inputStr = String(input);
    }
  }
  return inputStr ? `${toolName}: ${inputStr}` : toolName;
}

function formatToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content ?? '');
}

interface RawItem {
  id: string;
  role: SessionHistoryRole;
  text: string;
  timestamp?: string;
  turnId?: string;
  textTruncated?: boolean;
  explicitTurnStart?: boolean;
  explicitTurnEnd?: boolean;
}

function extractAssistantItems(
  record: Record<string, unknown>,
  recordOffset: number,
  maxChars: number,
  sessionId: string,
  turnId?: string
): RawItem[] {
  const recordUuid =
    (typeof record.uuid === 'string' && record.uuid) ||
    (typeof record.promptId === 'string' && record.promptId) ||
    `off-${recordOffset}`;
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined;
  const msg = record.message as { role?: string; content?: unknown; stop_reason?: string } | undefined;
  const items: RawItem[] = [];

  if (typeof msg?.content === 'string') {
    const { text, textTruncated } = boundText(msg.content, maxChars);
    items.push({
      id: `${sessionId}-${recordUuid}`,
      role: 'agent',
      text,
      timestamp,
      turnId,
      textTruncated,
    });
  } else if (Array.isArray(msg?.content)) {
    let subIdx = 0;
    for (const block of msg.content) {
      const currentBlockIdx = subIdx++;
      if (block && typeof block === 'object') {
        const blockObj = block as { type?: string; text?: unknown; name?: unknown; input?: unknown };
        if (blockObj.type === 'text' && typeof blockObj.text === 'string' && blockObj.text) {
          const { text, textTruncated } = boundText(blockObj.text, maxChars);
          items.push({
            id: `${sessionId}-${recordUuid}-${currentBlockIdx}`,
            role: 'agent',
            text,
            timestamp,
            turnId,
            textTruncated,
          });
        } else if (blockObj.type === 'tool_use') {
          const toolText = formatToolCall(blockObj.name, blockObj.input);
          const { text, textTruncated } = boundText(toolText, maxChars);
          items.push({
            id: `${sessionId}-${recordUuid}-${currentBlockIdx}`,
            role: 'tool',
            text,
            timestamp,
            turnId,
            textTruncated,
          });
        }
      }
    }
  }
  return items;
}

export class ClaudeHistoryReader implements HarnessHistoryReader {
  readonly harnessId = 'claude';

  canRead(context: HarnessHistoryContext): boolean {
    return context.isLocal && (Boolean(context.agentSessionId) || Boolean(context.resolvedTranscriptPath));
  }

  async readHistory(
    context: HarnessHistoryContext,
    query?: SessionHistoryQuery
  ): Promise<SessionHistoryResult | null> {
    const filePath = resolveClaudeTranscriptPath(context);
    if (!filePath) {
      return null;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return null;
    }

    const currentFileName = path.basename(filePath);

    if (stat.size === 0) {
      return {
        sessionId: context.sessionId,
        source: 'transcript',
        items: [],
        cursor: `offset:0:file:${currentFileName}`,
        hasMore: false,
        transcriptPath: filePath,
      };
    }

    const maxChars = query?.maxItemChars || DEFAULT_MAX_ITEM_CHARS;
    let parsedCursor = parseOffsetCursor(query?.cursor);
    if (parsedCursor.file && parsedCursor.file !== currentFileName) {
      // Switched to a new transcript file; reset offset and turn state
      parsedCursor = { offset: 0 };
    }
    const limit = query?.limit || DEFAULT_LIMIT;

    const fd = fs.openSync(filePath, 'r');
    const headFp = computeHeadFingerprint(fd, stat.size);
    if (parsedCursor.head && !isHeadMatching(fd, stat.size, parsedCursor.head)) {
      // Transcript was replaced under the same filename; reset offset and state
      parsedCursor = { offset: 0 };
    }

    if (parsedCursor.offset > stat.size) {
      parsedCursor = { offset: 0 };
    }
    const startOffset = parsedCursor.offset;

    if (startOffset === stat.size) {
      fs.closeSync(fd);
      return {
        sessionId: context.sessionId,
        source: 'transcript',
        items: [],
        cursor: query?.cursor || `offset:${stat.size}:file:${currentFileName}:head:${headFp}`,
        hasMore: false,
        transcriptPath: filePath,
      };
    }

    const rawItems: RawItem[] = [];
    let currentTurnId: string | undefined = parsedCursor.turnId;
    let isCurrentTurnClosed = Boolean(parsedCursor.turnClosed);
    let lastCompleteByteOffset = startOffset;
    let lastItemRecordOffset: number | undefined = parsedCursor.pendingOffset;
    let pendingTurnToClose: number | undefined = parsedCursor.turnClosed ? undefined : parsedCursor.pendingOffset;
    let hasMore = false;
    let nextBlockCursorIndex: number | undefined = undefined;

    const bufferSize = 64 * 1024;
    const chunkBuffer = Buffer.alloc(bufferSize);
    const pendingLineChunks: Buffer[] = [];
    let pendingLineBytes = 0;
    let currentFilePos = startOffset;
    let isFirstRecordAtStartOffset = true;

    const processRecord = (
      record: Record<string, unknown>,
      recordOffset: number,
      lineBytes: number
    ): boolean => {
      const skipBlocksBefore = (isFirstRecordAtStartOffset && parsedCursor.blockIndex !== undefined)
        ? parsedCursor.blockIndex
        : 0;
      isFirstRecordAtStartOffset = false;

      const recordUuid =
        (typeof record.uuid === 'string' && record.uuid) ||
        (typeof record.promptId === 'string' && record.promptId) ||
        `off-${recordOffset}`;

      const type = typeof record.type === 'string' ? record.type : '';
      const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined;

      if (type === 'user') {
        const msg = record.message as { role?: string; content?: unknown } | undefined;
        const isToolResultOnly =
          Array.isArray(msg?.content) &&
          msg.content.length > 0 &&
          msg.content.every((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result');

        if (!isToolResultOnly) {
          currentTurnId =
            (typeof record.uuid === 'string' && record.uuid) ||
            (typeof record.promptId === 'string' && record.promptId) ||
            `turn-off-${recordOffset}`;
          isCurrentTurnClosed = false;
          lastItemRecordOffset = undefined;
          pendingTurnToClose = undefined;
        }

        if (typeof msg?.content === 'string') {
          if (skipBlocksBefore === 0) {
            const { text, textTruncated } = boundText(msg.content, maxChars);
            rawItems.push({
              id: `${context.sessionId}-${recordUuid}`,
              role: 'user',
              text,
              timestamp,
              turnId: currentTurnId,
              textTruncated,
              explicitTurnStart: true,
            });
          }
        } else if (Array.isArray(msg?.content)) {
          let subIdx = 0;
          let hasUserText = msg.content.slice(0, skipBlocksBefore).some(
            (b) => b && typeof b === 'object' && (b as { type?: unknown; text?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string' && (b as { text?: string }).text
          );
          for (const block of msg.content) {
            const currentBlockIdx = subIdx++;
            if (currentBlockIdx < skipBlocksBefore) {
              continue;
            }
            if (rawItems.length >= limit) {
              hasMore = true;
              nextBlockCursorIndex = currentBlockIdx;
              lastCompleteByteOffset = recordOffset;
              return true;
            }

            if (block && typeof block === 'object') {
              const blockObj = block as { type?: string; text?: unknown; content?: unknown };
              if (blockObj.type === 'text' && typeof blockObj.text === 'string' && blockObj.text) {
                const { text, textTruncated } = boundText(blockObj.text, maxChars);
                rawItems.push({
                  id: `${context.sessionId}-${recordUuid}-${currentBlockIdx}`,
                  role: 'user',
                  text,
                  timestamp,
                  turnId: currentTurnId,
                  textTruncated,
                  explicitTurnStart: !hasUserText,
                });
                hasUserText = true;
              } else if (blockObj.type === 'tool_result') {
                const toolText = formatToolResult(blockObj.content);
                const { text, textTruncated } = boundText(toolText, maxChars);
                rawItems.push({
                  id: `${context.sessionId}-${recordUuid}-${currentBlockIdx}`,
                  role: 'tool',
                  text,
                  timestamp,
                  turnId: currentTurnId,
                  textTruncated,
                });
              }
            }
          }
        }
      } else if (type === 'assistant') {
        const msg = record.message as { role?: string; content?: unknown; stop_reason?: string } | undefined;
        const isTurnCompletion =
          msg?.stop_reason === 'end_turn' ||
          msg?.stop_reason === 'stop_sequence' ||
          msg?.stop_reason === 'max_tokens' ||
          msg?.stop_reason === 'refusal';

        isCurrentTurnClosed = isTurnCompletion;
        lastItemRecordOffset = recordOffset;
        pendingTurnToClose = undefined;

        if (typeof msg?.content === 'string') {
          if (skipBlocksBefore === 0) {
            const { text, textTruncated } = boundText(msg.content, maxChars);
            rawItems.push({
              id: `${context.sessionId}-${recordUuid}`,
              role: 'agent',
              text,
              timestamp,
              turnId: currentTurnId,
              textTruncated,
              explicitTurnEnd: isTurnCompletion,
            });
          }
        } else if (Array.isArray(msg?.content)) {
          let lastTextBlockIndex = -1;
          for (let i = msg.content.length - 1; i >= 0; i--) {
            const b = msg.content[i];
            if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
              lastTextBlockIndex = i;
              break;
            }
          }

          let subIdx = 0;
          for (const block of msg.content) {
            const currentBlockIdx = subIdx++;
            if (currentBlockIdx < skipBlocksBefore) {
              continue;
            }
            if (rawItems.length >= limit) {
              hasMore = true;
              nextBlockCursorIndex = currentBlockIdx;
              lastCompleteByteOffset = recordOffset;
              return true;
            }

            if (block && typeof block === 'object') {
              const blockObj = block as { type?: string; text?: unknown; name?: unknown; input?: unknown };
              if (blockObj.type === 'text' && typeof blockObj.text === 'string' && blockObj.text) {
                const { text, textTruncated } = boundText(blockObj.text, maxChars);
                rawItems.push({
                  id: `${context.sessionId}-${recordUuid}-${currentBlockIdx}`,
                  role: 'agent',
                  text,
                  timestamp,
                  turnId: currentTurnId,
                  textTruncated,
                  explicitTurnEnd: isTurnCompletion && currentBlockIdx === lastTextBlockIndex,
                });
              } else if (blockObj.type === 'tool_use') {
                const toolText = formatToolCall(blockObj.name, blockObj.input);
                const { text, textTruncated } = boundText(toolText, maxChars);
                rawItems.push({
                  id: `${context.sessionId}-${recordUuid}-${currentBlockIdx}`,
                  role: 'tool',
                  text,
                  timestamp,
                  turnId: currentTurnId,
                  textTruncated,
                });
              }
            }
          }
        }
      } else if (isClaudeTurnCompletionRecord(record)) {
        isCurrentTurnClosed = true;
        if (rawItems.length > 0) {
          for (let i = rawItems.length - 1; i >= 0; i--) {
            if (rawItems[i].role === 'agent' || rawItems[i].role === 'tool') {
              rawItems[i].explicitTurnEnd = true;
              break;
            }
          }
        } else if (pendingTurnToClose !== undefined && pendingTurnToClose < recordOffset) {
          const pendingLength = Math.min(recordOffset - pendingTurnToClose, MAX_RECORD_BUFFER);
          const pendingBuf = Buffer.alloc(pendingLength);
          const bytes = fs.readSync(fd, pendingBuf, 0, pendingLength, pendingTurnToClose);
          if (bytes > 0) {
            const nl = pendingBuf.subarray(0, bytes).indexOf(0x0a);
            const lineStr = (nl === -1 ? pendingBuf.subarray(0, bytes) : pendingBuf.subarray(0, nl)).toString('utf8').trim();
            if (lineStr) {
              let rec: Record<string, unknown> | null = null;
              try {
                rec = JSON.parse(lineStr);
              } catch {
                // ignore
              }
              if (rec && rec.type === 'assistant') {
                const replayed = extractAssistantItems(rec, pendingTurnToClose, maxChars, context.sessionId, currentTurnId);
                if (replayed.length > 0) {
                  // Replay only the final item requiring the turnBoundary: end update
                  const finalItem = replayed[replayed.length - 1];
                  finalItem.explicitTurnEnd = true;
                  rawItems.push(finalItem);
                }
              }
            }
          }
          pendingTurnToClose = undefined;
        }
      }

      lastCompleteByteOffset = recordOffset + lineBytes;
      if (rawItems.length >= limit) {
        return true;
      }
      return false;
    };

    try {
      readingLoop: while (true) {
        const bytesRead = fs.readSync(fd, chunkBuffer, 0, bufferSize, currentFilePos);
        if (bytesRead === 0) {
          break;
        }
        currentFilePos += bytesRead;
        const chunk = chunkBuffer.subarray(0, bytesRead);

        let searchStart = 0;
        while (searchStart < chunk.length) {
          const nl = chunk.indexOf(0x0a, searchStart);
          if (nl === -1) {
            const remainder = Buffer.from(chunk.subarray(searchStart));
            pendingLineBytes += remainder.length;
            if (pendingLineBytes >= MAX_RECORD_BUFFER) {
              return null;
            }
            pendingLineChunks.push(remainder);
            break;
          }

          const chunkPiece = chunk.subarray(searchStart, nl);
          const lineBytes = pendingLineBytes + chunkPiece.length + 1;
          let lineBuf: Buffer;
          if (pendingLineChunks.length === 0) {
            lineBuf = chunkPiece;
          } else {
            pendingLineBytes += chunkPiece.length;
            if (pendingLineBytes >= MAX_RECORD_BUFFER) {
              return null;
            }
            pendingLineChunks.push(chunkPiece);
            lineBuf = Buffer.concat(pendingLineChunks, pendingLineBytes);
            pendingLineChunks.length = 0;
            pendingLineBytes = 0;
          }

          const recordOffset = currentFilePos - chunk.length + nl + 1 - lineBytes;
          searchStart = nl + 1;

          const lineStr = lineBuf.toString('utf8').trim();
          if (!lineStr) {
            lastCompleteByteOffset = recordOffset + lineBytes;
            continue;
          }

          let record: Record<string, unknown>;
          try {
            record = JSON.parse(lineStr);
          } catch {
            continue;
          }

          if (processRecord(record, recordOffset, lineBytes)) {
            if (nextBlockCursorIndex === undefined) {
              const peekRes = tryPeekTurnCompletion(
                fd,
                stat.size,
                chunk.subarray(searchStart),
                currentFilePos - chunk.length + searchStart
              );
              if (peekRes.found) {
                isCurrentTurnClosed = true;
                if (rawItems.length > 0) {
                  for (let i = rawItems.length - 1; i >= 0; i--) {
                    if (rawItems[i].role === 'agent' || rawItems[i].role === 'tool') {
                      rawItems[i].explicitTurnEnd = true;
                      break;
                    }
                  }
                }
                if (peekRes.nextOffset !== undefined) {
                  lastCompleteByteOffset = peekRes.nextOffset;
                }
              }
            }

            if (lastCompleteByteOffset < stat.size || nextBlockCursorIndex !== undefined) {
              hasMore = true;
            }
            break readingLoop;
          }
        }
      }
    } finally {
      fs.closeSync(fd);
    }

    let returnCursor = `offset:${lastCompleteByteOffset}:file:${currentFileName}:head:${headFp}`;
    if (currentTurnId) {
      returnCursor += `:turn:${currentTurnId}`;
    }
    if (nextBlockCursorIndex !== undefined) {
      returnCursor += `:block:${nextBlockCursorIndex}`;
    }
    if (isCurrentTurnClosed) {
      returnCursor += ':closed:1';
    } else if (lastItemRecordOffset !== undefined) {
      returnCursor += `:pending:${lastItemRecordOffset}`;
    }

    if (rawItems.length === 0) {
      if (startOffset === 0 && stat.size > 0 && parsedCursor.blockIndex === undefined && parsedCursor.pendingOffset === undefined) {
        // Nonempty file with no readable conversation records: fall back to screen
        return null;
      }
      return {
        sessionId: context.sessionId,
        source: 'transcript',
        items: [],
        cursor: returnCursor,
        hasMore: false,
        transcriptPath: filePath,
      };
    }

    // Assign turn boundaries (start/end/single)
    const items: SessionHistoryItem[] = [];
    let currentTurnList: RawItem[] = [];
    let activeTurnId: string | undefined = undefined;

    const flushTurn = (isClosed: boolean) => {
      if (currentTurnList.length === 0) return;
      if (currentTurnList.length === 1) {
        const it = currentTurnList[0];
        let turnBoundary: TurnBoundary | undefined = undefined;
        if (it.explicitTurnStart && isClosed) {
          turnBoundary = it.role === 'user' ? 'single' : 'end';
        } else if (it.explicitTurnStart) {
          turnBoundary = 'start';
        } else if (isClosed && it.explicitTurnEnd) {
          turnBoundary = 'end';
        }
        items.push({
          id: it.id,
          role: it.role,
          text: it.text,
          timestamp: it.timestamp,
          source: 'transcript',
          turnBoundary,
          turnId: it.turnId,
          textTruncated: it.textTruncated,
        });
      } else {
        currentTurnList.forEach((it, idx) => {
          let turnBoundary: TurnBoundary | undefined = undefined;
          if (it.explicitTurnStart) {
            turnBoundary = 'start';
          } else if (isClosed && idx === currentTurnList.length - 1 && it.explicitTurnEnd) {
            turnBoundary = 'end';
          }
          items.push({
            id: it.id,
            role: it.role,
            text: it.text,
            timestamp: it.timestamp,
            source: 'transcript',
            turnBoundary,
            turnId: it.turnId,
            textTruncated: it.textTruncated,
          });
        });
      }
      currentTurnList = [];
    };

    for (const raw of rawItems) {
      if (raw.explicitTurnStart && activeTurnId && raw.turnId !== activeTurnId) {
        flushTurn(true);
      }
      activeTurnId = raw.turnId;
      currentTurnList.push(raw);
      if (raw.explicitTurnEnd) {
        flushTurn(true);
        activeTurnId = undefined;
      }
    }
    const lastItem = currentTurnList[currentTurnList.length - 1];
    const isTurnComplete = isCurrentTurnClosed || Boolean(lastItem && lastItem.explicitTurnEnd);
    flushTurn(isTurnComplete);

    return {
      sessionId: context.sessionId,
      source: 'transcript',
      items,
      cursor: returnCursor,
      hasMore,
      transcriptPath: filePath,
    };
  }
}
