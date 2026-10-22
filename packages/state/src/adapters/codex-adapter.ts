import type { StateRuleMatch } from '../rules/rule-config.js';
import { codexSignalLines } from '../terminal-lines.js';
import { RuleBasedStatusAdapter } from './rule-based-adapter.js';

// Codex prints transcript entries, turn failures, and submitted prompts at
// column 0. Wrapped text, quoted content, and draft continuation lines are
// indented. Interrupt notices share the failure glyph.
const CODEX_TURN_FAILURE = /^■\s+(\S.*)$/;
const CODEX_INTERRUPT_NOTICE = /\binterrupted\b/i;
const CODEX_PROMPT_LINE = /^[›❯>](?:\s|$)/;
const CODEX_TURN_ACTIVITY = /^(?:•|[›❯>](?:\s|$))/;

interface CodexTurnFailure {
  index: number;
  message: string;
  resolved: boolean;
}

/**
 * Finds the latest turn failure in the transcript above the editable prompt.
 * A later agent entry or submitted prompt resolves it. The bottom prompt line
 * (placeholder, empty, or unsent draft) and anything below it do not.
 */
function findLatestCodexFailure(lines: string[]): CodexTurnFailure | undefined {
  // Only a bottom prompt with no later column-0 transcript is the editable
  // composer; an earlier prompt was submitted.
  let editablePrompt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\S/.test(lines[i])) {
      if (CODEX_PROMPT_LINE.test(lines[i])) {
        editablePrompt = i;
      }
      break;
    }
  }
  for (let i = editablePrompt - 1; i >= 0; i--) {
    const match = lines[i].match(CODEX_TURN_FAILURE);
    if (!match) {
      continue;
    }
    if (CODEX_INTERRUPT_NOTICE.test(match[1])) {
      return undefined;
    }
    const resolved = lines.slice(i + 1, editablePrompt).some((line) => CODEX_TURN_ACTIVITY.test(line));
    return { index: i, message: match[1].trim(), resolved };
  }
  return undefined;
}

const CODEX_COMPLETION = /(?:^\s*─\s+Worked for\b|Worked for \d+(?:\.\d+)?(?:s|m|h))/i;

/**
 * Codex: status comes only from live transcript and UI lines. Tool content and
 * the unsent draft are removed first (over the whole tail, so a long tool
 * block keeps its opener). A `Worked for` marker or a turn failure ends the
 * previous turn; only newer lines remain. An unresolved failure keeps its
 * line so the error rule can report it.
 */
export class CodexStatusAdapter extends RuleBasedStatusAdapter {
  readonly harnessId = 'codex';
  readonly displayName = 'OpenAI Codex Adapter';
  // An unresolved failure stays an error while Codex redraws its ready prompt.
  protected readonly trimsSupersededErrors = false;

  prepareLines(lines: string[]): string[] {
    const signal = codexSignalLines(lines);
    let completion = -1;
    for (let i = signal.length - 1; i >= 0; i--) {
      if (CODEX_COMPLETION.test(signal[i])) {
        completion = i;
        break;
      }
    }
    const failure = findLatestCodexFailure(signal.slice(completion + 1));
    if (failure) {
      const failureIndex = completion + 1 + failure.index;
      return failure.resolved ? signal.slice(failureIndex + 1) : signal.slice(failureIndex);
    }
    if (completion >= 0) {
      const after = signal.slice(completion + 1);
      return after.length > 0 ? after : [signal[completion]];
    }
    return signal;
  }

  protected describeMatch(match: StateRuleMatch): { detectedPrompt: string; reason: string } {
    const failure = match.rule.state === 'error' ? match.line.match(CODEX_TURN_FAILURE) : null;
    if (failure) {
      const message = failure[1].trim();
      return { detectedPrompt: message, reason: `Codex turn failed: ${message}` };
    }
    return super.describeMatch(match);
  }
}
