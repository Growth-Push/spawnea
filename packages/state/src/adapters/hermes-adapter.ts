import type { CompiledStateRule } from '../rules/rule-config.js';
import { ruleMatchesLine } from '../rules/rule-config.js';
import { RuleBasedStatusAdapter } from './rule-based-adapter.js';
import type { LinePreparationContext } from './types.js';

const HERMES_MENU = /Hermes(?:\s+Agent)?\s+needs your input|to select,\s*Enter to (?:confirm|lock)|Tab next question/i;
const HERMES_PROGRESS = /\b(?:formulating|pondering|reviewing|searching|executing|synthesizing|generating)\.{2,3}/i;
const HERMES_INTERRUPT = /msg=interrupt|\/steer|\/queue|Ctrl\+C cancel|enter interrupt · tab queue|type to redirect this turn/i;
const HERMES_STOPWATCH = /[|│]\s*⏱\s*\d+/;
const HERMES_QUESTION_PROMPT = /^\s*\?\s*[>❯›][^a-zA-Z0-9]*$/;
const HERMES_IDLE_CHECK = /^\s*[⚕☤][^\n]*[|│·]\s*✓\s*\d+(?:ms|[smh])(?:\s|$)/i;
const HERMES_CONSULTATION_QUESTION = /^\s*[❓❔]\s*(?:Q\d+|QN\d+|Pregunta\s*\d+|Question\s*\d+)\s*[-—:]?\s*\S/i;
const HERMES_USER_TURN = /^\s*(?:User answered:|[a-zA-Z0-9_.\-/]+\s*>\s*[^\s])/i;

/**
 * A choice footer stays in the scrollback after the menu closes. A later
 * progress verb, interrupt footer, or completion checkmark is the current
 * turn; evaluation starts there. The stopwatch painted under an open menu is
 * not newer activity.
 */
function dropClosedMenu(lines: string[]): string[] {
  let footer = -1;
  for (let i = 0; i < lines.length; i++) {
    if (HERMES_MENU.test(lines[i])) {
      footer = i;
    }
  }
  if (footer < 0) {
    return lines;
  }
  for (let i = lines.length - 1; i > footer; i--) {
    const line = lines[i].trim();
    if (HERMES_QUESTION_PROMPT.test(line)) {
      continue;
    }
    if (HERMES_STOPWATCH.test(line) && !HERMES_INTERRUPT.test(line)) {
      continue;
    }
    if (HERMES_PROGRESS.test(line) || HERMES_INTERRUPT.test(line) || HERMES_IDLE_CHECK.test(line)) {
      return lines.slice(i);
    }
  }
  return lines;
}

/**
 * A consultation question is answered once the user submits a turn after it,
 * and superseded by later work or errors. Evaluation then starts after it.
 */
function dropAnsweredQuestion(lines: string[], rules: readonly CompiledStateRule[]): string[] {
  let question = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HERMES_CONSULTATION_QUESTION.test(lines[i])) {
      question = i;
      break;
    }
  }
  if (question < 0) {
    return lines;
  }
  const after = lines.slice(question + 1);
  for (let i = after.length - 1; i >= 0; i--) {
    if (HERMES_USER_TURN.test(after[i])) {
      return after.slice(i + 1);
    }
  }
  const progressed = after.some((line) =>
    rules.some((rule) => (rule.state === 'working' || rule.state === 'error') && ruleMatchesLine(rule, line))
  );
  return progressed ? after : lines;
}

export class HermesStatusAdapter extends RuleBasedStatusAdapter {
  readonly harnessId = 'hermes';
  readonly displayName = 'Hermes Agent Adapter';

  prepareLines(lines: string[], { rules }: LinePreparationContext): string[] {
    const current = dropAnsweredQuestion(dropClosedMenu(lines), rules);
    // The metrics-bar checkmark prints below the turn it ends, so activity
    // lines above it are historical while questions in that turn remain.
    let check = -1;
    for (let i = current.length - 1; i >= 0; i--) {
      if (HERMES_IDLE_CHECK.test(current[i])) {
        check = i;
        break;
      }
    }
    if (check < 0) {
      return current;
    }
    const workingRules = rules.filter((rule) => rule.state === 'working');
    return current.filter((line, index) =>
      index >= check || !workingRules.some((rule) => ruleMatchesLine(rule, line))
    );
  }
}
