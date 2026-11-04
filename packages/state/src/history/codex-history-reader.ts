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
import { resolveCodexRolloutFromProc } from './proc-fd-resolver.js';
import type { HarnessHistoryContext, HarnessHistoryReader } from './types.js';

const DEFAULT_MAX_ITEM_CHARS = 64 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_RECORD_BUFFER = 16 * 1024 * 1024;


interface ParsedCursor {
  offset: number;
  turnId?: string;
  turnClosed?: boolean;
  file?: string;
  head?: string;
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

  const turnIdx = rest.indexOf(':turn:');
  if (turnIdx === -1) {
    const num = parseInt(rest, 10);
    return {
      offset: isNaN(num) || num < 0 ? 0 : num,
      turnClosed,
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
    file,
    head,
    pendingOffset,
  };
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

function extractRawItemFromRecord(
  record: Record<string, unknown>,
  recordOffset: number,
  maxChars: number,
  sessionId: string,
  turnId?: string
): RawItem | null {
  const recordBaseId = `off-${recordOffset}`;
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined;
  const type = typeof record.type === 'string' ? record.type : '';
  const payload = record.payload as Record<string, unknown> | undefined;

  if (type === 'event_msg' && payload) {
    const eventType = String(payload.type);
    if (eventType === 'item_completed') {
      const item = payload.item as Record<string, unknown> | undefined;
      if (item?.type === 'CommandExecution' || item?.type === 'command_execution') {
        const cmd = Array.isArray(item.command)
          ? item.command.filter((c) => typeof c === 'string').join(' ')
          : String(item.command ?? '');
        const output = String(item.aggregated_output ?? item.aggregatedOutput ?? '');
        const toolContent = output ? `${cmd}\n${output}` : cmd;
        const { text, textTruncated } = boundText(toolContent, maxChars);
        return {
          id: `${sessionId}-${item.call_id ? `${item.call_id}-out` : recordBaseId}`,
          role: 'tool',
          text,
          timestamp,
          turnId,
          textTruncated,
        };
      } else if (item?.type === 'FileChange' || item?.type === 'file_change') {
        const changes = item.changes as Record<string, unknown> | undefined;
        const summaryParts: string[] = [];
        if (changes && typeof changes === 'object') {
          for (const [k, v] of Object.entries(changes)) {
            const change = v as Record<string, unknown> | undefined;
            summaryParts.push(`${k}: ${change?.unified_diff ?? change?.content ?? 'modified'}`);
          }
        }
        const toolContent = summaryParts.length > 0 ? summaryParts.join('\n') : 'file change';
        const { text, textTruncated } = boundText(toolContent, maxChars);
        return {
          id: `${sessionId}-${recordBaseId}`,
          role: 'tool',
          text,
          timestamp,
          turnId,
          textTruncated,
        };
      }
    }
    return null;
  }

  if (type === 'response_item' && payload) {
    const itemType = String(payload.type);
    if (itemType === 'message') {
      const msgRole = String(payload.role);
      // Exclude system/developer instructions from conversation history
      if (msgRole === 'user' || msgRole === 'assistant') {
        const rawText = extractMessageText(payload.content);
        if (rawText.trim()) {
          const { text, textTruncated } = boundText(rawText, maxChars);
          return {
            id: `${sessionId}-${payload.id || recordBaseId}`,
            role: msgRole === 'user' ? 'user' : 'agent',
            text,
            timestamp,
            turnId,
            textTruncated,
            explicitTurnStart: msgRole === 'user',
          };
        }
      }
    } else if (itemType === 'custom_tool_call' || itemType === 'function_call') {
      const name = payload.name;
      const input = payload.input ?? payload.arguments;
      const toolText = formatToolCall(name, input);
      const { text, textTruncated } = boundText(toolText, maxChars);
      return {
        id: `${sessionId}-${(payload.call_id || payload.id || recordBaseId)}-call`,
        role: 'tool',
        text,
        timestamp,
        turnId,
        textTruncated,
      };
    } else if (itemType === 'custom_tool_call_output' || itemType === 'function_call_output') {
      const toolText = formatToolResult(payload.output);
      const { text, textTruncated } = boundText(toolText, maxChars);
      return {
        id: `${sessionId}-${(payload.call_id || payload.id || recordBaseId)}-out`,
        role: 'tool',
        text,
        timestamp,
        turnId,
        textTruncated,
      };
    }
    return null;
  }

  if (type === 'message') {
    const msgRole = String(record.role);
    if (msgRole === 'user' || msgRole === 'assistant') {
      const rawText = extractMessageText(record.content);
      if (rawText.trim()) {
        const { text, textTruncated } = boundText(rawText, maxChars);
        return {
          id: `${sessionId}-${recordBaseId}`,
          role: msgRole === 'user' ? 'user' : 'agent',
          text,
          timestamp,
          turnId,
          textTruncated,
          explicitTurnStart: msgRole === 'user',
        };
      }
    }
    return null;
  }

  if (type === 'function_call') {
    const toolText = formatToolCall(record.name, record.arguments);
    const { text, textTruncated } = boundText(toolText, maxChars);
    return {
      id: `${sessionId}-${(record.call_id || recordBaseId)}-call`,
      role: 'tool',
      text,
      timestamp,
      turnId,
      textTruncated,
    };
  }

  if (type === 'function_call_output') {
    const toolText = formatToolResult(record.output);
    const { text, textTruncated } = boundText(toolText, maxChars);
    return {
      id: `${sessionId}-${(record.call_id || recordBaseId)}-out`,
      role: 'tool',
      text,
      timestamp,
      turnId,
      textTruncated,
    };
  }

  return null;
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') parts.push(part);
      else if (part && typeof part === 'object') {
        const obj = part as { text?: unknown };
        if (typeof obj.text === 'string') parts.push(obj.text);
      }
    }
    return parts.join('\n');
  }
  return '';
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
    const obj = content as { content?: unknown; output?: unknown };
    const val = obj.content ?? obj.output ?? content;
    if (typeof val === 'string') {
      return val;
    }
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  return String(content ?? '');
}

