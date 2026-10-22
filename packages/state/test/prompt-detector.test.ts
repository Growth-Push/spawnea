import { describe, it, expect } from 'vitest';
import { stripAnsi, detectPromptInTail, codexSignalLines } from '../src/prompt-detector.js';
import { loadStateRules } from '../src/rules/load-state-rules.js';

function userRules(yaml: string) {
  return loadStateRules({ userFilePath: '/fictional/user-data/state-rules.yaml', readFile: () => yaml }).ruleSet;
}

describe('prompt-detector', () => {
  it('strips ANSI color and cursor codes cleanly', () => {
    const rawAnsi = '\u001b[32m✔ Success\u001b[0m: \u001b[1mDo you want to proceed? [y/N]\u001b[0m';
    const cleaned = stripAnsi(rawAnsi);
    expect(cleaned).toBe('✔ Success: Do you want to proceed? [y/N]');
  });

  it('treats later agent activity as current after a failed background command', () => {
    const tail = [
      '● Background command "Set up screenshot capture" failed with exit code 144',
      'Called chrome-devtools 2 times, ran 1 shell command',
      '✽ Wibbling… (3m 52s · ↓ 8.8k tokens)',
      '❯',
      '⏵⏵ auto mode on · esc to interrupt',
    ];

    const result = detectPromptInTail(tail, { harness: 'zsh' });

    expect(result.kind).toBe('working');
    expect(result.promptLine).toContain('Wibbling');
  });

  it('prefers later confirmation prompt over preceding error and working lines', () => {
    const tail = [
      '● Background command "Set up screenshot capture" failed with exit code 144',
      'Called chrome-devtools 2 times, ran 1 shell command',
      '✽ Wibbling… (3m 52s · ↓ 8.8k tokens)',
      'Do you want to proceed? [y/N]',
    ];

    const result = detectPromptInTail(tail, { harness: 'zsh' });

    expect(result.isPrompt).toBe(true);
    expect(result.kind).toBe('needs_input');
    expect(result.promptLine).toContain('Do you want to proceed? [y/N]');
  });

  it('detects confirmation prompts ([y/N], (y/n), proceed?)', () => {
    const tail1 = [
      'Applying database migrations...',
      'Table "users" will be altered.',
      'Do you want to continue? [y/N]: ',
    ];
    const res1 = detectPromptInTail(tail1);
    expect(res1.isPrompt).toBe(true);
    expect(res1.kind).toBe('needs_input');
    expect(res1.promptLine).toContain('Do you want to continue? [y/N]');

    const tail2 = [
      '\u001b[33mWarning: destructive change\u001b[0m',
      'Proceed? (y/n)',
    ];
    const res2 = detectPromptInTail(tail2);
    expect(res2.isPrompt).toBe(true);
    expect(res2.kind).toBe('needs_input');
  });

  it('detects choice selection prompts', () => {
    const tail = [
      'Multiple harnesses available:',
      '1) Claude Code',
      '2) Hermes Agent',
      'Select an option: ',
    ];
    const res = detectPromptInTail(tail);
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
    expect(res.promptLine).toContain('Select an option:');
  });

  it('detects the canonical Antigravity interactive questionnaire menu', () => {
    const tail = [
      '? Which architectural approach would you like to proceed with for the database migration refactor?',
      'Question',
      '',
      'Question 1/1: Which architectural approach would you like to proceed with for the database migration refactor?',
      '> 1. (Recommended) Approach 1: Domain-Driven Modular Schemas (Namespace isolation by domain)',
      '  2. Approach 2: Linear Expand-Contract Schema (Unified namespace with zero-downtime phases)',
      '  3. Write-in...',
      '',
      '  ↑/↓ Navigate · enter Select · esc Skip',
      '  esc to cancel',
    ];
    const res = detectPromptInTail(tail, { harness: 'antigravity' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
  });

  it('detects the canonical Antigravity tool permission prompt', () => {
    const tail = [
      'Requesting permission for:',
      '  git log -n 10 --oneline --graph --decorate && git count-objects -vH',
      '',
      'Do you want to proceed?',
      '> 1. Yes',
      '  2. Yes, and always allow in this conversation',
      '  3. No',
      '',
      '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command',
      '  esc to cancel',
    ];
    const res = detectPromptInTail(tail, { harness: 'antigravity' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
  });

  it('detects the canonical Antigravity file edit acceptance prompt', () => {
    const tail = [
      '• Edit(/workspace/spawnea/packages/state/src/rules/default-rules.ts) (ctrl+o to expand)',
      'Pending edit',
      '',
      '  shift+tab to auto-approve file edits',
      'Accept this file edit?',
      '> 1. Yes, accept this change',
      '  2. No, reject this change',
      '',
      '  ↑/↓ Navigate · tab Amend · f full diff',
      'esc to cancel',
    ];
    const res = detectPromptInTail(tail, { harness: 'antigravity' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
    expect(res.promptLine).toBe('Accept this file edit?');
  });

  it('detects the canonical Antigravity working Braille spinner and cancel footer', () => {
    const tail = [
      '• Thought for 5s, 657 tokens',
      '  Analyzing Tab Behavior',
      '',
      '• Read(/workspace/spawnea/apps/desktop/src/renderer/src/components/TerminalView.tsx) (ctrl+o to expand)',
      '⣯ Analyzing Banner Behavior...',
      '└ Tip: Use /skills to browse and manage agent skills.',
      '',
      '> []',
      'esc to cancel',
    ];
    const res = detectPromptInTail(tail, { harness: 'antigravity' });
    expect(res.kind).toBe('working');
  });

  it('detects the canonical Antigravity idle ready prompt', () => {
    const tail = [
      'Task execution complete.',
      '> ',
      '? for shortcuts',
    ];
    const res = detectPromptInTail(tail, { harness: 'antigravity' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('idle');
  });

  it('detects Codex CLI option prompt', () => {
    const tail = [
      'Please confirm one option:',
      '- A: Clean reproducible dependencies and artifacts only.',
      '- B: Clean those plus .references/.',
      '- C: Make no changes.',
      '',
      '> Ask Codex to do anything',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
  });

  it('detects Codex Plan mode questionnaires as a choice prompt', () => {
    const tail = [
      'Question 2/2 (1 unanswered)',
      'Should ignored-only files count as local changes for showing the stash option?',
      '› 1. No, match Git view (Recommended)  Only tracked or untracked changes trigger the choices.',
      '  2. Yes, include ignored  Ignored files also trigger the stash choice.',
      '  3. None of the above  Optionally, add details in notes (Tab).',
      'tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt',
    ];

    const res = detectPromptInTail(tail, { harness: 'codex' });

    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
    expect(res.promptLine).toContain('Question 2/2');
  });

  it('treats a questionnaire navigation footer as a Codex input request, not working activity', () => {
    const res = detectPromptInTail(
      ['tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt'],
      { harness: 'codex' }
    );

    // The footer alone identifies an open questionnaire whose header and
    // selected option may be outside the evaluation window.
    expect(res.kind).toBe('needs_input');
  });

  it('detects Codex CLI active working progress and interrupt line', () => {
    const tail = [
      '• Explored',
      '  └ Read deploy.sh, decision_log.md, compose.sh, env.example, README.md',
      '',
      '• Working (1m 02s • esc to interrupt)',
      '',
      '› Ask Codex to do anything',
      '  gpt-5.6-sol medium · weekly 93% left · 258K window · 176K used · Fast off · Context 45% left',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.kind).toBe('working');
    expect(res.promptLine).toContain('Working');
  });

  it('detects Codex CLI idle prompt when not asking options', () => {
    const tail = [
      'All tests passed successfully.',
      '> Ask Codex to do anything',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('idle');
  });

  it('detects modern Codex tool approval prompt (Allow / Deny)', () => {
    const tail = [
      'Codex wants to execute bash command:',
      '  git push origin main',
      '❯ 1. Allow once',
      '  2. Always allow',
      '  3. Deny',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
  });

  it('detects modern Codex interactive arrow selection menu with ❯', () => {
    const tail = [
      'Choose an option:',
      '❯ 1. First approach',
      '  2. Second approach',
      '↑/↓ to navigate · Enter to select',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
  });

  it('detects modern Codex CLI Braille spinner as active working', () => {
    const tail = [
      'Resolving files...',
      '⠋ Thinking... (12s)',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(false);
    expect(res.kind).toBe('working');
  });

  it('detects modern Codex reasoning header as active working', () => {
    const tail = [
      '┌ Reasoning ───────────────────────────────',
      'Thinking through the implementation steps...',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(false);
    expect(res.kind).toBe('working');
  });

  it('detects modern Codex plan confirmation', () => {
    const tail = [
      'Review the migration plan above.',
      'Do you want to proceed with this plan?',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
  });

  it('detects modern Codex idle input prompt with ❯ and Ask anything', () => {
    const tail = [
      'Done!',
      '❯ Ask anything, or type / for commands',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('idle');
  });

  it('detects modern Codex v0.160+ queued follow-up question requiring shift+← to answer', () => {
    const tail = [
      '• Which color do you prefer for this test?',
      '',
      '  • Blue',
      '  • Green',
      '  • Red',
      '',
      'Working (19s • esc to interrupt)',
      '',
      '• Queued follow-up inputs',
      '  ? 1 question · 14s',
      '    shift+← to answer',
      '',
      '› Ask Codex to do anything',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
    expect(res.promptLine).toMatch(/shift\+← to answer|\? 1 question/);
  });

  it('detects modern Codex queued follow-up with shift-left to answer variation', () => {
    const tail = [
      '• Queued follow-up inputs',
      '  ? 2 questions · 5s',
      '    shift-left to answer',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
  });

  it('detects modern Codex queued follow-up with multiple questions and minute/hour durations', () => {
    const tailMinutes = [
      '• Queued follow-up inputs',
      '  ? 3 questions · 4m 12s',
      '    shift+← to answer',
    ];
    const resMin = detectPromptInTail(tailMinutes, { harness: 'codex' });
    expect(resMin.isPrompt).toBe(true);
    expect(resMin.kind).toBe('needs_input');

    const tailHours = [
      '• Queued follow-up inputs',
      '  ? 2 questions · 1h 30m',
      '    shift+← to answer',
    ];
    const resHr = detectPromptInTail(tailHours, { harness: 'codex' });
    expect(resHr.isPrompt).toBe(true);
    expect(resHr.kind).toBe('needs_input');
  });

  it('detects modern Codex question with bullet options', () => {
    const tail = [
      '• Which deployment target would you prefer?',
      '  • Staging',
      '  • Production',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
  });

  it('detects modern Codex v0.160+ open questionnaire menu after pressing shift-left', () => {
    const tail = [
      'Working (1m 08s • esc to interrupt)',
      '• Queued follow-up inputs',
      '',
      '  Which color do you prefer for this test?',
      '',
      '  › 1. Blue',
      '    2. Green',
      '    3. Red',
      '    4. Other',
      '',
      '  enter submit   ctrl+] skip   shift+→ main prompt',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
  });

  it('detects modern Codex queued question with no time suffix', () => {
    const tail = [
      '• Queued follow-up inputs',
      '  ? 4 questions',
      '    shift+← to answer',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
  });

  it('detects modern Codex queued question with ascii arrow shift+<- to answer', () => {
    const tail = [
      '• Queued follow-up inputs',
      '  ? 1 question · 10s',
      '    shift+<- to answer',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
  });

  it('detects modern Codex questionnaire when option 2 or 3 is selected', () => {
    const tail = [
      '• Queued follow-up inputs',
      '  Which architecture pattern to use?',
      '    1. Monolith',
      '  › 2. Microservices',
      '    3. Modular Monolith',
      '  enter submit   ctrl+] skip   shift+→ main prompt',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
    expect(res.promptLine).toContain('Microservices');
  });

  it('detects modern Hermes idle input prompt with ❯ and Ask anything', () => {
    const tail = [
      'All changes applied.',
      '❯ Ask anything, or type / for commands…',
    ];
    const res = detectPromptInTail(tail, { harness: 'hermes' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('idle');
  });

  it('detects command execution errors in terminal tail', () => {
    const tail = [
      'Running pnpm test...',
      'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL @spawnea/desktop@0.0.0 test: vitest run',
      'Exit status 1',
    ];
    const res = detectPromptInTail(tail);
    expect(res.kind).toBe('error');
  });

  it('detects shell prompts', () => {
    const tail = [
      'Task completed.',
      'developer@example-host:~/code/Spawnea$ ',
    ];
    const res = detectPromptInTail(tail);
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('idle');
  });

  it('detects a multilingual Hermes interactive question/choice prompt', () => {
    const tail = [
      '┌ Hermes needs your input ─────────────────────────',
      '¿Qué estrategia querés aplicar?',
      '❯ 1. Opción 1',
      '  2. Opción 2',
      '↑/↓ to select, Enter to confirm (112s)',
      '? >',
    ];
    const res = detectPromptInTail(tail, { harness: 'hermes' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
  });

  it('detects the Hermes Agent choice menu while the metrics stopwatch is still painted', () => {
    const tail = [
      '╭─ Hermes Agent needs your input ──────────────────────────────────╮',
      '│ 1 question                                                       │',
      '│ ▸ Which sample option should stay selected?                     │',
      '│   ❯ 1. Keep the current choice                                  │',
      '│     2. Switch to the other sample                               │',
      '│     3. Other (type your answer)                                  │',
      '╰──────────────────────────────────────────────────────────────────╯',
      '  ❓ Which sample option should stay selected?',
      '  ↑/↓ to select, Enter to lock, Tab next question  (12s)',
      ' ☤ example-model │ 10K/100K │ [███░░░░░░░] 27% │ ⏱21 43s',
      '──────────────────────────────────────────────────────────────────',
      '? ❯',
    ];
    const res = detectPromptInTail(tail, { harness: 'hermes' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
    expect(res.promptLine).not.toContain('example-model');
  });

  it('lets a later progress verb replace a stale Hermes choice footer', () => {
    const tail = [
      '  ↑/↓ to select, Enter to lock, Tab next question  (12s)',
      'formulating...',
    ];
    const res = detectPromptInTail(tail, { harness: 'hermes' });
    expect(res.kind).toBe('working');
    expect(res.promptLine).toBe('formulating...');
  });

  it('detects a Hermes ? ❯ prompt that remains under the metrics stopwatch', () => {
    const tail = [
      ' ☤ example-model │ 10K/100K │ [███░░░░░░░] 27% │ ⏱21 43s',
      '? ❯',
    ];
    const res = detectPromptInTail(tail, { harness: 'hermes' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
    expect(res.promptLine).toBe('? ❯');
  });

  it('detects a Hermes consultation question with emoji Q3 / QN3', () => {
    const tail = [
      'La tabla debe vivir en algo similar a HarnessLaunchRegistry.',
      '',
      '❓ Q3 — Precedencia del modelo: si el harness ya tiene un modelo dentro de sus args configurados y el MCP también envía model, ¿cuál debe prevalecer?',
      '',
      '➡️ Recomiendo que el model explícito de la solicitud reemplace el argumento...',
      '╰───────────────────────────────────────────────────────────────────╯',
      ' ⚕ gpt-5.6-sol │ 112K/272K │ [████░░░░░░] 41% │ ✓ 0s',
      '❯ Ask anything, or type / for commands…',
    ];
    const res = detectPromptInTail(tail, { harness: 'hermes' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('needs_input');
    expect(res.promptLine).toContain('❓ Q3 — Precedencia del modelo');
  });

  it('detects Hermes turn completed checkmark indicator in metrics bar', () => {
    const tail = [
      'Task completed.',
      ' ⚕ gpt-5.6-sol │ 81K/128K │ [██████░░░░] 63% │ 🗜️ 1 │ 2h │ ⏲ 30s │ ✓ 4m',
      'gp-dev > Draft a reply to the last email in my inbox',
    ];
    const res = detectPromptInTail(tail, { harness: 'hermes' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('idle');
  });

  it('detects the generic Hermes metrics bar without relying on its input prompt', () => {
    const res = detectPromptInTail([
      '⚕ model │ 28K/128K │ [██░░░░░░░░] 22% │ ◎ 79.3% │ ◷ 7.0s │ ↑ 27 t/s │ 🗜️ 2 │ 1h456m │ ⏲ 3m 45s │ ✓40m',
    ], { harness: 'hermes' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('idle');
  });

  it('accepts millisecond completion durations and rejects incomplete Hermes bars', () => {
    const withMilliseconds = detectPromptInTail([
      '⚕ model │ 28K/128K │ ✓9ms',
    ], { harness: 'hermes' });
    expect(withMilliseconds.kind).toBe('idle');

    const withoutMetricsPrefix = detectPromptInTail(['│ ✓9ms'], { harness: 'hermes' });
    expect(withoutMetricsPrefix.kind).not.toBe('idle');

    const withoutCompletionCheckmark = detectPromptInTail([
      '⚕ model │ 28K/128K │ ⏲ 3m 45s',
    ], { harness: 'hermes' });
    expect(withoutCompletionCheckmark.kind).not.toBe('idle');
  });

  it('detects Hermes active execution interrupt footer', () => {
    const tail = [
      'Inspecting files...',
      '⚡ gpt-5.6-sol | 53.9K/128K | [|||||||||||] 42% | 9 1 | 1h 15m | 98s',
      '> msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel',
    ];
    const res = detectPromptInTail(tail, { harness: 'hermes' });
    expect(res.kind).toBe('working');
  });

  it('does not classify historical spinner as working if a shell prompt follows', () => {
    const tail = [
      '✻ Generating test files…',
      'Done generating test files.',
      'user@host:~/code$ ',
    ];
    const res = detectPromptInTail(tail);
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('idle');
  });

  it('lets a later shell prompt supersede an earlier failed command and spinner', () => {
    const tail = [
      '● Background command "Set up screenshot capture" failed with exit code 144',
      '✻ Generating test files…',
      'Done generating test files.',
      'user@host:~/code$ ',
    ];
    const res = detectPromptInTail(tail);
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('idle');
  });

  it('keeps a live Claude spinner working although the input prompt is drawn below it', () => {
    // Real Claude screens always draw the input prompt below the live spinner;
    // the turn ends with the `· done` marker instead.
    const tail = [
      '✻ Generating test files…',
      'Done generating test files.',
      '> Try "npm test"',
    ];
    const res = detectPromptInTail(tail, { harness: 'claude' });
    expect(res.kind).toBe('working');
  });

  it('lets a later idle prompt supersede an earlier failed command when agent is waiting for input', () => {
    const tail = [
      '● Background command "test" failed with exit code 1',
      'The test command failed. Would you like me to fix the test?',
      '> Try "yes, please fix it"',
    ];
    const res = detectPromptInTail(tail, { harness: 'claude' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('idle');
  });

  it.each(['Cooked', 'Crunched', 'Cogitated', 'Brewed'])('detects Claude %s turn completion with a draft and auto mode footer', (verb) => {
    const res = detectPromptInTail([
      'Do you want to proceed? [y/N]',
      '✽ Wibbling…',
      '● Finished the requested changes.',
      `✻ ${verb} for 1m 40s · done 11:42 AM`,
      '',
      '────────────────────────',
      '❯\u00a0merge the pull request',
      '────────────────────────',
      '  ⏵⏵ auto mode on (shift+tab to cycle) · PR #7 · ← for agents',
      '',
    ], { harness: 'claude' });
    expect(res.kind).toBe('idle');
  });

  it('detects a Claude completion marker without an input bar', () => {
    expect(detectPromptInTail(['✻ Brewed for 18s · done 11:42 AM'], { harness: 'claude' }).kind).toBe('idle');
  });

  it.each(['accept edits on', 'bypass permissions on'])('preserves Claude completion with the %s footer', (mode) => {
    const res = detectPromptInTail([
      '✻ Brewed for 27s · done 12:16 PM',
      '────────────────────────',
      '❯ Continue',
      '────────────────────────',
      `⏵⏵ ${mode} (shift+tab to cycle)`,
    ], { harness: 'claude' });
    expect(res.kind).toBe('idle');
  });

  it.each(['accept edits on', 'bypass permissions on'])('detects active interrupt hints in the %s footer', (mode) => {
    const res = detectPromptInTail([
      '✻ Brewed for 27s · done 12:16 PM',
      '❯ Start another task',
      '❯',
      `⏵⏵ ${mode} · esc to interrupt`,
    ], { harness: 'claude' });
    expect(res.kind).toBe('working');
  });

  it('preserves Claude completion with a multiline draft inside input separators', () => {
    const res = detectPromptInTail([
      '✻ Brewed for 27s · done 12:16 PM',
      '────────────────────────',
      '❯ Review the change',
      '  and explain the result',
      '  including the esc to interrupt hint',
      '────────────────────────',
      '⏵⏵ auto mode on (shift+tab to cycle)',
    ], { harness: 'claude' });
    expect(res.kind).toBe('idle');
  });

  it('rejects newer Claude output outside the input separators', () => {
    const res = detectPromptInTail([
      '✻ Brewed for 27s · done 12:16 PM',
      '────────────────────────',
      '❯ Review the change',
      '  and explain the result',
      '────────────────────────',
      '● Read(src/index.ts)',
      '⏵⏵ auto mode on (shift+tab to cycle)',
    ], { harness: 'claude' });
    // The completion marker no longer applies; the empty input box still does.
    expect(res.promptLine).not.toContain('· done');
  });

  it.each([
    ['❯ Start another task', '✽ Wibbling…', '❯', '⏵⏵ auto mode on (shift+tab to cycle)'],
    ['❯ Start another task', '● Read(src/index.ts)'],
    ['❯ Start another task', 'Do you want to proceed? [y/N]'],
    ['❯ Start another task', 'Error: connection refused'],
  ])('does not reuse Claude completion after newer activity: %j', (...suffix) => {
    const res = detectPromptInTail(['✻ Brewed for 18s · done 11:42 AM', ...suffix], { harness: 'claude' });
    expect(res.kind).not.toBe('idle');
  });

  it('rejects transcript output between the input box and a status line', () => {
    const res = detectPromptInTail([
      '✻ Brewed for 27s · done 12:16 PM',
      '────────────────────────',
      '❯ Review the change',
      '────────────────────────',
      '● Read(src/index.ts)',
      '   user  …/projects/example  main',
      '⏵⏵ auto mode on (shift+tab to cycle)',
    ], { harness: 'claude' });
    expect(res.promptLine).not.toContain('· done');
  });

  it.each(['·', '✢', '*', '✳', '✶', '✻', '✽'])('detects the %s Claude spinner frame above an empty input box', (glyph) => {
    const res = detectPromptInTail([
      `${glyph} Hyperspacing… (53s · ↓ 1.3k tokens)`,
      '────────────────────────',
      '❯ ',
      '────────────────────────',
      '⏵⏵ auto mode on · ← for agents',
    ], { harness: 'claude' });
    expect(res.kind).toBe('working');
  });

  it.each(['  * Loading…', '  · Loading…', '* Loading… is shown while files load'])('does not treat transcript text %j as a Claude spinner', (line) => {
    const res = detectPromptInTail(['● Example documentation:', line, '❯', '⏵⏵ auto mode on'], { harness: 'claude' });
    expect(res.kind).toBe('idle');
  });

  it.each([
    ['needs_input', 'Do you want to proceed? [y/N]'],
    ['error', 'Uncaught Error: Authentication failed'],
  ])('lets a newer %s below the input box invalidate Claude completion', (kind, line) => {
    const res = detectPromptInTail([
      '✻ Brewed for 8s · done 11:35 AM',
      '────────────────────────',
      '❯ draft',
      '────────────────────────',
      line,
    ], { harness: 'claude' });
    expect(res.kind).toBe(kind);
  });

  it('bounds the Claude status line below the input box', () => {
    const box = ['✻ Brewed for 8s · done 11:35 AM', '────────────────────────', '❯ draft', '────────────────────────'];
    expect(detectPromptInTail([...box, 'user main ctx 12%', 'second status row', '⏵⏵ auto mode on'], { harness: 'claude' }).promptLine)
      .toContain('· done');
    expect(detectPromptInTail([...box, 'first new line', 'second new line', 'third new line', '⏵⏵ auto mode on'], { harness: 'claude' }).promptLine)
      .not.toContain('· done');
  });

  it('recognizes the empty modern Claude input prompt', () => {
    expect(detectPromptInTail(['❯\u00a0', '⏵⏵ auto mode on (shift+tab to cycle)'], { harness: 'claude' }).kind).toBe('idle');
  });

  it.each(['esc to interrupt', 'Esc to cancel', 'Ctrl+C cancel'])('detects Claude active interrupt footer without a spinner: %s', (hint) => {
    const res = detectPromptInTail([
      '✻ Brewed for 27s · done 12:16 PM',
      '❯ Start another task',
      '❯',
      `⏵⏵ auto mode on · ${hint}`,
    ], { harness: 'claude' });
    expect(res.kind).toBe('working');
  });

  it('detects Claude interrupt footer without a previous completion marker', () => {
    const res = detectPromptInTail(['❯', '⏵⏵ auto mode on · esc to interrupt'], { harness: 'claude' });
    expect(res.kind).toBe('working');
  });

  it('does not treat an explanation of interrupt controls as active work', () => {
    const res = detectPromptInTail([
      'esc to interrupt cancels the current turn',
      '> Try "npm test"',
    ], { harness: 'claude' });
    expect(res.kind).toBe('idle');
  });

  it('does not treat interrupt text inside a draft as active work without a completion marker', () => {
    const res = detectPromptInTail([
      '────────────────────────',
      '❯ Explain the keyboard controls:',
      '  esc to interrupt cancels the current turn',
      '────────────────────────',
      '⏵⏵ auto mode on (shift+tab to cycle)',
    ], { harness: 'claude' });
    expect(res.kind).not.toBe('working');
  });

  it('does not apply Claude completion to another harness', () => {
    expect(detectPromptInTail(['✻ Brewed for 18s · done 11:42 AM'], { harness: 'shell' }).kind).toBe('none');
  });

  it.each(['needs_input', 'working', 'error'] as const)('lets a user Claude %s rule decide newer output after completion', (state) => {
    const rules = userRules(`harnesses:\n  claude:\n    rules:\n      - state: ${state}\n        patterns: ['Review pending']\n`);
    const res = detectPromptInTail([
      '✻ Brewed for 27s · done 12:16 PM',
      'Review pending',
      '⏵⏵ auto mode on (shift+tab to cycle)',
    ], { harness: 'claude', rules });
    expect(res.kind).toBe(state);
    expect(res.matchedRule).toEqual({ file: 'user', harness: 'claude', position: 1 });
  });

  it('does not reuse a user Claude rule match from before completion', () => {
    const rules = userRules("harnesses:\n  claude:\n    rules:\n      - state: needs_input\n        patterns: ['Review pending']\n");
    const res = detectPromptInTail([
      'Review pending',
      '✻ Brewed for 27s · done 12:16 PM',
      '❯ Continue',
    ], { harness: 'claude', rules });
    expect(res.kind).toBe('idle');
    expect(res.matchedRule?.file).toBe('factory');
    expect(res.promptLine).toContain('· done');
  });

  it('keeps only live Codex transcript and UI lines as signals', () => {
    expect(codexSignalLines([
      '• Ran a probe',
      '  └ Do you want to proceed? [y/N]',
      '    Worked for 12s',
      '  Worked for 3m 10s • 10:10 AM',
      '› Explain this log:',
      '  • Working (4s • esc to interrupt)',
      '  ← for agents · ? for shortcuts',
    ])).toEqual(['• Ran', '  Worked for 3m 10s • 10:10 AM', '›']);
    expect(codexSignalLines(['■ Failure', '› Ask Codex to do anything', '  footer'])).toEqual(['■ Failure', '› Ask Codex to do anything']);
    expect(codexSignalLines(["• Running printf '[y/N]' (1m 05s • esc to interrupt)", "• Ran printf '(5s • esc to interrupt)'"]))
      .toEqual(['• Running (1m 05s • esc to interrupt)', '• Ran']);
    expect(codexSignalLines(['Choose:', '› 1. First', '  2. Second', '  enter to submit'])).toEqual(['Choose:', '› 1. First', '  2. Second', '  enter to submit']);
  });

  it('keeps a long Codex tool block quoted beyond the inspection window', () => {
    const res = detectPromptInTail([
      '• Ran a diagnostic',
      '  └ Diagnostic output',
      ...Array(35).fill('    Ordinary tool output'),
      '    Do you want to proceed? [y/N]',
      '› Ask Codex to do anything',
    ], { harness: 'codex' });
    expect(res.kind).not.toBe('needs_input');
  });

  it('keeps an indented Codex approval dialog after a submitted prompt', () => {
    const res = detectPromptInTail([
      '› run tests',
      '  Would you like to run the following command?',
      '  › 1. Yes, proceed (y)',
      '    2. No, and tell Codex what to do differently (esc)',
      '  Press enter to confirm',
    ], { harness: 'codex' });
    expect(res.kind).not.toBe('none');
    expect(res.kind).not.toBe('idle');
  });

  it('does not let a quoted Codex completion in the draft end the turn', () => {
    const res = detectPromptInTail(['Do you want to proceed? [y/N]', '› Explain this log:', '  Worked for 12s'], { harness: 'codex' });
    expect(res.kind).toBe('needs_input');
  });

  it('returns none for ordinary output', () => {
    const tail = [
      'Building project @spawnea/desktop...',
      '[1/4] Resolving dependencies...',
      '[2/4] Fetching packages...',
    ];
    const res = detectPromptInTail(tail);
    expect(res.isPrompt).toBe(false);
    expect(res.kind).toBe('none');
  });
});
