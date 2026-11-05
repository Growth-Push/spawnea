/**
 * ANSI escape sequence regex matching standard VT100/xterm control codes.
 */
const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/**
 * Strips ANSI escape sequences and normalizes terminal line content.
 */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, '');
}

/** Strips ANSI sequences and trailing whitespace, then drops blank lines. */
export function cleanTailLines(tailLines: readonly string[]): string[] {
  return tailLines
    .map((line) => stripAnsi(line).trimEnd())
    .filter((line) => line.trim().length > 0);
}

const CODEX_EDITABLE_PROMPT = /^›(?:\s|$)/;
const CODEX_MENU_SELECTOR = /^›\s*\d+\.\s/;
const CODEX_INDENTED_MENU_SELECTOR = /^\s+[›❯]\s*\d+\.\s/;
const CODEX_COMPOSER_FOOTER = /\?\s+for shortcuts/i;
const CODEX_READY_PLACEHOLDER = /^›\s*(?:Ask Codex to do anything)?$/;
const CODEX_TOOL_HEADER = /^(•\s+(?:Ran|Running|Called|Calling))\b.*$/;
// A running tool keeps Codex's live elapsed/interrupt suffix after its command.
const CODEX_LIVE_ACTIVITY_SUFFIX = /\s(\(\s*\d[^()]*•\s*esc to interrupt\s*\))\s*$/i;
const CODEX_TOOL_COMMAND_CONTINUATION = /^\s+│/;
const CODEX_TOOL_OUTPUT_START = /^\s+└/;
const CODEX_TOOL_OUTPUT_CONTINUATION = /^\s{4,}\S/;

/**
 * True when the lines below a submitted `›` prompt are a live dialog (an
 * indented numbered selector, such as an approval menu) rather than the
 * composer. The composer always renders its footer below the draft.
 */
function isCodexLiveDialog(linesBelowPrompt: string[]): boolean {
  const selector = linesBelowPrompt.findIndex((line) => CODEX_INDENTED_MENU_SELECTOR.test(line));
  return selector >= 0 && !linesBelowPrompt.slice(selector).some((line) => CODEX_COMPOSER_FOOTER.test(line));
}

/**
 * Returns the Codex lines that can carry live status signals.
 *
 * Tool content is quoted: the command after a `• Ran`/`• Called` header (the
 * header verb, and a running tool's live `(… • esc to interrupt)` suffix, stay
 * as an agent entry), `│` command continuation lines, and an
 * indented `└` output block with its deeper-indented (four or more spaces)
 * continuation. When the last column-0 line is the `›` input prompt and no live
 * dialog follows it, its draft text, indented draft lines, and the footer below
 * it are an unsent draft and UI chrome; they are reduced to a bare `›` (the
 * empty placeholder is kept verbatim for reporting).
 *
 * Pass the whole available tail: an output block whose `└` opener has been cut
 * off cannot be recognized.
 */
export function codexSignalLines(lines: string[]): string[] {
  let lastColumnZero = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\S/.test(lines[i])) {
      lastColumnZero = i;
      break;
    }
  }
  const promptLine = lastColumnZero >= 0 ? lines[lastColumnZero] : '';
  const hasEditablePrompt =
    CODEX_EDITABLE_PROMPT.test(promptLine) &&
    !CODEX_MENU_SELECTOR.test(promptLine) &&
    !isCodexLiveDialog(lines.slice(lastColumnZero + 1));
  const transcriptEnd = hasEditablePrompt ? lastColumnZero : lines.length;

  const signalLines: string[] = [];
  let inToolOutput = false;
  for (let i = 0; i < transcriptEnd; i++) {
    const line = lines[i];
    if (CODEX_TOOL_OUTPUT_START.test(line) || CODEX_TOOL_COMMAND_CONTINUATION.test(line)) {
      inToolOutput = true;
      continue;
    }
    if (inToolOutput && CODEX_TOOL_OUTPUT_CONTINUATION.test(line)) {
      continue;
    }
    inToolOutput = false;
    const header = line.match(CODEX_TOOL_HEADER);
    const liveSuffix = header ? line.match(CODEX_LIVE_ACTIVITY_SUFFIX) : null;
    signalLines.push(header ? (liveSuffix ? `${header[1]} ${liveSuffix[1]}` : header[1]) : line);
  }
  if (hasEditablePrompt) {
    signalLines.push(CODEX_READY_PLACEHOLDER.test(promptLine) ? promptLine : '›');
  }
  return signalLines;
}

