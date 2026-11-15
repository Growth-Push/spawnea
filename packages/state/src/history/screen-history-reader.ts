import type {
  SessionHistoryCursorStatus,
  SessionHistoryItem,
  SessionHistoryQuery,
  SessionHistoryResult,
  SessionHistoryRole,
  TurnBoundary,
} from '@spawnea/domain';
import { canonicalHarnessId } from '../harness-ids.js';
import { cleanTailLines, stripClaudeComposerTail, stripCodexComposerTail } from '../terminal-lines.js';
import type { HarnessHistoryContext, HarnessHistoryReader } from './types.js';

const DEFAULT_MAX_ITEM_CHARS = 64 * 1024;
const DEFAULT_LIMIT = 50;

const PROMPT_LINE_REGEX = /^[›❯>$#%]\s*(.*)$/;
const MENU_CHOICE_REGEX = /^[›❯]\s*(?:\d+[.)]|[a-zA-Z][.)]|\[[0-9a-zA-Z]\]|\([0-9a-zA-Z]\))\s+/;
const TOOL_LINE_REGEX = /^(?:•\s+(?:Ran|Running|Called|Calling)\b|●\s+(?:Ran|Running|Bash|Edit|Write|Read|Glob|Grep|View|Replace|BashCommand|Command)\b|💻\s*\$?\s+|⎿\s+|\s+│\s+|\s+└\s+|\s*(?:Ran|Running)\s+\d+\s+)/;
const COMPLETION_LINE_REGEX = /(?:[✻✽]\s+.*·\s*done\b|Worked for \d+|Task completed successfully)/i;

