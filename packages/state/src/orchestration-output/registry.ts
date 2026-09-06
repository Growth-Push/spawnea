import type { HarnessOutputAdapter } from './types.js';
import { GenericHarnessOutputAdapter } from './generic.js';
import { CodexHarnessOutputAdapter } from './codex.js';
import { HermesHarnessOutputAdapter } from './hermes.js';
import { AntigravityHarnessOutputAdapter } from './antigravity.js';

export function resolveHarnessOutputAdapter(harness: string | undefined): HarnessOutputAdapter {
  const normalized = harness?.trim().toLowerCase();
  if (normalized === 'codex') return new CodexHarnessOutputAdapter();
  if (normalized === 'hermes') return new HermesHarnessOutputAdapter();
  if (normalized === 'antigravity' || normalized === 'agy') return new AntigravityHarnessOutputAdapter();
  return new GenericHarnessOutputAdapter();
}
