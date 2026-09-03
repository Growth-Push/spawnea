import { stripAnsi } from './prompt-detector.js';
import { resolveContainedPath } from '@spawnea/domain';

export interface DetectedOutputArtifact {
  rawMatch: string;
  path: string;
  normalizedPath: string;
  filename: string;
  source: 'tool_call' | 'terminal_output' | 'capture_pane';
  harnessHint?: string;
  confidence: number;
}

export interface OutputDetectorOptions {
  worktreePath: string;
  harness?: string;
  blacklistPatterns?: string[];
}

export const DEFAULT_BLACKLIST_PATTERNS: string[] = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'composer.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'tsconfig.tsbuildinfo',
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  '*.tmp',
  '*.temp',
  '*.swp',
  '*.map',
  '*.pyc',
  '.git/**',
  'node_modules/**',
  '.pnpm/**',
  'dist/**',
  'out/**',
  'build/**',
  '.turbo/**',
  '.cache/**',
];

/**
 * Checks if a relative/absolute path or filename matches any blacklist pattern.
 */
export function matchesBlacklistPattern(candidate: string, pattern: string): boolean {
  const normCandidate = candidate.toLowerCase();
  const normPattern = pattern.toLowerCase().trim();
  if (!normPattern) return false;

  const filename = normCandidate.split('/').pop() || normCandidate;

  // Exact match on full path or filename
  if (normPattern === normCandidate || normPattern === filename) return true;

  // Extension wildcard e.g. *.log or *.tmp or *.pyc
  if (normPattern.startsWith('*.')) {
    const ext = normPattern.slice(1);
    if (filename.endsWith(ext) || normCandidate.endsWith(ext)) return true;
  }

  // Folder wildcard e.g. dist/*, node_modules/*, .git/*
  if (normPattern.endsWith('/*') || normPattern.endsWith('/**')) {
    const prefix = normPattern.replace(/\/\*+$/, '');
    if (
      normCandidate.includes(`/${prefix}/`) ||
      normCandidate.startsWith(`${prefix}/`) ||
      normCandidate.endsWith(`/${prefix}`) ||
      normCandidate === prefix
    ) {
      return true;
    }
  }

  // General glob-like pattern conversion
  try {
    const escaped = normPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/(?<!\.)\*/g, '[^/]*');
    const regex = new RegExp(`(^|/)${escaped}$`, 'i');
    if (regex.test(normCandidate) || regex.test(filename)) return true;
  } catch {
    if (normCandidate.includes(normPattern)) return true;
  }

  return false;
}

