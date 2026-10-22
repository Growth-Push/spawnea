# State Rules

Spawnea decides each session's attention state from what the harness draws in
its terminal. The patterns that recognize those screens live in a YAML file, so
you can adjust them for a harness without changing TypeScript or rebuilding
Spawnea.

The states are the same as everywhere else in Spawnea. Rules can report
`working`, `needs_input`, `idle`, or `error`. `disconnected` and `done` come from
the connection and process checks and never from rules.

## Files

| File | Purpose |
| --- | --- |
| `packages/state/src/rules/state-rules.yaml` | Factory rules bundled with Spawnea. An invalid factory file fails the tests and the desktop build. |
| `<userData>/state-rules.yaml` | Optional user rules. `<userData>` is the Spawnea user-data directory: `~/.config/spawnea` on Linux by default, `~/.config/spawnea/profiles/<name>` for a profile, or `SPAWNEA_USER_DATA_DIR` when set. |

Spawnea reads, validates, and compiles the rules **once at startup**. Every
detector shares those compiled rules. Nothing watches or rereads the file, and a
catalog reload does not touch it. **Restart Spawnea to apply a change.**

## How a state is decided

1. **Connection and process.** An unreachable host is `disconnected`. A missing
   tmux session or a process that exited with code 0 is `done`; another exit code
   or a dead pane is `error`. No patterns are involved.
2. **Rules.** The harness-specific preparation step (below) selects the lines
   that can carry the current state. The last 10 non-blank lines of that result
   are the *evaluated window*. The harness's rules are tried in order, and the
   first rule with a pattern that matches the window wins.
3. **Fallback**, when no rule matches. PTY output in the last ~3 seconds, or a
   foreground command that is neither the harness nor a shell (for example a
   build the harness started in the foreground), reports `working`. Otherwise the
   session is `idle`. A live harness process alone is not evidence of work.
   For agent harnesses, interpreters such as `node` or `python3` count as the
   harness process. In a shell session (an agent whose command is a shell), any
   foreground command other than a shell, including `node`, is work.

The window size (`STATE_RULE_WINDOW_LINES` in
`packages/state/src/adapters/rule-based-adapter.ts`) is a starting value under
review against real captures. It is not configurable.

### Preparation steps

Some decisions depend on context rather than on one pattern. They stay in
TypeScript and only remove lines before the rules run:

- **Claude Code:** the unsent draft in the input box collapses to one `❯`
  line. The `✻ <verb> for <duration> · done` marker ends a turn; lines above it
  are historical, and newer output after it starts a newer turn.
- **Codex:** tool commands and output, the unsent draft, and the composer footer
  are removed. A `Worked for` marker or a column-0 `■` turn failure ends the
  previous turn. An unresolved failure keeps its line so an `error` rule can
  report it.
- **Hermes:** a choice menu that later activity replaced, and a consultation
  question that the user already answered, are removed. Activity above the
  metrics-bar `✓` checkmark is historical.
- **Grok:** scrollbar rows are removed. A question card that the ready composer
  or later activity replaced is removed. A `Worked for` line ends the previous
  turn. The composer only counts as ready when nothing newer than the last
  completion (or the welcome panel) is on screen.
- **All harnesses except Codex and the generic shell:** an error line followed by
  a line that matches a rule for another state is historical.
- **Generic shell sessions:** evaluation starts at the newest shell prompt or
  error line.

## File format

```yaml
version: 1            # optional
harnesses:
  claude:             # harness name, case-insensitive
    rules:            # ordered; the first match wins
      - state: needs_input
        patterns:
          - 'Review gate: approve\?'
      - state: idle
        patterns:
          - '^Waiting for the next task$'
```

- `harnesses` maps a harness name to a non-empty `rules` list. Built-in aliases
  apply, so `agy` and `antigravity` are the same harness, as are `codex-cli` and
  `codex`.
- Each rule has exactly `state` (one of `working`, `needs_input`, `idle`,
  `error`) and a non-empty `patterns` list.
