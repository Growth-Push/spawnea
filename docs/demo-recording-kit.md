# Multi-Harness Demo Recording Kit

This kit provides a reproducible, text-first plan and automated fixture scripts for three short Spawnea videos. Each video is assembled from focused 8–15 second clips so waiting time can be removed before the final Hyperframes edit.

## Goal

Demonstrate three product capabilities:

- operating Codex, Antigravity, and Hermes sessions across two local projects and one SSH host;
- isolating a Codex task in a managed Git worktree and integrating it safely;
- organizing a Codex parent session with an Antigravity image child and a Codex review child on the same project.

The demo is intentionally not an application showcase. The project is a disposable directory with a single text file. The value being demonstrated is session operation, multi-harness coordination, and workspace lifecycle management.

## Demo Fixture

The demo fixture uses two disposable local projects:

```text
/tmp/demo-proj/
└── README.md
/tmp/demo-proj-2/
└── README.md
```

Two repository scripts manage this fixture:

- **Initialize fixture:**
  ```sh
  ./scripts/demo-project-init.sh
  ./scripts/demo-project-init.sh /tmp/demo-proj-2
  ```
  Creates `/tmp/demo-proj`, configures local Git identity, writes `README.md`, and creates an initial commit on `main`.

- **Reset fixture:**
  ```sh
  ./scripts/demo-project-reset.sh
  ./scripts/demo-project-reset.sh /tmp/demo-proj-2
  ```
  Removes `/tmp/demo-proj` if present and re-runs `demo-project-init.sh` to provide a clean state.

These Linux scripts require `realpath`. Both accept only canonical paths inside the temporary directory (or `/tmp/demo-proj` by default). Initialization refuses unrelated existing content. Reset requires the fixture marker stored by initialization in `.git` before deleting an existing fixture. They do not touch user configuration, SSH keys, or remote servers.

## Demo Catalog

Use a private copy of the catalog template at [`config/spawnea.demo.example.yaml`](../config/spawnea.demo.example.yaml):

```yaml
version: 1

hosts:
  local:
    name: Demo Local Workstation
    enabled: true
    projects:
      demo-project:
        name: Demo Project
        path: /tmp/demo-proj
        enabled: true
        worktree:
          enabled: true
      demo-project-2:
        name: Demo Project 2
        path: /tmp/demo-proj-2
        enabled: true
        worktree:
          enabled: false
    harnesses:
      codex:
        name: Codex
        command: codex
        args: []
        enabled: true
      antigravity:
        name: Antigravity
        command: agy
        args: []
        enabled: true
      shell:
        name: Shell
        command: sh
        args: []
        enabled: true

  rpi-demo:
    name: Demo Raspberry Pi
    enabled: true
    ssh:
      target: demo-rpi
      user: demo-user
      port: 22
    projects:
      demo-project:
        name: Remote Demo Project
        path: ~/demo-proj
        enabled: true
    harnesses:
      hermes:
        name: Hermes
        command: hermes
        args: []
        enabled: true
```

Replace `demo-rpi` and `demo-user` with an SSH host and user configured in your `~/.ssh/config`. Ensure the remote host has `tmux`, `hermes`, and `~/demo-proj` available before recording. Never commit private credentials or internal hostnames.

## Recording Runtime

Record from the current main branch or a release that includes child sessions. Use an isolated user-data directory and a private copy of the demo catalog under `/tmp`. Reset only the disposable fixtures created by these scripts.

## Recording Sequence

### Video 1 — Local projects, attention, and SSH

#### Clip 1A — Demo Project + Codex

1. Start from the empty session view.
2. Create a local **Demo Project** session with **Codex**.
3. Use this task description:

```text
Inspect README.md and summarize the project in two short bullet points. Do not modify files.
```

4. Cut after the Codex session appears as active or working.

#### Clip 1B — Demo Project 2 + Antigravity

1. Create a local **Demo Project 2** session with **Antigravity**.
2. Use this task description:

```text
Review README.md. Before editing any file, ask me exactly one concise clarification question and wait for my answer. Do not make changes yet.
```

3. Cut with the question and the `needs input` state visible.

#### Clip 1C — SSH VM + Hermes

