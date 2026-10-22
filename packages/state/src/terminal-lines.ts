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
