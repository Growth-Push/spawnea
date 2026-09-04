import type { PatternRule } from './types.js';

/**
 * Built-in declarative detection rules for interactive harnesses and terminal sessions.
 */
export const DEFAULT_PATTERN_RULES: PatternRule[] = [
  // -------------------------------------------------------------
  // Antigravity Harness Rules
  // -------------------------------------------------------------
  {
    id: 'antigravity-questionnaire-menu',
    name: 'Antigravity Questionnaire Menu',
    category: 'choice',
    harness: 'antigravity',
    pattern: /Question \d+\/\d+:[^\n]*\n[\s\S]*?(?:Navigate|Select|Skip)/i,
    confidence: 0.95,
    description: 'Matches Antigravity multi-option interactive questionnaires',
  },
  {
    id: 'antigravity-questionnaire-header',
    name: 'Antigravity Question Header',
    category: 'choice',
    harness: 'antigravity',
    pattern: /Question \d+\/\d+:/i,
    confidence: 0.9,
    description: 'Matches Antigravity Question X/Y header',
  },
  {
    id: 'antigravity-permission-prompt',
    name: 'Antigravity Tool / File Permission Prompt',
    category: 'confirmation',
    harness: 'antigravity',
    pattern: /(?:Requesting permission for:|Do you want to proceed\?|Accept this (?:file )?edit\?)[\s\S]*?>\s*1\.\s+Yes/i,
    confidence: 0.95,
    description: 'Matches Antigravity bash/tool/file execution permission request menu',
  },
  {
    id: 'antigravity-navigation-footer',
    name: 'Antigravity Navigation Footer',
    category: 'choice',
    harness: 'antigravity',
    pattern: /(?:↑\/↓|[\u2191\u2193/]+)\s*Navigate/i,
    confidence: 0.9,
    description: 'Matches Antigravity bottom navigation key hints for interactive choices',
  },
  {
    id: 'antigravity-numbered-selection',
    name: 'Antigravity Numbered Selection',
    category: 'choice',
    harness: 'antigravity',
    pattern: />\s*1\.\s+[^\n]+\n\s*2\.\s+/i,
    confidence: 0.85,
    description: 'Matches Antigravity active choice pointer with multiple numbered options',
  },
  {
    id: 'antigravity-question-line',
    name: 'Antigravity Question Line',
    category: 'question',
    harness: 'antigravity',
    pattern: /^\s*\?\s+[A-Z0-9].+\?\s*$/m,
    confidence: 0.85,
    description: 'Matches Antigravity question formatted as ? Question?',
  },
  {
    id: 'antigravity-working-braille-spinner',
    name: 'Antigravity Braille Spinner Progress',
    category: 'working',
    harness: 'antigravity',
    pattern: /(?:[\u2800-\u28FF]|[⣾⣽⣻⢿⡿⣟⣯⣷⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])\s+[^\n]+/i,
    confidence: 0.98,
    description: 'Matches Antigravity rotating Braille spinner (e.g. ⣯ Analyzing... or ⠸ Read...)',
  },
  {
    id: 'antigravity-idle-prompt',
    name: 'Antigravity Idle Prompt',
    category: 'idle_prompt',
    harness: 'antigravity',
    pattern: /(?:^\s*[>›]|\?\s*for shortcuts|Ask Antigravity)/im,
    confidence: 0.9,
    description: 'Matches Antigravity ready/idle input prompt',
  },

  // -------------------------------------------------------------
  // OpenAI Codex CLI Harness Rules
  // -------------------------------------------------------------
  {
    id: 'codex-working-status',
    name: 'Codex Working Progress Line',
    category: 'working',
    harness: 'codex',
    pattern: /(?:^|\n)\s*[•*·-]?\s*Working(?:\s*\(.*?\))?/i,
    confidence: 0.98,
    description: 'Matches Codex active working line (e.g. • Working (1m 02s • esc to interrupt))',
  },
  {
    id: 'codex-working-interrupt-footer',
    name: 'Codex Interrupt Footer',
    category: 'working',
    harness: 'codex',
    pattern: /(?:^|\n)\s*•\s*[^\n]*\besc\s+to\s+interrupt\b/i,
    confidence: 0.98,
    description: 'Matches Codex active progress lines containing the esc to interrupt hint',
  },
  {
    id: 'codex-working-bullets',
    name: 'Codex Active Progress Bullets',
    category: 'working',
    harness: 'codex',
    pattern: /(?:^|\n)\s*•\s*(?:Working|Thinking|Searching|Running|Executing)\b[^\n]*/i,
    confidence: 0.92,
    description: 'Matches Codex active bullet status indicators',
  },
  {
    id: 'codex-idle-prompt',
    name: 'Codex Idle Input Prompt',
    category: 'idle_prompt',
    harness: 'codex',
    pattern: /[>›]?\s*Ask Codex to do anything|Ask Codex to do anything/i,
    confidence: 0.9,
    description: 'Matches Codex CLI idle/ready prompt bar',
  },
  {
    id: 'codex-questionnaire',
    name: 'Codex Interactive Questionnaire',
    category: 'choice',
    harness: 'codex',
    pattern: /Question\s+\d+\s*\/\s*\d+(?:\s*\(\s*\d+\s+unanswered\s*\))?[\s\S]*?(?:[›>]\s*\d+\.\s+|enter\s+to\s+submit\s+all|navigate\s+questions)/i,
    confidence: 0.98,
    description: 'Matches Codex multi-question option menus in Plan mode',
  },
  {
    id: 'codex-confirm-options',
    name: 'Codex Option Selection Prompt',
    category: 'choice',
    harness: 'codex',
    pattern: /(?:Please confirm one option|Which should I proceed with|Choose one of the following)[\s\S]*?(?:-\s+[A-Z]:|\b\d+,)/i,
    confidence: 0.95,
    description: 'Matches Codex multi-option confirmation questions',
  },
  {
    id: 'codex-bullet-options',
    name: 'Codex Bullet Options',
    category: 'choice',
    harness: 'codex',
    pattern: /-\s+[A-Z]:\s+[^\n]+\n\s*-\s+[A-Z]:/i,
    confidence: 0.85,
    description: 'Matches Codex bulleted options like - A: ... - B: ...',
  },

  // -------------------------------------------------------------
  // Hermes CLI Harness Rules
  // -------------------------------------------------------------
  {
    id: 'hermes-working-footer',
    name: 'Hermes Working Execution Footer',
    category: 'working',
    harness: 'hermes',
    pattern: /msg=interrupt|\/steer|\/queue|Ctrl\+C cancel|[|│]\s*⏱\s*\d+[smh]?/i,
    confidence: 0.98,
    description: 'Matches Hermes active turn interrupt footer bar or running stopwatch (⏱)',
  },
  {
    id: 'hermes-working-progress-verbs',
    name: 'Hermes Progress Verbs',
    category: 'working',
    harness: 'hermes',
    pattern: /\b(?:formulating|pondering|reviewing|searching|executing|synthesizing|generating)\.{2,3}/i,
    confidence: 0.95,
    description: 'Matches Hermes active progress verbs with ellipsis',
  },
  {
    id: 'hermes-needs-input-menu',
    name: 'Hermes Needs Input Header / Choice Selection',
    category: 'choice',
    harness: 'hermes',
    pattern: /Hermes needs your input|to select,\s*Enter to confirm/i,
    confidence: 0.98,
    description: 'Matches Hermes interactive question / option selection menu',
  },
  {
    id: 'hermes-question-prompt',
    name: 'Hermes Question Input Prompt',
    category: 'question',
    harness: 'hermes',
    pattern: /^\s*\?\s*>[^a-zA-Z0-9]*$/m,
    confidence: 0.9,
    description: 'Matches Hermes question prompt line (? >)',
  },
  {
    id: 'hermes-question-header',
    name: 'Hermes Question Header or Consultation',
    category: 'question',
    harness: 'hermes',
    pattern: /(?:^|\n)\s*[❓❔]\s*(?:Q\d+|QN\d+|Pregunta\s*\d+|Question\s*\d+)\s*[-—:]?\s*.+/i,
    confidence: 0.95,
    description: 'Matches Hermes consultation question headers prefixed with question emoji (❓/❔) like ❓ Q3 — ...',
  },
  {
    id: 'hermes-idle-completion-checkmark',
    name: 'Hermes Completed Turn Metrics Checkmark',
    category: 'idle_prompt',
    harness: 'hermes',
    pattern: /^\s*⚕[^\n]*[|│]\s*✓\s*\d+(?:ms|[smh])(?:\s|$)/im,
    confidence: 0.98,
    description: 'Matches the Hermes metrics bar completion checkmark (e.g. | ✓ 4m or | ✓9ms)',
  },
  {
    id: 'hermes-idle-prompt',
    name: 'Hermes Idle Input Prompt',
    category: 'idle_prompt',
    harness: 'hermes',
    pattern: /(?:^[a-zA-Z0-9_.\-/]+\s*>\s*(?!msg=interrupt|\/queue|\/bg|\/steer|Ctrl\+C)|^[>›]\s*(?:Ask Hermes|$))/im,
    confidence: 0.9,
    description: 'Matches Hermes CLI idle/ready prompt bar or context prefix',
  },

  // -------------------------------------------------------------
  // Claude Code CLI Harness Rules
  // -------------------------------------------------------------
  {
    id: 'claude-tool-permission',
    name: 'Claude Code Tool Permission',
    category: 'confirmation',
    harness: 'claude',
    pattern: /(?:Allow|Run|Execute)\s+.*?\?\s*\(y\/n\)|Do you want to run:[\s\S]*?\(y\/n\)/i,
    confidence: 0.95,
    description: 'Matches Claude Code interactive tool execution permissions',
  },
  {
    id: 'claude-idle-prompt',
    name: 'Claude Code Idle Prompt',
    category: 'idle_prompt',
    harness: 'claude',
    pattern: />\s*Try\s+|>\s*$/m,
    confidence: 0.8,
    description: 'Matches Claude Code ready prompt',
  },

  // -------------------------------------------------------------
  // Generic Interactive Confirmation & Choice Rules
  // -------------------------------------------------------------
  {
    id: 'generic-bracket-yn',
    name: 'Bracket Y/N Confirmation',
    category: 'confirmation',
    pattern: /\[[yY]\/[nN]\]|\([yY]\/[nN]\)|\[yes\/no\]|\(yes\/no\)/i,
    confidence: 0.9,
    description: 'Matches standard [y/N] or (y/n) prompts',
  },
  {
    id: 'generic-proceed-confirm',
    name: 'Proceed / Confirm Question',
    category: 'confirmation',
    pattern: /\b(?:proceed|confirm|approve|continue|apply)\s*\?/i,
    confidence: 0.85,
    description: 'Matches direct proceed/confirm questions',
  },
  {
    id: 'generic-want-to-proceed',
    name: 'Do you want to proceed',
    category: 'confirmation',
    pattern: /do you want to (?:continue|proceed|run|execute|apply|install|overwrite)/i,
    confidence: 0.85,
    description: 'Matches "do you want to continue" phrases',
  },
  {
    id: 'generic-allow-action',
    name: 'Allow Action Request',
    category: 'confirmation',
    pattern: /allow (?:this|the) (?:tool|action|command|execution|operation)/i,
    confidence: 0.85,
    description: 'Matches tool permission requests',
  },
  {
    id: 'generic-select-option',
    name: 'Select Option Prompt',
    category: 'choice',
    pattern: /(?:select|enter|choose) (?:an? )?(?:option|choice|number|item|selection):/i,
    confidence: 0.85,
    description: 'Matches explicit select choice prompts',
  },
  {
    id: 'generic-choice-range',
    name: 'Choice Numeric Range',
    category: 'choice',
    pattern: /choose \[[0-9]+-[0-9]+\]:/i,
    confidence: 0.85,
    description: 'Matches range choices like choose [1-5]:',
  },
  {
    id: 'generic-press-enter',
    name: 'Press Enter to Continue',
    category: 'choice',
    pattern: /press (?:enter|return|space) to (?:continue|proceed)/i,
    confidence: 0.8,
    description: 'Matches pause prompts waiting for Enter',
  },
  {
    id: 'generic-text-input-field',
    name: 'Text Input Field',
    category: 'question',
    pattern: /(?:enter|input) (?:value|path|query|name|prompt|message):\s*$/i,
    confidence: 0.8,
    description: 'Matches prompt lines requesting user input value',
  },

  // -------------------------------------------------------------
  // Generic Sub-Command Error Rules
  // -------------------------------------------------------------
  {
    id: 'generic-exit-status-error',
    name: 'Non-Zero Exit Status Output',
    category: 'error',
    pattern: /Exit status [1-9]\d*|exited with code [1-9]\d*|failed with exit code [1-9]\d*/i,
    confidence: 0.9,
    description: 'Matches command execution output reporting non-zero exit status',
  },
  {
    id: 'generic-pnpm-error',
    name: 'PNPM Execution Error',
    category: 'error',
    pattern: /ERR_PNPM_[A-Z_]+|ELIFECYCLE\s+Command failed/i,
    confidence: 0.9,
    description: 'Matches pnpm/npm fatal lifecycle failures',
  },
  {
    id: 'generic-uncaught-exception',
    name: 'Uncaught Exception / Fatal Error',
    category: 'error',
    pattern: /Uncaught (?:Exception|TypeError|ReferenceError|Error):|FATAL:\s+|Traceback \(most recent call last\):/i,
    confidence: 0.9,
    description: 'Matches runtime fatal exceptions',
  },
  {
    id: 'generic-command-not-found',
    name: 'Command Not Found',
    category: 'error',
    pattern: /command not found:|is not recognized as an internal or external command/i,
    confidence: 0.85,
    description: 'Matches missing command errors',
  },

  // -------------------------------------------------------------
  // Shell Prompt Rules
  // -------------------------------------------------------------
  {
    id: 'generic-shell-prompt-ps1',
    name: 'Standard PS1 Shell Prompt',
    category: 'shell_prompt',
    pattern: /(?:^|\n)[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:[^$#%]+[$#%]\s*$/,
    confidence: 0.85,
    description: 'Matches standard user@host:path$ shell prompt',
  },
  {
    id: 'generic-shell-prompt-symbol',
    name: 'Basic Shell Prompt Symbol',
    category: 'shell_prompt',
    pattern: /(?:^|\n)(?:\([^)]+\)\s*)?[a-zA-Z0-9_.-]+[$#%]\s*$/,
    confidence: 0.8,
    description: 'Matches shell prompt symbol ($ or # or %)',
  },

  // -------------------------------------------------------------
  // Active Working & Progress Rules
  // -------------------------------------------------------------
  {
    id: 'generic-working-progress',
    name: 'Active Progress Verbs',
    category: 'working',
    pattern: /(?:^|\n)\s*[•*·-]?\s*(?:working|generating|executing|processing|analyzing)\b|\b(?:reading (?:file|files|context|directory))\b/i,
    confidence: 0.9,
    description: 'Matches active agent status verbs like generating, reading file, working',
  },
];
