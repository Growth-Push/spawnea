import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCodexRolloutFromProc } from '../src/history/proc-fd-resolver.js';

describe('resolveCodexRolloutFromProc', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves rollout file directly from pane process fd', () => {
    const pid = 1001;
    const procPidDir = path.join(tempDir, String(pid), 'fd');
    fs.mkdirSync(procPidDir, { recursive: true });

    const rolloutDir = path.join(tempDir, '.codex', 'sessions', '2026', '11', '04');
    fs.mkdirSync(rolloutDir, { recursive: true });
    const rolloutFile = path.join(rolloutDir, 'rollout-2026-11-04T12-00-00-mock-uuid-1.jsonl');
    fs.writeFileSync(rolloutFile, '{"type":"session_meta"}\n');

    // Create symlink 3 -> rolloutFile
    fs.symlinkSync(rolloutFile, path.join(procPidDir, '3'));

    const resolved = resolveCodexRolloutFromProc(pid, { procDir: tempDir });
    expect(resolved).toBe(rolloutFile);
  });

  it('traverses child processes via task children file to find rollout', () => {
    const parentPid = 2000;
    const childPid = 2001;

    // Parent has no rollout fd, but lists child in task/children
    const parentFd = path.join(tempDir, String(parentPid), 'fd');
    const parentTask = path.join(tempDir, String(parentPid), 'task', String(parentPid));
    fs.mkdirSync(parentFd, { recursive: true });
    fs.mkdirSync(parentTask, { recursive: true });
    fs.writeFileSync(path.join(parentTask, 'children'), `${childPid}\n`);

    // Child has rollout fd
    const childFd = path.join(tempDir, String(childPid), 'fd');
    fs.mkdirSync(childFd, { recursive: true });

    const rolloutDir = path.join(tempDir, '.codex', 'sessions', '2026', '11', '04');
    fs.mkdirSync(rolloutDir, { recursive: true });
    const rolloutFile = path.join(rolloutDir, 'rollout-2026-11-04T12-00-00-mock-uuid-child.jsonl');
    fs.writeFileSync(rolloutFile, '{"type":"session_meta"}\n');

    fs.symlinkSync(rolloutFile, path.join(childFd, '10'));

    const resolved = resolveCodexRolloutFromProc(parentPid, { procDir: tempDir });
    expect(resolved).toBe(rolloutFile);
  });

  it('traverses child processes via /proc/<pid>/stat ppid scan when children file is absent', () => {
    const parentPid = 3000;
    const childPid = 3001;

    fs.mkdirSync(path.join(tempDir, String(parentPid), 'fd'), { recursive: true });

    const childDir = path.join(tempDir, String(childPid));
    fs.mkdirSync(path.join(childDir, 'fd'), { recursive: true });
    // Write stat file: pid (comm) state ppid ...
    fs.writeFileSync(path.join(childDir, 'stat'), `${childPid} (codex) S ${parentPid} 0 0 0\n`);

    const rolloutDir = path.join(tempDir, '.codex', 'sessions', '2026', '11', '04');
    fs.mkdirSync(rolloutDir, { recursive: true });
    const rolloutFile = path.join(rolloutDir, 'rollout-2026-11-04T12-00-00-mock-uuid-stat.jsonl');
    fs.writeFileSync(rolloutFile, '{"type":"session_meta"}\n');

    fs.symlinkSync(rolloutFile, path.join(childDir, 'fd', '5'));

    const resolved = resolveCodexRolloutFromProc(parentPid, { procDir: tempDir });
    expect(resolved).toBe(rolloutFile);
  });

  it('returns newest rollout file if multiple are open in the process tree', () => {
    const pid = 4000;
    const procPidDir = path.join(tempDir, String(pid), 'fd');
    fs.mkdirSync(procPidDir, { recursive: true });

    const rolloutDir = path.join(tempDir, '.codex', 'sessions', '2026', '11', '04');
    fs.mkdirSync(rolloutDir, { recursive: true });

    const olderFile = path.join(rolloutDir, 'rollout-2026-11-04T10-00-00-older.jsonl');
    const newerFile = path.join(rolloutDir, 'rollout-2026-11-04T11-00-00-newer.jsonl');

    fs.writeFileSync(olderFile, 'older');
    fs.writeFileSync(newerFile, 'newer');

    // Adjust mtime
    const now = Date.now() / 1000;
    fs.utimesSync(olderFile, now - 100, now - 100);
    fs.utimesSync(newerFile, now, now);

    fs.symlinkSync(olderFile, path.join(procPidDir, '1'));
    fs.symlinkSync(newerFile, path.join(procPidDir, '2'));

    const resolved = resolveCodexRolloutFromProc(pid, { procDir: tempDir });
    expect(resolved).toBe(newerFile);
  });

  it('distinguishes two distinct sessions in the same folder by separate pane PIDs', () => {
    const pane1Pid = 5001;
    const pane2Pid = 5002;

    fs.mkdirSync(path.join(tempDir, String(pane1Pid), 'fd'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, String(pane2Pid), 'fd'), { recursive: true });

    const rolloutDir = path.join(tempDir, '.codex', 'sessions', '2026', '11', '04');
    fs.mkdirSync(rolloutDir, { recursive: true });

    const rollout1 = path.join(rolloutDir, 'rollout-session-1.jsonl');
    const rollout2 = path.join(rolloutDir, 'rollout-session-2.jsonl');

    fs.writeFileSync(rollout1, '{"session":"1"}\n');
    fs.writeFileSync(rollout2, '{"session":"2"}\n');

    fs.symlinkSync(rollout1, path.join(tempDir, String(pane1Pid), 'fd', '1'));
    fs.symlinkSync(rollout2, path.join(tempDir, String(pane2Pid), 'fd', '1'));

    expect(resolveCodexRolloutFromProc(pane1Pid, { procDir: tempDir })).toBe(rollout1);
    expect(resolveCodexRolloutFromProc(pane2Pid, { procDir: tempDir })).toBe(rollout2);
  });

  it('prefers parent process rollout over nested child helper process rollout', () => {
    const parentPid = 6000;
    const childPid = 6001;

    fs.mkdirSync(path.join(tempDir, String(parentPid), 'fd'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, String(childPid), 'fd'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, String(parentPid), 'task', String(parentPid)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, String(parentPid), 'task', String(parentPid), 'children'), String(childPid));

    const rolloutDir = path.join(tempDir, '.codex', 'sessions', '2026', '11', '04');
    fs.mkdirSync(rolloutDir, { recursive: true });

    const parentRollout = path.join(rolloutDir, 'rollout-parent.jsonl');
    const childRollout = path.join(rolloutDir, 'rollout-child-helper.jsonl');

    fs.writeFileSync(parentRollout, 'parent');
    fs.writeFileSync(childRollout, 'child');

    const now = Date.now() / 1000;
    fs.utimesSync(parentRollout, now - 100, now - 100);
    fs.utimesSync(childRollout, now, now); // Child is newer!

    fs.symlinkSync(parentRollout, path.join(tempDir, String(parentPid), 'fd', '1'));
    fs.symlinkSync(childRollout, path.join(tempDir, String(childPid), 'fd', '1'));

    // Should prefer the parent process rollout even though child rollout is newer
    const resolved = resolveCodexRolloutFromProc(parentPid, { procDir: tempDir });
    expect(resolved).toBe(parentRollout);
  });

  it('returns immediately without scanning proc when children file is readable and empty', () => {
    const leafPid = 7000;
    fs.mkdirSync(path.join(tempDir, String(leafPid), 'fd'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, String(leafPid), 'task', String(leafPid)), { recursive: true });
    // Empty children file
    fs.writeFileSync(path.join(tempDir, String(leafPid), 'task', String(leafPid), 'children'), '');

    // Another unrelated process in procDir that would match if proc scanning occurred
    const otherPid = 7001;
    fs.mkdirSync(path.join(tempDir, String(otherPid)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, String(otherPid), 'stat'), `${otherPid} (dummy) S ${leafPid} 1 1`);

    const resolved = resolveCodexRolloutFromProc(leafPid, { procDir: tempDir });
    expect(resolved).toBeNull();
  });

  it('returns null safely when pid is invalid or proc is absent', () => {
    expect(resolveCodexRolloutFromProc(undefined, { procDir: tempDir })).toBeNull();
    expect(resolveCodexRolloutFromProc(-1, { procDir: tempDir })).toBeNull();
    expect(resolveCodexRolloutFromProc(999999, { procDir: tempDir })).toBeNull();
  });
});