function tryPeekTaskComplete(
  fd: number,
  statSize: number,
  unconsumed: Buffer,
  unconsumedFileOffset: number
): { found: boolean; nextOffset?: number } {
  const newlineInUnconsumed = unconsumed.indexOf(0x0a);
  if (newlineInUnconsumed !== -1) {
    const line = unconsumed.subarray(0, newlineInUnconsumed).toString('utf8').trim();
    if (line) {
      try {
        const rec = JSON.parse(line);
        if (rec.type === 'event_msg' && rec.payload?.type === 'task_complete') {
          return { found: true, nextOffset: unconsumedFileOffset + newlineInUnconsumed + 1 };
        }
      } catch {
        // ignore
      }
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
      const newlineIdx = merged.indexOf(0x0a);
      if (newlineIdx !== -1) {
        const line = merged.subarray(0, newlineIdx).toString('utf8').trim();
        if (line) {
          try {
            const rec = JSON.parse(line);
            if (rec.type === 'event_msg' && rec.payload?.type === 'task_complete') {
              return {
                found: true,
                nextOffset: unconsumedFileOffset + newlineIdx + 1,
              };
            }
          } catch {
            // ignore
          }
        }
      }
    }
  }

  return { found: false };
}

export class CodexHistoryReader implements HarnessHistoryReader {
  readonly harnessId = 'codex';

  canRead(context: HarnessHistoryContext): boolean {
    return context.isLocal && (Boolean(context.panePid) || Boolean(context.resolvedTranscriptPath));
  }

  async readHistory(
    context: HarnessHistoryContext,
    query?: SessionHistoryQuery
  ): Promise<SessionHistoryResult | null> {
    let filePath = context.resolvedTranscriptPath;

    // Revalidate against the running process if panePid is available
    if (context.panePid) {
      const liveRollout = resolveCodexRolloutFromProc(context.panePid);
      if (liveRollout) {
        filePath = liveRollout;
      }
    }

    if (filePath && !fs.existsSync(filePath)) {
      filePath = undefined;
    }

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
      // Switched to a new rollout file; reset offset and turn state
      parsedCursor = { offset: 0 };
    }