function normalizeHarnessForScreen(harness?: string): string {
  if (!harness) return '';
  const trimmed = harness.trim();
  const colonIdx = trimmed.lastIndexOf(':');
  const stripped = colonIdx >= 0 ? trimmed.slice(colonIdx + 1) : trimmed;
  const base = stripped.split(/[/\\]/).pop() || stripped;
  const noExt = base.replace(/\.(exe|cmd|bat|sh|mjs|js)$/i, '').toLowerCase();
  return canonicalHarnessId(noExt);
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

function computeTailFingerprint(lines: string[]): string {
  let hash = 0;
  const sample = lines.join('\n');
  for (let i = 0; i < sample.length; i++) {
    hash = (Math.imul(31, hash) + sample.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

type ParsedScreenCursor =
  | { kind: 'none'; line: number }
  | { kind: 'invalid'; line: number }
  | { kind: 'valid'; line: number; fingerprint?: string };

function parseScreenCursor(cursor?: string): ParsedScreenCursor {
  if (cursor === undefined) return { kind: 'none', line: 0 };
  const match = /^line:(\d+)(?::fp:([0-9a-f]+))?$/.exec(cursor);
  if (!match) return { kind: 'invalid', line: 0 };
  const num = parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(num) || num < 0) {
    return { kind: 'invalid', line: 0 };
  }
  return {
    kind: 'valid',
    line: num,
    fingerprint: match[2] || undefined,
  };
}

interface GroupedScreenBlock {
  role: SessionHistoryRole;
  lines: string[];
  isStart?: boolean;
  isEnd?: boolean;
  endLineIndex: number;
}

function prepareScreenLines(context: HarnessHistoryContext): string[] {
  const rawLines = context.tailLines || [];
  let lines = cleanTailLines(rawLines);
  const normHarness = normalizeHarnessForScreen(context.harness);
  if (normHarness === 'codex' || (!normHarness && lines.some((l) => /^\s*›\s*(?:Ask Codex|Ask anything|$)/i.test(l) || /\?\s+for shortcuts/i.test(l)))) {
    lines = stripCodexComposerTail(lines);
  }
  if (normHarness === 'claude' || (!normHarness && lines.some((l) => /^\s*❯\s*Try\s+"/i.test(l) || /⏵⏵\s+auto mode/i.test(l)))) {
    lines = stripClaudeComposerTail(lines);
  }
  return lines;
}

function formatBlockToItem(
  sessionId: string,
  block: GroupedScreenBlock,
  maxChars: number
): SessionHistoryItem | null {
  const joined = block.lines.join('\n').trim();
  if (!joined) return null;

  const { text, textTruncated } = boundText(joined, maxChars);
  let turnBoundary: TurnBoundary | undefined = undefined;
  if (block.isStart && block.isEnd) {
    turnBoundary = 'single';
  } else if (block.isStart) {
    turnBoundary = 'start';
  } else if (block.isEnd) {
    turnBoundary = 'end';
  }

  const blockStartLine = block.endLineIndex - block.lines.length;
  return {
    id: `${sessionId}-screen-l${blockStartLine + 1}`,
    role: block.role,
    text,
    source: 'screen',
    turnBoundary,
    textTruncated,
  };
}

function iterateScreenBlocks(
  effectiveLines: readonly string[],
  effectiveStartLine: number,
  onBlock: (block: GroupedScreenBlock) => boolean | void
): void {
  let currentBlock: GroupedScreenBlock | null = null;
  const emit = (block: GroupedScreenBlock): boolean => onBlock(block) !== false;

  for (let idx = 0; idx < effectiveLines.length; idx++) {
    const line = effectiveLines[idx]!;
    const absoluteLineIndex = effectiveStartLine + idx + 1;
    const promptMatch = line.match(PROMPT_LINE_REGEX);
    const isMenuChoice = MENU_CHOICE_REGEX.test(line);
    const isTool = TOOL_LINE_REGEX.test(line);
    const isCompletion = COMPLETION_LINE_REGEX.test(line);

    if (promptMatch && !isMenuChoice && promptMatch[1]?.trim()) {
      if (currentBlock && !emit(currentBlock)) return;
      currentBlock = {
        role: 'user',
        lines: [promptMatch[1].trim()],
        isStart: true,
        endLineIndex: absoluteLineIndex,
      };
      continue;
    }

    if (isTool) {
      if (
        currentBlock &&
        currentBlock.role === 'tool' &&
        !line.startsWith('•') &&
        !line.startsWith('●') &&
        !/^\s*(?:Ran|Running)\s+\d+\s+/.test(line)
      ) {
        currentBlock.lines.push(line);
        currentBlock.endLineIndex = absoluteLineIndex;
        continue;
      }
      if (currentBlock && !emit(currentBlock)) return;
      currentBlock = {
        role: 'tool',
        lines: [line],
        endLineIndex: absoluteLineIndex,
      };
      continue;
    }

    if (isCompletion) {
      if (currentBlock) {
        currentBlock.isEnd = true;
        currentBlock.lines.push(line);
        currentBlock.endLineIndex = absoluteLineIndex;
        if (!emit(currentBlock)) return;
        currentBlock = null;
      } else if (!emit({
        role: 'agent',
        lines: [line],
        isEnd: true,
        endLineIndex: absoluteLineIndex,
      })) {
        return;
      }
      continue;
    }

    // Neither prompt, tool, nor completion: check if this is an indented continuation
    const isIndented = /^\s+/.test(line);
    if (currentBlock && isIndented && (currentBlock.role === 'user' || currentBlock.role === 'tool')) {
      currentBlock.lines.push(currentBlock.role === 'user' ? line.trim() : line);
      currentBlock.endLineIndex = absoluteLineIndex;
      continue;
    }

    if (currentBlock && currentBlock.role === 'agent') {
      currentBlock.lines.push(line);
      currentBlock.endLineIndex = absoluteLineIndex;
      continue;
    }

    // Un-indented line after user prompt or tool output starts an agent block
    if (currentBlock && !emit(currentBlock)) return;
    currentBlock = {
      role: 'agent',
      lines: [line],
      endLineIndex: absoluteLineIndex,
    };
  }
  if (currentBlock) {
    emit(currentBlock);
  }
}

export class ScreenHistoryReader implements HarnessHistoryReader {
  readonly harnessId = 'screen';

  canRead(_context: HarnessHistoryContext): boolean {
    return true;
  }

  /**
   * Extracts up to `maxItems` newest parsed screen items from the tail in bounded memory
   * without scanning forward through paginated slices.
   */
  async readLatestItems(
    context: HarnessHistoryContext,
    maxItems: number = DEFAULT_LIMIT,
    maxItemChars: number = DEFAULT_MAX_ITEM_CHARS
  ): Promise<{ items: SessionHistoryItem[]; truncated: boolean }> {
    const lines = prepareScreenLines(context);
    if (lines.length === 0) {
      return { items: [], truncated: false };
    }

    const limit = Math.max(0, Math.trunc(maxItems));
    const tail: SessionHistoryItem[] = [];
    let truncated = false;

    iterateScreenBlocks(lines, 0, (block) => {
      const item = formatBlockToItem(context.sessionId, block, maxItemChars);
      if (!item) return;
      if (limit === 0) {
        truncated = true;
        return false;
      }
      if (tail.length >= limit) {
        truncated = true;
      }
      tail.push(item);
      if (tail.length >= limit * 2) {
        tail.splice(0, tail.length - limit);
      }
    });

    return {
      items: limit === 0 ? [] : tail.slice(-limit),
      truncated,
    };
  }

  async readHistory(
    context: HarnessHistoryContext,
    query?: SessionHistoryQuery
  ): Promise<SessionHistoryResult> {
    const lines = prepareScreenLines(context);

    const captureSuccess = context.captureSuccess ?? true;
    const parsed = parseScreenCursor(query?.cursor);

    if (lines.length === 0) {
      let cursorStatus: SessionHistoryCursorStatus = 'initial';
      let cursorExpired = false;
      if (parsed.kind === 'invalid') {
        cursorStatus = 'invalid';
        cursorExpired = true;
      } else if (parsed.kind === 'valid') {
        if (parsed.line === 0 && !parsed.fingerprint) {
          cursorStatus = 'eof';
        } else {
          cursorStatus = parsed.fingerprint ? 'mismatched' : 'expired';
          cursorExpired = true;
        }
      }
      return {
        sessionId: context.sessionId,
        source: 'screen',
        items: [],
        cursor: 'line:0',
        hasMore: false,
        captureSuccess,
        cursorStatus,
        cursorExpired,
      };
    }

    const currentFp = computeTailFingerprint(lines);
    let startLine = parsed.line;
    let cursorStatus: SessionHistoryCursorStatus = parsed.kind === 'none' ? 'initial' : 'valid';
    let cursorExpired = false;

    if (parsed.kind === 'invalid') {
      startLine = 0;
      cursorStatus = 'invalid';
      cursorExpired = true;
    } else if (parsed.kind === 'valid') {
      if (parsed.fingerprint && parsed.fingerprint !== currentFp) {
        // The snapshot window has shifted/scrolled; restart pagination and signal mismatch explicitly
        startLine = 0;
        cursorStatus = 'mismatched';
        cursorExpired = true;
      } else if (startLine > lines.length) {
        return {
          sessionId: context.sessionId,
          source: 'screen',
          items: [],
          cursor: `line:${lines.length}:fp:${currentFp}`,
          hasMore: false,
          captureSuccess,
          cursorStatus: 'expired',
          cursorExpired: true,
        };
      } else if (startLine === lines.length) {
        return {
          sessionId: context.sessionId,
          source: 'screen',
          items: [],
          cursor: `line:${lines.length}:fp:${currentFp}`,
          hasMore: false,
          captureSuccess,
          cursorStatus: 'eof',
          cursorExpired: false,
        };
      }
    }

    const isRecentMode =
      (query?.mode === 'recent_exchanges' || typeof query?.recentExchanges === 'number') &&
      !query?.cursor;
    const targetExchanges = query?.recentExchanges || query?.limit || 20;

    let effectiveStartLine = startLine;
    if (isRecentMode) {
      const promptLineIndices: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const promptMatch = line.match(PROMPT_LINE_REGEX);
        const isMenuChoice = MENU_CHOICE_REGEX.test(line);
        if (promptMatch && !isMenuChoice && promptMatch[1]?.trim()) {
          promptLineIndices.push(i);
        }
      }
      if (promptLineIndices.length > 0) {
        const idx = Math.max(0, promptLineIndices.length - targetExchanges);
        effectiveStartLine = promptLineIndices[idx];
      } else {
        effectiveStartLine = 0;
      }
    }

    const effectiveLines = effectiveStartLine > 0 ? lines.slice(effectiveStartLine) : lines;
    const maxChars = query?.maxItemChars || DEFAULT_MAX_ITEM_CHARS;
    const MAX_PAGE_ITEMS_RECENT = 200;
    const limit = isRecentMode
      ? Math.min(Math.max((query?.recentExchanges || query?.limit || 20) * 5, DEFAULT_LIMIT), MAX_PAGE_ITEMS_RECENT)
      : (query?.limit || DEFAULT_LIMIT);

    const items: SessionHistoryItem[] = [];
    let nextCursorLine = lines.length;
    let hasMore = false;

    iterateScreenBlocks(effectiveLines, effectiveStartLine, (block) => {
      const item = formatBlockToItem(context.sessionId, block, maxChars);
      if (!item) return;

      if (items.length >= limit) {
        hasMore = true;
        nextCursorLine = block.endLineIndex - block.lines.length;
        return false;
      }

      items.push(item);
    });

    return {
      sessionId: context.sessionId,
      source: 'screen',
      items,
      cursor: `line:${nextCursorLine}:fp:${currentFp}`,
      hasMore,
      captureSuccess,
      cursorStatus,
      cursorExpired,
    };
  }
}