- A pattern is a JavaScript regular expression compiled case-insensitive and
  multiline, so `^` and `$` match at every line of the window. Use
  `(?-i:...)` for a case-sensitive part. `[^\S\n]` matches spaces, tabs, and the
  non-breaking spaces some harnesses draw without crossing into the next line.
  Write patterns in single quotes so backslashes stay literal; double a single
  quote to include it.
- Top-level keys starting with `x-` are ignored. Use them with YAML anchors to
  share a rule between harnesses:

  ```yaml
  x-shared:
    review-gate: &review_gate
      state: needs_input
      patterns: ['Review gate: approve\?']
  harnesses:
    claude:
      rules: [*review_gate]
    codex:
      rules: [*review_gate]
  ```

- Unknown keys, unknown states, empty lists, and invalid regular expressions are
  errors.

A rule is identified by its file, harness, and 1-based position in that file's
list for the harness, for example *user rule claude #2*. Rules do not need IDs.

### Combining user and factory rules

For a harness that both files define, the user's rules are evaluated first, then
the factory rules. A harness that only the user file defines is added; sessions
whose agent uses that harness name evaluate it. The `generic` rules apply to
sessions whose harness has no rules of its own. There is no way to switch a
factory rule off: add a user rule that matches first instead.

### Invalid user files

If the user file cannot be read or fails validation, Spawnea ignores the whole
file and uses only the factory rules. The desktop shows a banner with the file,
harness, rule position, and line of the first problem, and the application log
records the same details. Fix the file and restart Spawnea.

## Prompt turns

A `prompt wait` turn sent through the local control API ends only on positive
evidence: a response delimiter, an `idle` rule match (which includes completion
markers), the process exiting, or a stable screen. An `idle` result from the
fallback does not end a turn by itself.

A **stable screen** completes a turn when the result is the fallback `idle`, the
turn has produced output, and the evaluated window has stayed identical for at
least 30 seconds of elapsed time (`STABLE_SCREEN_COMPLETION_MS`). If the window
changes, the timer restarts and the turn stays `unknown`. The value is a
documented constant, not a setting.

Measured with real captures, Claude Code, Hermes, Antigravity, and Grok redraw
their evaluated window at least every second while working, including long
thinking and long tool runs. Codex can leave its window unchanged for about 30
seconds during a long tool run and for minutes while thinking. Those screens
still show its `esc to interrupt` status line, which a `working` rule matches,
so the stable-screen fallback does not apply to them.

## Report wrong state

The state feedback dialog (**Report state detection issue**) captures the
session again and saves a local report only when you choose to. Besides the
terminal tail, your notes, and the session's name, worktree path, and branch,
the report (`schemaVersion` `2.0.0`) records:

- `observedStatus`: the status Spawnea displayed when you opened the dialog, and
  `expectedStatus`: the status you selected.
- `detectedStatus`, `detectedSource`, `detectedConfidence`, `detectionReason`,
  and `detectedPrompt` from evaluating the captured snapshot.
- `decision`: what decided `detectedStatus`, either
  `{ "kind": "rule", "rule": { "file", "harness", "position" } }` for the
  winning rule, `{ "kind": "fallback" }` when no rule matched, or
  `{ "kind": "connection" }` for the connection and process step.
- `rulesConfig.source`: the configuration in use, `factory`, `merged`, or
  `user_invalid`. For an invalid user file, `rulesConfig.error` keeps only the
  file name, harness, rule position, and line. The main process sets this field
  when it saves the report; a value sent by the renderer is ignored.
- `capture`: `{ "status": "captured" }`, or `{ "status": "failed", "reason" }`
  when Spawnea could not reach the host or tmux, or the snapshot request failed.
  A failed capture is saved without any detected status, source, confidence,
  reason, decision, or terminal tail; Spawnea does not fill them in. The
  underlying error goes to the application log, not the report.

The report never includes rule patterns, the user rules file path, or the text
of a validation error. It is written with private permissions to the feedback
directory described in [Terminal Data and Security](terminal-data-and-security.md);
nothing is uploaded or saved automatically.
