import { ruleMatchesLine } from '../rules/rule-config.js';
import { RuleBasedStatusAdapter } from './rule-based-adapter.js';
import type { LinePreparationContext } from './types.js';

const SCROLLBAR_ROW = /^\s*█+\s*$/;
const QUESTION_CARD_HEADER = /Tab:\s*next answer|Waiting on answers\b/i;
const QUESTION_CARD_LINE = /Waiting on answers\b|Tab:\s*next answer|Enter:\s*submit|Type your answer here|↑\/↓\s*navigate|\(\s*[○●]\s*\)|^\s*┃/i;
const EMPTY_COMPOSER = /[│|]\s*[❯›>]\s*[│|]\s*$/;
const SHORTCUT_BAR_MODE = /Shift\+Tab:\s*mode/i;
const SHORTCUT_BAR_END = /shortcuts/i;
const COMPLETION_LINE = /^\s*Worked for\s+\d[\d.smh ]*$/i;
const BOX_CHROME = /^[╭╮╰╯┌┐└┘─━│├┤┬┴┼]+$/;
const MODEL_NAME = /Grok\s+\d+(?:\.\d+)?\b/;
const BOX_GLYPH = /[╭╮╰╯│─]/;
// Welcome-panel rows, tips, update notices, the release-channel badge, and
// the header row with the branch, working directory, and context usage.
const WELCOME_CHROME = /^\s*[│|╭╰]|^\s*Tip:|^\s*Update: v|^\s*\[[a-z]+\]\s*$|^\s*(?:\uE0A0\s*)?[\w./-]+\s+[~/]\S*(?:\s.*\[Dashboard\])?\s*$/i;
const RECAP_LINE = /^\s*┃/;

// The helpers below scan with separate linear patterns instead of one pattern
// with `.*` between two parts, which backtracks polynomially on long lines
// that repeat the first part.

function stripTrailingScrollbar(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === '█' || line[end - 1].trim() === '')) {
    end--;
  }
  return line.slice(0, end);
}

/** The empty composer box, or the shortcut bar shown below it. */
function isReadyComposer(line: string): boolean {
  if (EMPTY_COMPOSER.test(line)) {
    return true;
  }
  const mode = SHORTCUT_BAR_MODE.exec(line);
  return mode !== null && SHORTCUT_BAR_END.test(line.slice(mode.index + mode[0].length));
}

/** The composer border that carries the model name. */
function isModelFooter(line: string): boolean {
  return MODEL_NAME.test(line) && BOX_GLYPH.test(line);
}

/** Screen furniture that the TUI repaints while idle. */
function isReadyChrome(line: string): boolean {
  const trimmed = line.trim();
  return (
    BOX_CHROME.test(trimmed) ||
    isReadyComposer(line) ||
    isModelFooter(line) ||
    WELCOME_CHROME.test(line) ||
    RECAP_LINE.test(line) ||
    COMPLETION_LINE.test(line)
  );
}

/**
 * Grok: blank viewport rows keep a scrollbar block, which is removed first.
 * The question card replaces the ready composer at the bottom; a card that
 * has scrolled above the composer, or that later activity follows, is no
 * longer current. A `Worked for` line ends the previous turn.
 */
export class GrokStatusAdapter extends RuleBasedStatusAdapter {
  readonly harnessId = 'grok';
  readonly displayName = 'Grok Status Adapter';

  prepareLines(rawLines: string[], { rules }: LinePreparationContext): string[] {
    let lines = rawLines
      .filter((line) => !SCROLLBAR_ROW.test(line))
      .map(stripTrailingScrollbar);

    let card = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (QUESTION_CARD_HEADER.test(lines[i])) {
        card = i;
        break;
      }
    }
    if (card >= 0) {
      const workingRules = rules.filter((rule) => rule.state === 'working');
      const later = lines.slice(card + 1);
      const replaced = later.some(isReadyComposer);
      const resumed = later.some((line) =>
        !QUESTION_CARD_LINE.test(line) && workingRules.some((rule) => ruleMatchesLine(rule, line))
      );
      if (replaced || resumed) {
        lines = later;
      }
    }

    for (let i = lines.length - 1; i >= 0; i--) {
      if (COMPLETION_LINE.test(lines[i])) {
        lines = lines.slice(i);
        break;
      }
    }
    // The composer is always repainted, so it only shows a ready Grok when
    // nothing newer than the last completion (or the welcome panel) is on
    // screen. Otherwise it and the older marker are removed, and other rules
    // or the fallback decide.
    if (lines.some((line) => !isReadyChrome(line))) {
      return lines.filter((line) => !isReadyComposer(line) && !COMPLETION_LINE.test(line));
    }
    return lines;
  }
}
