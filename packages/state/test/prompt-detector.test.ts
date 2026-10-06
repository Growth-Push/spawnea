import { describe, it, expect } from 'vitest';
import { stripAnsi, detectPromptInTail } from '../src/prompt-detector.js';

describe('prompt-detector', () => {
  it('strips ANSI color and cursor codes cleanly', () => {
    const rawAnsi = '\u001b[32m✔ Success\u001b[0m: \u001b[1mDo you want to proceed? [y/N]\u001b[0m';
    const cleaned = stripAnsi(rawAnsi);
    expect(cleaned).toBe('✔ Success: Do you want to proceed? [y/N]');
  });

  it('detects confirmation prompts ([y/N], (y/n), proceed?)', () => {
    const tail1 = [
      'Applying database migrations...',
      'Table "users" will be altered.',
      'Do you want to continue? [y/N]: ',
    ];
    const res1 = detectPromptInTail(tail1);
    expect(res1.isPrompt).toBe(true);
    expect(res1.kind).toBe('confirmation');
    expect(res1.promptLine).toContain('Do you want to continue? [y/N]');

    const tail2 = [
      '\u001b[33mWarning: destructive change\u001b[0m',
      'Proceed? (y/n)',
    ];
    const res2 = detectPromptInTail(tail2);
    expect(res2.isPrompt).toBe(true);
    expect(res2.kind).toBe('confirmation');
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
    expect(res.kind).toBe('choice');
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
    expect(res.kind).toBe('choice');
    expect(res.matchedRuleId).toBe('antigravity-questionnaire-menu');
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
    expect(res.kind).toBe('confirmation');
    expect(res.matchedRuleId).toBe('antigravity-permission-prompt');
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
    expect(res.kind).toBe('confirmation');
    expect(res.matchedRuleId).toBe('antigravity-permission-prompt');
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
    expect(res.matchedRuleId).toBe('antigravity-working-braille-spinner');
  });

  it('detects the canonical Antigravity idle ready prompt', () => {
    const tail = [
      'Task execution complete.',
      '> ',
      '? for shortcuts',
    ];
    const res = detectPromptInTail(tail, { harness: 'antigravity' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('idle_prompt');
    expect(res.matchedRuleId).toBe('antigravity-idle-prompt');
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
    expect(res.kind).toBe('choice');
    expect(res.matchedRuleId).toBe('codex-confirm-options');
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
    expect(res.kind).toBe('choice');
    expect(res.matchedRuleId).toBe('codex-questionnaire');
    expect(res.promptLine).toContain('Question 2/2');
  });

  it('does not treat a questionnaire navigation footer as Codex working activity', () => {
    const res = detectPromptInTail(
      ['tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt'],
      { harness: 'codex' }
    );

    expect(res.kind).toBe('none');
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
    expect(res.matchedRuleId).toBe('codex-working-status');
    expect(res.promptLine).toContain('Working');
  });

  it('detects Codex CLI idle prompt when not asking options', () => {
    const tail = [
      'All tests passed successfully.',
      '> Ask Codex to do anything',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('idle_prompt');
    expect(res.matchedRuleId).toBe('codex-idle-prompt');
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
    expect(res.kind).toBe('confirmation');
    expect(res.matchedRuleId).toBe('codex-tool-approval');
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
    expect(res.kind).toBe('choice');
    expect(res.matchedRuleId).toBe('codex-arrow-selection');
  });

  it('detects modern Codex CLI Braille spinner as active working', () => {
    const tail = [
      'Resolving files...',
      '⠋ Thinking... (12s)',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(false);
    expect(res.kind).toBe('working');
    expect(res.matchedRuleId).toBe('codex-working-spinner');
  });

  it('detects modern Codex reasoning header as active working', () => {
    const tail = [
      '┌ Reasoning ───────────────────────────────',
      'Thinking through the implementation steps...',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(false);
    expect(res.kind).toBe('working');
    expect(res.matchedRuleId).toBe('codex-working-reasoning');
  });

  it('detects modern Codex plan confirmation', () => {
    const tail = [
      'Review the migration plan above.',
      'Do you want to proceed with this plan?',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('confirmation');
    expect(res.matchedRuleId).toBe('codex-plan-confirmation');
  });

  it('detects modern Codex idle input prompt with ❯ and Ask anything', () => {
    const tail = [
      'Done!',
      '❯ Ask anything, or type / for commands',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('idle_prompt');
    expect(res.matchedRuleId).toBe('codex-idle-prompt');
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
    expect(res.kind).toBe('question');
    expect(res.matchedRuleId).toBe('codex-queued-followup');
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
    expect(res.kind).toBe('question');
    expect(res.matchedRuleId).toBe('codex-queued-followup');
  });

  it('detects modern Codex queued follow-up with multiple questions and minute/hour durations', () => {
    const tailMinutes = [
      '• Queued follow-up inputs',
      '  ? 3 questions · 4m 12s',
      '    shift+← to answer',
    ];
    const resMin = detectPromptInTail(tailMinutes, { harness: 'codex' });
    expect(resMin.isPrompt).toBe(true);
    expect(resMin.kind).toBe('question');
    expect(resMin.matchedRuleId).toBe('codex-queued-followup');

    const tailHours = [
      '• Queued follow-up inputs',
      '  ? 2 questions · 1h 30m',
      '    shift+← to answer',
    ];
    const resHr = detectPromptInTail(tailHours, { harness: 'codex' });
    expect(resHr.isPrompt).toBe(true);
    expect(resHr.kind).toBe('question');
    expect(resHr.matchedRuleId).toBe('codex-queued-followup');
  });

  it('detects modern Codex question with bullet options', () => {
    const tail = [
      '• Which deployment target would you prefer?',
      '  • Staging',
      '  • Production',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('question');
    expect(res.matchedRuleId).toBe('codex-question-bullet-options');
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
    expect(res.kind).toBe('choice');
    expect(res.matchedRuleId).toBe('codex-questionnaire-menu');
  });

  it('detects modern Codex queued question with no time suffix', () => {
    const tail = [
      '• Queued follow-up inputs',
      '  ? 4 questions',
      '    shift+← to answer',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('question');
    expect(res.matchedRuleId).toBe('codex-queued-followup');
  });

  it('detects modern Codex queued question with ascii arrow shift+<- to answer', () => {
    const tail = [
      '• Queued follow-up inputs',
      '  ? 1 question · 10s',
      '    shift+<- to answer',
    ];
    const res = detectPromptInTail(tail, { harness: 'codex' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('question');
    expect(res.matchedRuleId).toBe('codex-queued-followup');
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
    expect(res.kind).toBe('choice');
    expect(res.matchedRuleId).toBe('codex-questionnaire-menu');
    expect(res.promptLine).toContain('Microservices');
  });

  it('detects modern Hermes idle input prompt with ❯ and Ask anything', () => {
    const tail = [
      'All changes applied.',
      '❯ Ask anything, or type / for commands…',
    ];
    const res = detectPromptInTail(tail, { harness: 'hermes' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('idle_prompt');
    expect(res.matchedRuleId).toBe('hermes-idle-prompt');
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
    expect(res.kind).toBe('shell_prompt');
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
    expect(res.kind).toBe('choice');
    expect(res.matchedRuleId).toBe('hermes-needs-input-menu');
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
    const res = detectPromptInTail(tail, { harness: 'hermes', tailLinesCount: 20 });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('choice');
    expect(res.matchedRuleId).toBe('hermes-needs-input-menu');
    expect(res.promptLine).not.toContain('example-model');
  });

  it('lets a later progress verb replace a stale Hermes choice footer', () => {
    const tail = [
      '  ↑/↓ to select, Enter to lock, Tab next question  (12s)',
      'formulating...',
    ];
    const res = detectPromptInTail(tail, { harness: 'hermes' });
    expect(res.kind).toBe('working');
    expect(res.matchedRuleId).toBe('hermes-working-progress-verbs');
    expect(res.promptLine).toBe('formulating...');
  });

  it('detects a Hermes ? ❯ prompt that remains under the metrics stopwatch', () => {
    const tail = [
      ' ☤ example-model │ 10K/100K │ [███░░░░░░░] 27% │ ⏱21 43s',
      '? ❯',
    ];
    const res = detectPromptInTail(tail, { harness: 'hermes' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('question');
    expect(res.matchedRuleId).toBe('hermes-question-prompt');
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
    const res = detectPromptInTail(tail, { harness: 'hermes', tailLinesCount: 20 });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('question');
    expect(res.matchedRuleId).toBe('hermes-question-header');
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
    expect(res.kind).toBe('idle_prompt');
    expect(res.matchedRuleId).toBe('hermes-idle-completion-checkmark');
  });

  it('detects the generic Hermes metrics bar without relying on its input prompt', () => {
    const res = detectPromptInTail([
      '⚕ model │ 28K/128K │ [██░░░░░░░░] 22% │ ◎ 79.3% │ ◷ 7.0s │ ↑ 27 t/s │ 🗜️ 2 │ 1h456m │ ⏲ 3m 45s │ ✓40m',
    ], { harness: 'hermes' });
    expect(res.isPrompt).toBe(true);
    expect(res.kind).toBe('idle_prompt');
    expect(res.matchedRuleId).toBe('hermes-idle-completion-checkmark');
  });

  it('accepts millisecond completion durations and rejects incomplete Hermes bars', () => {
    const withMilliseconds = detectPromptInTail([
      '⚕ model │ 28K/128K │ ✓9ms',
    ], { harness: 'hermes' });
    expect(withMilliseconds.matchedRuleId).toBe('hermes-idle-completion-checkmark');

    const withoutMetricsPrefix = detectPromptInTail(['│ ✓9ms'], { harness: 'hermes' });
    expect(withoutMetricsPrefix.matchedRuleId).not.toBe('hermes-idle-completion-checkmark');

    const withoutCompletionCheckmark = detectPromptInTail([
      '⚕ model │ 28K/128K │ ⏲ 3m 45s',
    ], { harness: 'hermes' });
    expect(withoutCompletionCheckmark.matchedRuleId).not.toBe('hermes-idle-completion-checkmark');
  });

  it('detects Hermes active execution interrupt footer', () => {
    const tail = [
      'Inspecting files...',
      '⚡ gpt-5.6-sol | 53.9K/128K | [|||||||||||] 42% | 9 1 | 1h 15m | 98s',
      '> msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel',
    ];
    const res = detectPromptInTail(tail, { harness: 'hermes' });
    expect(res.kind).toBe('working');
    expect(res.matchedRuleId).toBe('hermes-working-footer');
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
