import { ruleMatchesLine } from '../rules/rule-config.js';
import { RuleBasedStatusAdapter, STATE_RULE_WINDOW_LINES, trimSupersededErrors } from './rule-based-adapter.js';
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
const COMPOSER_PROMPT = /^\s*[│|]\s*[❯›>](?:\s|[│|]|$)/;
const FRAMED_WELCOME_CONTENT = /^[\s\u2800-\u28ff]*(?:Grok Build\s+\d|Tool Call Density\b|Choose how much of each tool call\b|New worktree\s+ctrl\+w|Resume session\s+ctrl\+r|Changelog\s*$|Quit\s+ctrl\+q|Tip:|Update: v|(?:[◆●▶]\s+)?Recap\b)/i;
const SERVER_RETRY_LINE = /^\s*(?:[│|]\s*)?(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◆●▶]\s+)?Server error\s+\(500\)\s*\|\s*Retrying\b/i;
// Retry timers, spinners and interrupt controls are redrawn during a failure.
// They do not establish that the provider has resumed producing a response.
const RETRY_CHROME = /^(?:\s|[│|])*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?:\s|$)|^\s*(?:esc to interrupt|send a message to interrupt|Ctrl\+c:cancel)\s*$|^\s*\[stop\]\s*$|^\s*\d[\d.smh :]*$/i;
const BUSY_LABEL = /^(?:[◆●▶]\s+)?(?:Running|Responding|Generating)\b/i;
const EXAMPLE_CONTEXT = /\b(?:examples?|samples?|quoted|quotes?|quotations?)\b|\bfor instance\b/i;
const PROSE_CONTEXT = /^(?:here(?:['’]s)?|an?|another|some|the|for|this|these|see|consider|below|in this)\s/i;
const EXAMPLE_LABEL = /^(?:examples?|samples?|quotes?|quotations?)\b/i;
const CODE_CONTEXT = /^(?:(?:const|let|var)\s+[\w$]+\s*[=:]|(?:def|class|function)\s+[\w$]+[^\S\n]*[(:]|(?:if|elif|else|for|while|switch|case|return|import|export)\b|[\w$.]+[^\S\n]*[=({])/i;
const BRANCH_HEADER = /^(?:\uE0A0[^\S\n]*)?[\w./-]+[^\S\n]+[~/]\S*/;

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

/** Trim frame decoration without scanning each internal whitespace suffix. */
function unframe(line: string): string {
  let content = line.trim();
  if (content[0] === '│' || content[0] === '|') content = content.slice(1).trimStart();
  if (content.endsWith('│') || content.endsWith('|')) content = content.slice(0, -1).trimEnd();
  return content;
}

function fenceContent(line: string): string {
  let content = unframe(line);
  let marker: RegExpExecArray | null;
  while ((marker = /^(?:[-+*]|\d+[.)])\s+/.exec(content))) {
    content = content.slice(marker[0].length).trimStart();
  }
  return content;
}

/** Introduction prose can wrap across captured terminal rows. */
function hasExampleIntroduction(lines: readonly string[], fence: number): boolean {
  const last = fenceContent(lines[fence - 1] ?? '').replace(/[*_`]/g, '');
  let prose = last.endsWith(':');
  let example = false;
  for (let i = fence - 1; i >= 0; i--) {
    const raw = fenceContent(lines[i]);
    const heading = /^#{1,6}\s+/.test(raw) || ['**', '__'].some((marker) =>
      raw.startsWith(marker) && (raw.endsWith(marker) || raw.endsWith(`${marker}:`))
    );
    const content = raw.replace(/^#{1,6}\s+/, '').replace(/[*_`]/g, '');
    if (!content || BOX_CHROME.test(content) || COMPLETION_LINE.test(content) || BRANCH_HEADER.test(content) || /^[>❯›◆●▶○◈\u2800-\u28ff]/.test(content)) break;
    const proseFor = /^for (?:example|instance)(?=$|[,:]|\s+(?!(?:in|of)\b))/i.test(content);
    if (CODE_CONTEXT.test(content) && !proseFor && !heading) break;
    prose ||= PROSE_CONTEXT.test(content) || EXAMPLE_LABEL.test(content) || heading;
    example ||= EXAMPLE_CONTEXT.test(content);
    if (prose && example) return true;
  }
  return false;
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

/** A framed response is content; only specific framed controls are chrome. */
function isRecoveryContent(line: string): boolean {
  if (isReadyComposer(line) || isModelFooter(line) || BOX_CHROME.test(line.trim())) return false;
  if (isReadyChrome(line) && !/^\s*[│|]/.test(line)) return false;
  const content = unframe(line);
  const header = BRANCH_HEADER.exec(content);
  if (header) {
    const suffix = content.slice(header[0].length).trim();
    if (!suffix || suffix.endsWith('[Dashboard]')) return false;
  }
  const label = BUSY_LABEL.exec(content);
  if (label) {
    const detail = content.slice(label[0].length).trim().replace(/\[stop\]$/i, '')
      .replace(/[⇣⇡↑↓]\s*\d+(?:\.\d+)?[kmb]?|\[[↑↓]\]/gi, '').trim();
    if (!detail || /^[\d.smh :.…()•·|+-]+$/i.test(detail) && /\d/.test(detail) || /^(?:\.{3}|…)$/.test(detail)) return false;
  }
  return content.length > 0 && !FRAMED_WELCOME_CONTENT.test(content) && !RETRY_CHROME.test(content);
}

/** Remove the whole unsent draft before it can supply any state evidence. */
function withoutComposerDraft(lines: string[]): string[] {
  let end = lines.length;
  let latestPrompt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (latestPrompt < 0 && COMPOSER_PROMPT.test(lines[i])) latestPrompt = i;
    if (/^\s*[╰└]/.test(lines[i]) && isModelFooter(lines[i])) { end = i; break; }
  }
  if (latestPrompt > end) end = lines.length;
  while (end > 0 && (BOX_CHROME.test(lines[end - 1].trim()) || isReadyComposer(lines[end - 1]) && !COMPOSER_PROMPT.test(lines[end - 1]))) end--;
  let composer = -1;
  for (let i = end - 1; i >= 0 && /^\s*[│|]/.test(lines[i]); i--) {
    if (COMPOSER_PROMPT.test(lines[i])) composer = i;
  }
  if (composer < 0) return lines;
  const draft = lines.slice(composer, end).some((line, index) => {
    const content = unframe(line);
    return (index === 0 ? content.replace(/^[❯›>]\s*/, '') : content).trim().length > 0;
  });
  return draft ? lines.filter((_line, index) => index < composer || index >= end) : lines;
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
  protected override readonly trimsSupersededErrors = false;

  prepareLines(rawLines: string[], { rules }: LinePreparationContext): string[] {
    let lines = rawLines
      .filter((line) => !SCROLLBAR_ROW.test(line))
      .map(stripTrailingScrollbar);
    lines = withoutComposerDraft(lines);
    // Exclude retry examples inside fences while retaining response content
    // that can establish recovery. A bare unmatched fence may close a block
    // whose opener is outside the bounded tail; keep its following live rows.
    let fence: string | undefined;
    lines = lines.filter((line, index, all) => {
      const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(fenceContent(line));
      const marker = match?.[1];
      if (marker) {
        if (fence) {
          if (marker[0] === fence[0] && marker.length >= fence.length && !match![2].trim()) fence = undefined;
        } else if (match![2].trim() || hasExampleIntroduction(all, index) || all.slice(index + 1).some((later) => {
          const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(fenceContent(later))?.[1];
          return closing && closing[0] === marker[0] && closing.length >= marker.length;
        })) {
          fence = marker;
        }
        return false;
      }
      return !fence || !SERVER_RETRY_LINE.test(line);
    });

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
    const errorRules = rules.filter((rule) => rule.state === 'error');
    let error = -1;
    for (let i = 0; i < lines.length; i++) {
      if (SERVER_RETRY_LINE.test(lines[i]) && errorRules.some((rule) => ruleMatchesLine(rule, lines[i]))) error = i;
    }
    let currentRetry = false;
    if (error >= 0) {
      const later = lines.slice(error + 1);
      const recovered = later.some(isRecoveryContent);
      // Retain user-rule precedence and the original error line. Busy chrome
      // after it cannot let the shared superseded-error trim erase it.
      lines = recovered ? later : [lines[error], ...later.slice(-(STATE_RULE_WINDOW_LINES - 1))];
      currentRetry = !recovered;
    }
    // The composer is always repainted, so it only shows a ready Grok when
    // nothing newer than the last completion (or the welcome panel) is on
    // screen. Otherwise it and the older marker are removed, and other rules
    // or the fallback decide.
    if (lines.some((line) => !isReadyChrome(line))) {
      lines = lines.filter((line) => !isReadyComposer(line) && !COMPLETION_LINE.test(line));
    }
    return currentRetry ? lines : trimSupersededErrors(lines.slice(-STATE_RULE_WINDOW_LINES), rules);
  }
}
