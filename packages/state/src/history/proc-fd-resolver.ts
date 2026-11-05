import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProcFdResolverOptions {
  procDir?: string;
}

const CODEX_ROLLOUT_REGEX = /\.codex\/sessions\/.*\/rollout-.*\.jsonl$/;

/**
 * Finds child PIDs for a given process on Linux using /proc.
 */
function findChildPids(procDir: string, pid: number): number[] {
  const children: number[] = [];

  // Try /proc/<pid>/task/<pid>/children first
  const childrenFile = path.join(procDir, String(pid), 'task', String(pid), 'children');
  try {
    if (fs.existsSync(childrenFile)) {
      const content = fs.readFileSync(childrenFile, 'utf8').trim();
      if (content) {
        for (const part of content.split(/\s+/)) {
          const childPid = parseInt(part, 10);
          if (!isNaN(childPid) && childPid > 0) {
            children.push(childPid);
          }
        }
      }
      return children;
    }
  } catch {
    // Fall back to scanning /proc
  }

  // Fallback: scan /proc for processes with PPID matching pid
  try {
    const entries = fs.readdirSync(procDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childPid = parseInt(entry.name, 10);
      if (isNaN(childPid) || childPid <= 0 || childPid === pid) continue;

      const statFile = path.join(procDir, entry.name, 'stat');
      try {
        const statContent = fs.readFileSync(statFile, 'utf8');
        // Format: pid (comm) state ppid ...
        // Find closing parenthesis to handle comms containing spaces or parentheses
        const closeParenIdx = statContent.lastIndexOf(')');
        if (closeParenIdx !== -1) {
          const rest = statContent.slice(closeParenIdx + 1).trim();
          const fields = rest.split(/\s+/);
          // fields[0] is state, fields[1] is ppid
          const ppid = parseInt(fields[1], 10);
          if (ppid === pid) {
            children.push(childPid);
          }
        }
      } catch {
        // Process might have exited
      }
    }
  } catch {
    // proc directory read error
  }

  return children;
}

/**
 * Resolves the active Codex rollout JSONL file open by a tmux pane process or its descendants.
 * Scans /proc/<pid>/fd for symlinks pointing to ~/.codex/sessions/.../rollout-*.jsonl.
 */
export function resolveCodexRolloutFromProc(
  panePid: number | undefined,
  options?: ProcFdResolverOptions
): string | null {
  if (typeof panePid !== 'number' || isNaN(panePid) || panePid <= 0) {
    return null;
  }

  const procDir = options?.procDir || '/proc';
  const visitedPids = new Set<number>();
  const queue: number[] = [panePid];

  interface Candidate {
    filePath: string;
    mtimeMs: number;
    size: number;
  }

  while (queue.length > 0) {
    const currentPid = queue.shift()!;
    if (visitedPids.has(currentPid)) continue;
    visitedPids.add(currentPid);

    // Queue child processes
    const childPids = findChildPids(procDir, currentPid);
    for (const child of childPids) {
      if (!visitedPids.has(child)) {
        queue.push(child);
      }
    }

    const processCandidates: Candidate[] = [];
    const fdDir = path.join(procDir, String(currentPid), 'fd');
    try {
      if (!fs.existsSync(fdDir)) continue;
      const fds = fs.readdirSync(fdDir);
      for (const fd of fds) {
        const fdPath = path.join(fdDir, fd);
        try {
          const target = fs.readlinkSync(fdPath);
          if (CODEX_ROLLOUT_REGEX.test(target)) {
            try {
              const stat = fs.statSync(target);
              processCandidates.push({
                filePath: target,
                mtimeMs: stat.mtimeMs,
                size: stat.size,
              });
            } catch {
              // File could be inaccessible
              processCandidates.push({
                filePath: target,
                mtimeMs: 0,
                size: 0,
              });
            }
          }
        } catch {
          // Bad link or permission error
        }
      }
    } catch {
      // /proc/<pid>/fd unreadable or process exited
    }

    if (processCandidates.length > 0) {
      processCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return processCandidates[0].filePath;
    }
  }

  return null;
}