1. Create a **Remote Demo Project** session on **Demo Raspberry Pi** with **Hermes**.
2. Show the SSH-backed terminal and the three sessions together in the sidebar.
3. Do not show credentials, addresses, or setup commands.

### Video 2 — Managed worktree and integration

#### Clip 2A — Create isolated worktree

1. Reset **Demo Project** before recording.
2. Create a local **Demo Project** session with **Codex**.
3. Enable **Managed Worktree**.
4. Use this task description:

```text
Add a section named "Demo result" to README.md with exactly three short bullet points describing this demo. Modify no other file. Commit the change with the message "docs: add demo result".
```

5. Cut after the isolated branch and working state are visible.

#### Clip 2B — Inspect and integrate

1. Start after Codex has committed the requested change.
2. Briefly show the changed file or Git diff.
3. Click **Finalize isolated worktree**, choose **Integrate**, and confirm **Integrate & Clean Up**.
4. End with the worktree session removed and the integrated commit visible from the base project.

### Video 3 — Parent and child sessions

#### Clip 3A — Parent Codex session

1. Reset **Demo Project 2** before recording.
2. Create a local **Demo Project 2** session with **Codex**, without a managed worktree.
3. Use this task description:

```text
Update README.md by adding a section titled "Session hierarchy" with one short paragraph explaining that a parent session can coordinate focused child sessions. Modify no other file. Do not commit the change.
```

4. Wait until the README change is complete before creating the review child.

#### Clip 3B — Antigravity image child

1. From the parent session, choose **Create Child Session**.
2. Select **Antigravity** and **Same Project**.
3. Name it **Image** and use this task description:

```text
Create a polished, simple SVG illustration at /tmp/demo-proj-2/session-hierarchy.svg. Use a dark background and show one parent node connected to two child nodes labeled "Image" and "Review". Use a 1200 by 675 canvas. Modify no other file and do not commit. When finished, print exactly: Output written to /tmp/demo-proj-2/session-hierarchy.svg
```

4. Cut after the Antigravity child appears nested under its parent or after the SVG appears as an artifact.

#### Clip 3C — Codex review child

1. From the same parent, create another child session.
2. Select **Codex** and **Same Project**.
3. Name it **Review** and use this task description:

```text
Review the current uncommitted README.md change made by the parent session. Do not modify files. Report whether the change is clear and accurate, followed by one concise improvement suggestion.
```

4. End with the expanded hierarchy showing the Codex parent, Antigravity Image child, and Codex Review child.

## Recording Rules

- Target duration: 8–15 seconds per clip; remove all agent waiting time in the edit.
- Cut between scene boundaries to omit waiting for LLM token generation.
- Treat each video as an independent recording block. Close its Spawnea sessions before resetting either disposable project for the next video; do not remove a project directory while one of its `tmux` sessions is still open.
- Keep the Spawnea window, status badges, and terminal fonts sharp and legible.
- Do not display real private SSH keys, sensitive hostnames, passwords, API tokens, or non-documentation email addresses.
- If an agent produces unexpected output or stalls, run `./scripts/demo-project-reset.sh` and re-record the scene.

## Acceptance Criteria Checklist

- [ ] Video 1 shows Codex on Demo Project, Antigravity waiting for input on Demo Project 2, and Hermes on the SSH VM.
- [ ] Video 1 visibly shows `working` and `needs input`.
- [ ] Video 2 shows creation, inspection, integration, and cleanup of a managed worktree.
- [ ] Video 3 shows one Codex parent with an Antigravity image child and a Codex review child.
- [ ] The Antigravity child creates and exposes `session-hierarchy.svg` as an artifact.
- [ ] The Codex review child inspects the parent's README change without modifying files.
- [ ] Every clip is 8–15 seconds before the Hyperframes assembly.
- [ ] The fixture can be recreated with the provided scripts.
- [ ] No credentials or private host configuration are stored in the repository.

## Validation

Verify the fixture scripts from the repository root:

```sh
./scripts/demo-project-reset.sh
./scripts/demo-project-reset.sh /tmp/demo-proj-2
cd /tmp/demo-proj
git status --short --branch
git log --oneline --decorate -1
test -f README.md
```

Then run repository automated checks:

```sh
pnpm privacy:check
pnpm test
```