// Regexes for specific agent tool output patterns
const PATTERNS: { regex: RegExp; source: 'tool_call' | 'terminal_output'; confidence: number; hint?: string }[] = [
  // Antigravity / Gemini CLI: ● Create(/path/to/file) or ● Edit(/path/to/file)
  {
    regex: /●\s*(?:Create|Edit|Write|Generate)\(([^)]+)\)/i,
    source: 'tool_call',
    confidence: 0.98,
    hint: 'antigravity',
  },
  // Claude Code / Agy / Aider: Created file `path`, Created `path`, Wrote `path`
  {
    regex: /(?:Created|Wrote|Writing|Updated|Saved)\s+(?:file\s+)?(?:to\s+)?[`'"]?([^`'"\s\n\r]+\.[a-zA-Z0-9_-]{1,10})[`'"]?/i,
    source: 'tool_call',
    confidence: 0.92,
    hint: 'claude',
  },
  // Codex / OpenCode: Applied edit to path, Creating path
  {
    regex: /(?:Applied edit to|Creating|Generated file|Output written to)\s+[`'"]?([^`'"\s\n\r]+\.[a-zA-Z0-9_-]{1,10})[`'"]?/i,
    source: 'tool_call',
    confidence: 0.92,
    hint: 'codex',
  },
  // Generic tool line: Create file \n /path/to/file
  {
    regex: /(?:Create|Edit|New) file\s*\n+([^\s\n\r]+\.[a-zA-Z0-9_-]{1,10})/i,
    source: 'tool_call',
    confidence: 0.90,
  },
  // Standalone paths. The existence and Git checks happen in ArtifactManager;
  // this matcher intentionally accepts any file extension so artifacts are not
  // limited to a hard-coded list of document and source formats.
  {
    regex: /(?:^|[\s"'`(])((?:~[\\/]|\/|[A-Za-z]:[\\/]|\.\.?[\\/])?[\w.-]+(?:[\\/][\w.-]+)*\.[A-Za-z0-9_-]{1,32}(?::\d+){0,2})(?=$|[\s"'`),.;!?])/g,
    source: 'terminal_output',
    confidence: 0.75,
  },
];

/** Removes editor-style line/column suffixes from a detected file path. */
export function stripPathLineNumber(candidate: string): string {
  return candidate.replace(/:\d+(?::\d+)?$/, '');
}

function expandHomePath(candidate: string, worktreePath: string): string {
  if (!candidate.startsWith('~/') && !candidate.startsWith('~\\')) return candidate;

  // The remote user's home is not available as a separate session field. For
  // the usual POSIX layouts, infer it from the resolved worktree root.
  const portableWorktree = worktreePath.replace(/\\/g, '/');
  const homeMatch = portableWorktree.match(
    /^(\/(?:home|Users)\/[^/]+|[A-Za-z]:\/[Uu][Ss][Ee][Rr][Ss]\/[^/]+)(?:\/|$)/
  );
  return homeMatch ? `${homeMatch[1]}/${candidate.slice(2).replace(/\\/g, '/')}` : candidate;
}


/**
 * Parses terminal lines and capture-pane output to detect candidate files created or edited by LLM agents.
 */
export function detectOutputArtifacts(
  lines: string[] | string,
  options: OutputDetectorOptions
): DetectedOutputArtifact[] {
  const content = Array.isArray(lines) ? lines.join('\n') : lines;
  if (!content || content.trim().length === 0) {
    return [];
  }

  const cleanText = stripAnsi(content);
  const detectedMap = new Map<string, DetectedOutputArtifact>();
  const normalizedWorktree = options.worktreePath.replace(/\/+$/, '');

  const allBlacklist = [
    ...DEFAULT_BLACKLIST_PATTERNS,
    ...(options.blacklistPatterns || []),
  ];

  for (const patternDef of PATTERNS) {
    // Global matching
    const globalRegex = new RegExp(patternDef.regex.source, 'gi');
    let match: RegExpExecArray | null;

    while ((match = globalRegex.exec(cleanText)) !== null) {
      const candidateRaw = match[1] ? match[1].trim() : '';
      if (!candidateRaw || candidateRaw.length < 2) continue;

      // Clean surrounding quotes or parenthesis
      const cleanPath = stripPathLineNumber(
        candidateRaw.replace(/^['"`(]+|['"`)]+$/g, '').trim()
      );
      if (/^v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/i.test(cleanPath)) continue;
      if (!cleanPath || cleanPath.includes(' ') || cleanPath.startsWith('http://') || cleanPath.startsWith('https://')) {
        continue;
      }

      // Check default and custom blacklist patterns on raw path
      if (allBlacklist.some((pat) => matchesBlacklistPattern(cleanPath, pat))) {
        continue;
      }

      // Normalize and enforce the active worktree boundary. Terminal output is
      // untrusted input: absolute paths outside the worktree and relative
      // traversal paths must never become artifact candidates.
      let normalizedPath: string;
      try {
        normalizedPath = resolveContainedPath(
          normalizedWorktree,
          expandHomePath(cleanPath, normalizedWorktree)
        );
      } catch {
        continue;
      }

      const filename = normalizedPath.split('/').pop() || cleanPath;

      // Filter obvious false positives (like version strings e.g. v1.2.3 or URL query params)
      if (!filename.includes('.') || filename.endsWith('.')) {
        continue;
      }

      // Check blacklist patterns on normalizedPath and filename
      if (
        allBlacklist.some(
          (pat) =>
            matchesBlacklistPattern(normalizedPath, pat) ||
            matchesBlacklistPattern(filename, pat)
        )
      ) {
        continue;
      }

      if (!detectedMap.has(normalizedPath)) {
        detectedMap.set(normalizedPath, {
          rawMatch: match[0].trim(),
          path: cleanPath,
          normalizedPath,
          filename,
          source: patternDef.source,
          harnessHint: patternDef.hint || options.harness,
          confidence: patternDef.confidence,
        });
      }
    }
  }

  return Array.from(detectedMap.values());
}
