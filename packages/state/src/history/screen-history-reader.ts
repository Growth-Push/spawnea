import type {
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

function parseScreenCursor(cursor?: string): { line: number; fingerprint?: string } {
  if (!cursor || !cursor.startsWith('line:')) return { line: 0 };
  const parts = cursor.slice('line:'.length).split(':fp:');
  const num = parseInt(parts[0], 10);
  return {
    line: isNaN(num) || num < 0 ? 0 : num,
    fingerprint: parts[1] || undefined,
  };
}

export class ScreenHistoryReader implements HarnessHistoryReader {
  readonly harnessId = 'screen';

  canRead(_context: HarnessHistoryContext): boolean {
    return true;
  }

  async readHistory(
    context: HarnessHistoryContext,
    query?: SessionHistoryQuery
  ): Promise<SessionHistoryResult> {
    const rawLines = context.tailLines || [];
    let lines = cleanTailLines(rawLines);
    const normHarness = normalizeHarnessForScreen(context.harness);
    if (normHarness === 'codex' || (!normHarness && lines.some((l) => /^\s*›\s*(?:Ask Codex|Ask anything|$)/i.test(l) || /\?\s+for shortcuts/i.test(l)))) {
      lines = stripCodexComposerTail(lines);
    }
    if (normHarness === 'claude' || (!normHarness && lines.some((l) => /^\s*❯\s*Try\s+"/i.test(l) || /⏵⏵\s+auto mode/i.test(l)))) {
      lines = stripClaudeComposerTail(lines);
    }

    const captureSuccess = context.captureSuccess ?? true;

    if (lines.length === 0) {
      return {
        sessionId: context.sessionId,
        source: 'screen',
        items: [],
        cursor: 'line:0',
        hasMore: false,
        captureSuccess,
      };
    }

    const currentFp = computeTailFingerprint(lines);
    const parsed = parseScreenCursor(query?.cursor);
    let startLine = parsed.line;

    // If a fingerprint was provided from a previous snapshot and it matches, check if we're at EOF
    if (parsed.fingerprint && parsed.fingerprint === currentFp) {
      if (startLine >= lines.length) {
        return {
          sessionId: context.sessionId,
          source: 'screen',
          items: [],
          cursor: `line:${lines.length}:fp:${currentFp}`,
          hasMore: false,
          captureSuccess,
        };
      }
    } else if (parsed.fingerprint && parsed.fingerprint !== currentFp) {
      // The snapshot window has shifted/scrolled; restart pagination against the new snapshot
      startLine = 0;
    }

    if (startLine >= lines.length) {
      return {
        sessionId: context.sessionId,
        source: 'screen',
        items: [],
        cursor: `line:${lines.length}:fp:${currentFp}`,
        hasMore: false,
        captureSuccess,
      };
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

    interface GroupedBlock {
      role: SessionHistoryRole;
      lines: string[];
      isStart?: boolean;
      isEnd?: boolean;
      endLineIndex: number;
    }

    const blocks: GroupedBlock[] = [];
    let currentBlock: GroupedBlock | null = null;

    for (let idx = 0; idx < effectiveLines.length; idx++) {
      const line = effectiveLines[idx];
      const absoluteLineIndex = effectiveStartLine + idx + 1;
      const promptMatch = line.match(PROMPT_LINE_REGEX);
      const isMenuChoice = MENU_CHOICE_REGEX.test(line);
      const isTool = TOOL_LINE_REGEX.test(line);
      const isCompletion = COMPLETION_LINE_REGEX.test(line);

      if (promptMatch && !isMenuChoice && promptMatch[1]?.trim()) {
        if (currentBlock) blocks.push(currentBlock);
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
        if (currentBlock) blocks.push(currentBlock);
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
          blocks.push(currentBlock);
          currentBlock = null;
        } else {
          blocks.push({
            role: 'agent',
            lines: [line],
            isEnd: true,
            endLineIndex: absoluteLineIndex,
          });
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
      if (currentBlock) blocks.push(currentBlock);
      currentBlock = {
        role: 'agent',
        lines: [line],
        endLineIndex: absoluteLineIndex,
      };
    }
    if (currentBlock) {
      blocks.push(currentBlock);
    }

    const items: SessionHistoryItem[] = [];
    let nextCursorLine = lines.length;
    let hasMore = false;

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const joined = block.lines.join('\n').trim();
      if (!joined) continue;

      if (items.length >= limit) {
        hasMore = true;
        nextCursorLine = block.endLineIndex - block.lines.length;
        break;
      }

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
      items.push({
        id: `${context.sessionId}-screen-l${blockStartLine + 1}`,
        role: block.role,
        text,
        source: 'screen',
        turnBoundary,
        textTruncated,
      });
    }

    return {
      sessionId: context.sessionId,
      source: 'screen',
      items,
      cursor: `line:${nextCursorLine}:fp:${currentFp}`,
      hasMore,
      captureSuccess,
    };
  }
}