    const limit = query?.limit || DEFAULT_LIMIT;

    const fd = fs.openSync(filePath, 'r');
    const headFp = computeHeadFingerprint(fd, stat.size);
    if (parsedCursor.head && !isHeadMatching(fd, stat.size, parsedCursor.head)) {
      // Rollout was replaced under the same filename; reset offset and turn state
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
    let currentTurnId = parsedCursor.turnId || `turn-off-${startOffset}`;
    let isCurrentTurnClosed = Boolean(parsedCursor.turnClosed);
    let lastCompleteByteOffset = startOffset;
    let lastItemRecordOffset: number | undefined = parsedCursor.pendingOffset;
    let pendingTurnToClose: number | undefined = parsedCursor.turnClosed ? undefined : parsedCursor.pendingOffset;
    let hasMore = false;
    const bufferSize = 64 * 1024;
    const chunkBuffer = Buffer.alloc(bufferSize);
    const pendingLineChunks: Buffer[] = [];
    let pendingLineBytes = 0;
    let currentFilePos = startOffset;

    const processRecord = (
      record: Record<string, unknown>,
      recordOffset: number,
      lineBytes: number
    ): boolean => {
      lastCompleteByteOffset = recordOffset + lineBytes;
      const type = typeof record.type === 'string' ? record.type : '';
      const payload = record.payload as Record<string, unknown> | undefined;

      if (type === 'event_msg' && payload) {
        const eventType = String(payload.type);
        if (eventType === 'task_started') {
          currentTurnId =
            (typeof payload.turn_id === 'string' && payload.turn_id) ||
            (typeof payload.root_turn_id === 'string' && payload.root_turn_id) ||
            `turn-off-${recordOffset}`;
          isCurrentTurnClosed = false;
          lastItemRecordOffset = undefined;
          pendingTurnToClose = undefined;
        } else if (eventType === 'task_complete') {
          isCurrentTurnClosed = true;
          if (rawItems.length > 0) {
            rawItems[rawItems.length - 1].explicitTurnEnd = true;
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
                if (rec) {
                  const replayed = extractRawItemFromRecord(rec, pendingTurnToClose, maxChars, context.sessionId, currentTurnId);
                  if (replayed) {
                    replayed.explicitTurnEnd = true;
                    rawItems.push(replayed);
                  }
                }
              }
            }
            pendingTurnToClose = undefined;
          }
        } else {
          const item = extractRawItemFromRecord(record, recordOffset, maxChars, context.sessionId, currentTurnId);
          if (item) {
            rawItems.push(item);
            lastItemRecordOffset = recordOffset;
            pendingTurnToClose = undefined;
          }
        }
      } else {
        const item = extractRawItemFromRecord(record, recordOffset, maxChars, context.sessionId, currentTurnId);
        if (item) {
          rawItems.push(item);
          lastItemRecordOffset = recordOffset;
          pendingTurnToClose = undefined;
        }
      }

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
            // Peek if the next record is task_complete
            const peekRes = tryPeekTaskComplete(
              fd,
              stat.size,
              chunk.subarray(searchStart),
              currentFilePos - chunk.length + searchStart
            );
            if (peekRes.found) {
              isCurrentTurnClosed = true;
              if (rawItems.length > 0) {
                rawItems[rawItems.length - 1].explicitTurnEnd = true;
              }
              if (peekRes.nextOffset !== undefined) {
                lastCompleteByteOffset = peekRes.nextOffset;
              }
            }

            if (lastCompleteByteOffset < stat.size) {
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
    if (isCurrentTurnClosed) {
      returnCursor += ':closed:1';
    } else if (lastItemRecordOffset !== undefined) {
      returnCursor += `:pending:${lastItemRecordOffset}`;
    }

    if (rawItems.length === 0) {
      if (startOffset === 0 && stat.size > 0 && parsedCursor.pendingOffset === undefined) {
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

    // Resolve turn boundaries
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
          } else if (idx === currentTurnList.length - 1 && isClosed && it.explicitTurnEnd) {
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
