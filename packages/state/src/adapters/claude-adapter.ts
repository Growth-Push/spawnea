import type { CompiledStateRule } from '../rules/rule-config.js';
import { ruleMatchesLine } from '../rules/rule-config.js';
import { RuleBasedStatusAdapter } from './rule-based-adapter.js';
import type { LinePreparationContext } from './types.js';

const INPUT_BOX_BORDER = /^\s*─{3,}\s*$/;
// The editable input line. A numbered selector such as `❯ 1. Yes` is a dialog.
const INPUT_LINE = /^\s*❯(?!\s*\d+\.)/;
const INPUT_PLACEHOLDER = /^\s*❯\s*Try\s+"/;
// Each space run between words is followed by a word character, so a long
// run of spaces cannot backtrack polynomially.
const TURN_COMPLETION = /^\s*[✻✽]\s+[A-Za-z][A-Za-z-]*(?: +[A-Za-z-]+)*\s+for\s+\d+(?:\.\d+)?[smh](?:\s+\d+(?:\.\d+)?[smh])*\s*·\s*done\b/i;
const MODE_FOOTER = /^\s*⏵⏵[^\n]*\b(?:auto\s+mode|plan\s+mode|accept edits(?:\s+mode)?|bypass permissions(?:\s+mode)?)\s+on\b/i;
const TRANSCRIPT_LINE = /^\s*[●⎿]/;
// A configured status line renders directly below the input box.
const STATUS_LINE_LIMIT = 2;

/**
 * Replaces the input box contents (an unsent draft, possibly wrapped over
 * several lines) with a single `❯` line. A draft is not current output.
 */
export function collapseClaudeInputBox(lines: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (INPUT_LINE.test(lines[i]) && i > 0 && INPUT_BOX_BORDER.test(lines[i - 1])) {
      const end = lines.findIndex((line, index) => index > i && INPUT_BOX_BORDER.test(line));
      if (end > i) {
        result.push(INPUT_PLACEHOLDER.test(lines[i]) ? lines[i] : '❯');
        i = end - 1;
        continue;
      }
    }
    result.push(lines[i]);
  }
  return result;
}

function isNonIdleRuleLine(line: string, rules: readonly CompiledStateRule[]): boolean {
  return rules.some((rule) => rule.state !== 'idle' && ruleMatchesLine(rule, line));
}

/**
 * True when the lines after a completion marker are only ready chrome: the
 * input box, up to two status-line rows below it, and the mode footer.
 */
function isReadyTail(lines: string[], rules: readonly CompiledStateRule[]): boolean {
  const input = lines.findIndex((line, index) =>
    INPUT_LINE.test(line) && index > 0 && INPUT_BOX_BORDER.test(lines[index - 1])
  );
  const boxEnd = input < 0 ? -1 : lines.findIndex((line, index) => index > input && INPUT_BOX_BORDER.test(line));
  return lines.every((line, index) => {
    if (isNonIdleRuleLine(line, rules)) {
      return false;
    }
    if (INPUT_BOX_BORDER.test(line) || INPUT_LINE.test(line) || MODE_FOOTER.test(line)) {
      return true;
    }
    return boxEnd >= 0 && index > boxEnd && index <= boxEnd + STATUS_LINE_LIMIT && !TRANSCRIPT_LINE.test(line);
  });
}

/**
 * Claude Code: the `✻ <verb> for <duration> · done` marker ends a turn. Lines
 * before it are historical. Newer output after it starts a newer turn.
 */
export class ClaudeStatusAdapter extends RuleBasedStatusAdapter {
  readonly harnessId = 'claude';
  readonly displayName = 'Claude Code Adapter';

  prepareLines(rawLines: string[], { rules }: LinePreparationContext): string[] {
    const lines = collapseClaudeInputBox(rawLines);
    let completion = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (TURN_COMPLETION.test(lines[i])) {
        completion = i;
        break;
      }
    }
    if (completion < 0) {
      return lines;
    }
    const after = lines.slice(completion + 1);
    // The marker stays when only ready chrome follows it.
    if (isReadyTail(after, rules)) {
      return lines.slice(completion);
    }
    return after.length > 0 ? after : [lines[completion]];
  }
}
