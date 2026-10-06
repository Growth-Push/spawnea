import { stripAnsi } from './prompt-detector.js';

export interface DetectAgentSessionIdOptions {
  harness?: string;
}

const AGENT_SESSION_PATTERNS = [
  // 1. Explicit CLI resume commands printed in banner or logs (e.g. "codex resume 0192-...", "claude --resume ...")
  /\b(?:codex|claude|agy|antigravity|hermes|openhands)\s+(?:resume|--resume|-r)\s+([a-zA-Z0-9_\-.:]+)/i,
  // 2. Explicit key-value headers (e.g. "Session ID: abc-123", "Conversation ID: ...")
  /^(?:[-*#>\s]*)(?:session|conversation)\s+id\s*:\s*([a-zA-Z0-9_\-.:]{6,})/i,
  // 3. Formatted UUID or long hex tokens with session/conversation label
  /^(?:[-*#>\s]*)Session:\s*([0-9a-fA-F]{8,}(?:-[0-9a-fA-F]{4,})*)/i,
  /^(?:[-*#>\s]*)Conversation:\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/i,
];

const KNOWN_HARNESSES = ['codex', 'claude', 'agy', 'antigravity', 'hermes', 'openhands'];

const HARNESS_ALIASES: Record<string, string[]> = {
  agy: ['agy', 'antigravity'],
  antigravity: ['agy', 'antigravity'],
};

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeHarnessName(harness?: string): string | undefined {
  if (!harness) return undefined;
  const trimmed = harness.trim();
  const colonIdx = trimmed.lastIndexOf(':');
  const stripped = colonIdx >= 0 ? trimmed.slice(colonIdx + 1) : trimmed;
  const base = stripped.split(/[/\\]/).pop() || stripped;
  return base.replace(/\.(exe|cmd|bat|sh|mjs|js)$/i, '').toLowerCase() || undefined;
}

function isValidCandidate(candidate: string): boolean {
  if (
    candidate.length < 4 ||
    candidate.startsWith('-') ||
    /^(true|false|null|none|undefined|started|stopped|running|pending|active)$/i.test(candidate)
  ) {
    return false;
  }
  // Reject plain dictionary words like "support" without an ID-like structure:
  // Must either contain a digit, or contain a separator (- _ . :) and be at least 8 characters long.
  const hasDigit = /\d/.test(candidate);
  const hasSeparator = /[_\-.:]/.test(candidate);
  if (!hasDigit && (!hasSeparator || candidate.length < 8)) {
    return false;
  }
  return true;
}

/**
 * Inspects recent tail buffer lines and detects any agent session, conversation,
 * or thread ID emitted by known harnesses (Codex, Claude, Hermes, Antigravity, etc.).
 */
export function detectAgentSessionId(
  tailLines: string[],
  options: DetectAgentSessionIdOptions = {}
): string | undefined {
  if (!tailLines || tailLines.length === 0) {
    return undefined;
  }

  const harnessName = normalizeHarnessName(options.harness);
  const harnessResumePattern = harnessName
    ? new RegExp(`\\b(?:${escapeRegex(harnessName)})\\s+(?:resume|--resume|-r)\\s+([a-zA-Z0-9_\\-.:]+)`, 'i')
    : undefined;

  // Scan from bottom to top (most recent lines first)
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const rawLine = tailLines[i];
    if (!rawLine) continue;
    const cleanLine = stripAnsi(rawLine).trim();
    if (!cleanLine) continue;

    if (harnessResumePattern) {
      const match = cleanLine.match(harnessResumePattern);
      if (match && match[1]) {
        const candidate = match[1].trim().replace(/[.:]+$/, '');
        if (isValidCandidate(candidate)) {
          return candidate;
        }
      }
    }

    for (const pattern of AGENT_SESSION_PATTERNS) {
      const match = cleanLine.match(pattern);
      if (match && match[1]) {
        const candidate = match[1].trim().replace(/[.:]+$/, '');
        if (isValidCandidate(candidate)) {
          // If a specific harness was requested, do not match banners clearly identifying a different harness
          if (harnessName) {
            const allowedAliases = HARNESS_ALIASES[harnessName] || [harnessName];
            const isOtherHarness = KNOWN_HARNESSES.some((h) => {
              if (allowedAliases.includes(h)) return false;
              const boundaryRegex = new RegExp(`\\b${escapeRegex(h)}\\b`, 'i');
              return boundaryRegex.test(cleanLine) || candidate.toLowerCase().startsWith(`${h}-`);
            });
            if (isOtherHarness) {
              continue;
            }
          }
          return candidate;
        }
      }
    }
  }

  return undefined;
}
