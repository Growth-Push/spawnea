import { describe, expect, it } from 'vitest';
import type { SessionSignals } from '@spawnea/domain';
import { StateDetector } from '../src/state-detector.js';
import { loadStateRules } from '../src/rules/load-state-rules.js';

// Synthetic screens based on the reported retry text, not live provider captures.
const retry = 'Server error (500) | Retrying (attempt 7)... 42s';
const ready = ['╭────────────────────────╮', '│ ❯                      │', '╰──── Grok 4.7 ───────────╯', 'Shift+Tab:mode │ Ctrl+.:shortcuts'];
function signals(tailLines: string[], extra: Partial<SessionSignals> = {}): SessionSignals {
  return { sessionId: 'retry', hostReachable: true, tmuxSessionExists: true, paneExists: true,
    paneDead: false, isPtyAttached: true, paneCurrentCommand: 'grok', tailLines, ...extra };
}
const detector = new StateDetector();
const status = (lines: string[]) => detector.detectStatus(signals(lines), 'grok');

describe('Grok current server retries', () => {
  it.each(['', '⠋ ', '⠙ ', '│ ⠹ ', '◆ '])('recognizes attempt seven with prefix %j despite cancel and ready chrome', (prefix) => {
    expect(status([`${prefix}${retry}`, 'Ctrl+c:cancel', ...ready]))
      .toMatchObject({ status: 'error', matchedRule: { file: 'factory', harness: 'grok' } });
  });

  it.each(['⠋', '│ ⠙ │', 'Generating 43s [stop]', 'Responding 44s', 'esc to interrupt', 'send a message to interrupt', '42s', 'Ctrl+c:cancel'])
    ('does not treat %j as provider recovery', (chrome) => {
      expect(status([retry, chrome, ...ready]).status).toBe('error');
    });

  it('keeps the unresolved error inside the bounded window through repeated chrome', () => {
    expect(status([retry, ...Array(20).fill('Ctrl+c:cancel'), ...ready]).status).toBe('error');
  });

  it('tracks successive retry attempts while PTY output continues', () => {
    for (const attempt of [7, 8, 9]) {
      expect(detector.detectStatus(signals([
        retry.replace('attempt 7', `attempt ${attempt}`).replace('42s', `${attempt * 6}s`), '│ ⠋ │', 'Ctrl+c:cancel',
      ], { lastOutputAt: new Date(), recentOutputBytes: 5000 }), 'grok').status).toBe('error');
    }
  });

  it('clears the error when actual tool output follows it', () => {
    expect(status([retry, 'Ctrl+c:cancel', '◆ Read package.json', ...ready]).status).toBe('working');
  });

  it('recognizes tool recovery even when its entry includes a stop button', () => {
    expect(status([retry, '◆ Read package.json 45s [stop]', ...ready]).status).toBe('working');
  });

  it('clears the error after a completed response', () => {
    expect(status([retry, 'The response succeeded.', 'Worked for 48s', ...ready]).status).toBe('idle');
  });

  it('clears the error when a real question card replaces it', () => {
    expect(status([retry, '◆ Waiting on answers for Which option?', 'Tab:next answer']).status).toBe('needs_input');
  });

  it.each([`> ${retry}`, `┃ ${retry}`, `Example: ${retry}`, `"${retry}"`, `\`${retry}\``])
    ('does not classify quoted or example text %j as a current provider failure', (quote) => {
      expect(status([quote, ...ready]).status).not.toBe('error');
    });

  it('does not classify a fenced example as a current provider failure', () => {
    expect(status(['Example:', '```text', retry, '```', ...ready]).status).not.toBe('error');
  });

  it('ignores an unfinished fenced example while a response is streaming', () => {
    expect(status(['Example:', '```text', retry, 'Ctrl+c:cancel']).status).not.toBe('error');
  });

  it('keeps an unresolved generic error despite the repainted composer', () => {
    expect(status(['Uncaught Error: request failed', ...ready]).status).toBe('error');
  });

  it('still clears a generic error on newer tool activity', () => {
    expect(status(['Uncaught Error: request failed', '◆ Read package.json', ...ready]).status).toBe('working');
  });

  it.each([
    ['retry', [retry, 'Ctrl+c:cancel', ...ready], 'error'],
    ['spinner', ['│ ⠋ │', 'Ctrl+c:cancel'], 'working'],
    ['question', ['◆ Waiting on answers for Which option?', 'Tab:next answer'], 'needs_input'],
    ['completion', ['Worked for 57s', ...ready], 'idle'],
  ] as const)('preserves %s after a closing fence whose opener was clipped', (_name, suffix, expected) => {
    expect(status(['const previousCode = true;', '```', ...suffix]).status).toBe(expected);
  });

  it('clears a prior retry on code-only response content', () => {
    expect(status([retry, '```ts', 'const result = 42;', '```', ...ready]).status).not.toBe('error');
  });

  it('excludes a balanced bare-fence retry example', () => {
    expect(status(['Example:', '```', retry, '```', ...ready]).status).not.toBe('error');
  });

  it('clears a retry on framed response content', () => {
    expect(status([retry, '│ The response succeeded. │', ...ready]).status).toBe('idle');
  });

  it('clears a retry on framed tool content', () => {
    expect(status([retry, '│ ◆ Read package.json', ...ready]).status).toBe('working');
  });

  it('does not treat framed busy controls as recovery', () => {
    expect(status([retry, '│ Generating 43s [stop] │', '│ Ctrl+c:cancel │', ...ready]).status).toBe('error');
  });

  it('keeps a live retry while the user types a multiline draft', () => {
    expect(status([retry, '│ ⠋ │', '│ ❯ please retry │', '│ continuation of the draft │', ...ready.slice(2)]).status).toBe('error');
  });

  it('keeps a live retry when a draft is captured without its model footer', () => {
    expect(status([retry, '│ ⠋ │', '│ ❯ please retry │', '│ draft continuation │']).status).toBe('error');
  });

  it('does not use a historical footer for the current footerless draft', () => {
    expect(status(['Worked for 57s', ...ready, retry, '│ ⠋ │', '│ ❯ please retry │', '│ draft continuation │']).status).toBe('error');
  });

  it('does not detect a pasted retry example in a completed composer draft', () => {
    expect(status(['Worked for 57s', ready[0], '│ ❯ explain this example │', `│ ${retry} │`, ...ready.slice(2)]).status).toBe('idle');
  });

  it('ignores a retry pasted into a draft whose footer is not captured', () => {
    expect(status(['Worked for 57s', ready[0], '│ ❯ explain this example │', `│ ${retry} │`]).status).not.toBe('error');
  });

  it('recognizes tool output beginning with a busy verb as recovery', () => {
    expect(status([retry, 'Running npm test', ...ready]).status).toBe('working');
  });

  it.each(['Generating... 43s [stop]', 'Responding (44s)', 'Running · 1m 2s [stop]'])
    ('keeps timer-only busy labels from clearing the retry: %s', (chrome) => {
      expect(status([retry, chrome, ...ready]).status).toBe('error');
    });

  it.each(['Generating 43s ⇣19.1k [↓][stop]', 'Responding 44s ⇣162k [stop]'])
    ('does not treat status token counters as recovery: %s', (chrome) => {
      expect(status([retry, chrome, ...ready]).status).toBe('error');
    });

  it.each(['The documentation names Ctrl+c:cancel as the shortcut.', 'The helper prints esc to interrupt when active.', 'Ctrl+c:cancel is the shortcut described above.', 'esc to interrupt is what the UI prints.'])
    ('recognizes a response mentioning a control hint: %s', (response) => {
      expect(status([retry, response, ...ready]).status).not.toBe('error');
    });

  it.each(['│ Grok Build 1.0.67 │', '│ Tool Call Density (v1.0.52) │', '│ Tip: Run /dashboard │', '│ ◆ Recap │', '│ main /s/c/demo 19K / 256K │ [Dashboard] │', '│ \uE0A0 main /s/c/demo 19K / 256K │ [Dashboard] │'])
    ('does not use framed welcome or recap chrome as recovery: %s', (chrome) => {
      expect(status([retry, chrome, ...ready]).status).toBe('error');
    });

  it.each(['Here is an example:', 'Here are some examples:', 'Here are samples:', 'For instance:', 'For example:', 'Example of the error:', 'Sample output:', 'For example, a retry looks like this:', 'For instance, the provider prints:'])('excludes an explicitly introduced unfinished bare-fence example: %s', (intro) => {
    expect(status([intro, '```', retry, 'Ctrl+c:cancel']).status).not.toBe('error');
  });

  it.each(['const example = true;', 'console.log("samples");', 'const quoted = JSON.stringify(result);', 'for example in items:'])
    ('does not mistake code before a clipped closing fence for an example introduction: %s', (code) => {
      expect(status([code, '```', retry, '│ ⠋ │', 'Ctrl+c:cancel', ...ready]).status).toBe('error');
    });

  it.each([{ suffix: [] }, { suffix: ['│ ``` │'] }])('excludes framed fenced retry examples with suffix %j', ({ suffix }) => {
    expect(status(['│ Example: │', '│ ```text │', `│ ${retry} │`, ...suffix, ...ready]).status).not.toBe('error');
  });

  it.each([
    { marker: '-', suffix: ['   ```'] },
    { marker: '1.', suffix: ['   ```'] },
    { marker: '-', suffix: [] },
    { marker: '1.', suffix: [] },
  ])('excludes tagged fenced examples in list items: %j', ({ marker, suffix }) => {
    expect(status([`${marker} \`\`\`text`, `   ${retry}`, ...suffix, 'Ctrl+c:cancel']).status).not.toBe('error');
  });

  it('retains an example introduction split across captured terminal rows', () => {
    expect(status(['For example, the provider returns this error', 'when it is temporarily unavailable:', '```', retry, 'Ctrl+c:cancel']).status).not.toBe('error');
  });

  it.each(["Here's an example:", 'An example of the retry:', '**A quoted example:**', 'Here is an example', 'Here’s an example', 'An example of the retry', '### Example', 'Example output', '**Example**', '### Example (HTTP 500)', '**Example (HTTP 500)**', '__Example (HTTP 500)__'])
    ('recognizes introduction prose without requiring one fixed phrase: %s', (intro) => {
      expect(status([intro, '```', retry, 'Ctrl+c:cancel']).status).not.toBe('error');
    });

  it('keeps user-rule priority over the provider error', () => {
    const { ruleSet } = loadStateRules({ userFilePath: '/fictional/state-rules.yaml', readFile: () =>
      "harnesses:\n  grok:\n    rules:\n      - state: needs_input\n        patterns: ['Ctrl\\+c:cancel']\n" });
    expect(new StateDetector({ rules: ruleSet }).detectStatus(signals([retry, 'Ctrl+c:cancel']), 'grok'))
      .toMatchObject({ status: 'needs_input', matchedRule: { file: 'user' } });
  });

  it('keeps connection and exit checks ahead of retry rules', () => {
    expect(detector.detectStatus(signals([retry], { hostReachable: false }), 'grok').status).toBe('disconnected');
    expect(detector.detectStatus(signals([retry], { paneDead: true, exitCode: 0 }), 'grok').status).toBe('done');
    expect(detector.detectStatus(signals([retry], { paneDead: true, exitCode: 1 }), 'grok').status).toBe('error');
  });
});