/**
 * Trims the live editable composer and its footer from a Codex tail.
 * Returns the transcript lines up to the start of the live composer.
 */
export function stripCodexComposerTail(lines: string[]): string[] {
  let lastColumnZero = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\S/.test(lines[i])) {
      lastColumnZero = i;
      break;
    }
  }
  if (lastColumnZero < 0) return lines;
  const promptLine = lines[lastColumnZero];
  const hasEditablePrompt =
    CODEX_EDITABLE_PROMPT.test(promptLine) &&
    !CODEX_MENU_SELECTOR.test(promptLine) &&
    !isCodexLiveDialog(lines.slice(lastColumnZero + 1));
  if (hasEditablePrompt) {
    return lines.slice(0, lastColumnZero);
  }
  return lines;
}

const CLAUDE_INPUT_BOX_BORDER = /^\s*─{3,}\s*$/;
const CLAUDE_INPUT_LINE = /^\s*[>❯](?!\s*(?:\d+[.)]|[a-zA-Z][.)]|\[[0-9a-zA-Z]\]|\([0-9a-zA-Z]\))\s+)/;
const CLAUDE_MODE_FOOTER = /^\s*⏵⏵[^\n]*\b(?:auto\s+mode|plan\s+mode|accept edits(?:\s+mode)?|bypass permissions(?:\s+mode)?)\s+on\b/i;
const CLAUDE_PROMPT_CHROME = /^\s*(?:\?|\/)\s+(?:for\s+(?:commands|shortcuts|help)|help)\b|^\s*(?:esc|ctrl|\(shift|bypass permissions|auto mode|plan mode)\b/i;

function isTrailingClaudeChrome(lines: string[]): boolean {
  return lines.every((l) => {
    const trimmed = l.trim();
    if (trimmed.length === 0) return true;
    if (CLAUDE_INPUT_BOX_BORDER.test(l)) return true;
    if (CLAUDE_MODE_FOOTER.test(l)) return true;
    if (CLAUDE_PROMPT_CHROME.test(l)) return true;
    if (/^[A-Za-z0-9.\s]+(?:\|[A-Za-z0-9.\s%]+)+$/.test(trimmed)) return true;
    return false;
  });
}

/**
 * Trims the live editable composer, input box borders, and UI chrome from a Claude tail.
 * Returns the transcript lines up to the start of the live composer.
 */
export function stripClaudeComposerTail(lines: string[]): string[] {
  // Check for a trailing bordered input box
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CLAUDE_INPUT_BOX_BORDER.test(lines[i])) {
      const closingIdx = lines.findIndex((l, idx) => idx > i && CLAUDE_INPUT_BOX_BORDER.test(l));
      if (closingIdx !== -1) {
        const insideBox = lines.slice(i + 1, closingIdx);
        const hasPrompt = insideBox.some((l) => CLAUDE_INPUT_LINE.test(l));
        const afterBox = lines.slice(closingIdx + 1);
        if (hasPrompt && isTrailingClaudeChrome(afterBox)) {
          return lines.slice(0, i);
        }
      }
    }
  }

  // Check for trailing unsubmitted prompt at EOF
  let lastPromptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CLAUDE_INPUT_LINE.test(lines[i])) {
      lastPromptIdx = i;
      break;
    }
  }
  if (lastPromptIdx >= 0) {
    const linesBelow = lines.slice(lastPromptIdx + 1);
    if (isTrailingClaudeChrome(linesBelow)) {
      const prevIdx = lastPromptIdx - 1;
      if (prevIdx >= 0 && CLAUDE_INPUT_BOX_BORDER.test(lines[prevIdx])) {
        return lines.slice(0, prevIdx);
      }
      return lines.slice(0, lastPromptIdx);
    }
  }

  return lines;
}
