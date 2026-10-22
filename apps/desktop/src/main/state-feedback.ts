import type {
  SessionStatusResult,
  StateFeedbackCapture,
  StateFeedbackDecision,
  StateFeedbackReport,
  StateFeedbackRulesConfig,
} from '@spawnea/domain';
import type { StateRuleSet } from '@spawnea/state';

export const STATE_FEEDBACK_SCHEMA_VERSION = '2.0.0';

/** Saved when host or tmux communication fails; the underlying error goes only to the log. */
export const FEEDBACK_CAPTURE_FAILED_REASON = 'Host or tmux communication failed during capture';

/** Which decision step produced a detected status. */
export function feedbackDecision(result: SessionStatusResult): StateFeedbackDecision {
  if (result.matchedRule) {
    return { kind: 'rule', rule: { ...result.matchedRule } };
  }
  if (result.fallback) {
    return { kind: 'fallback' };
  }
  return { kind: 'connection' };
}

/**
 * Describes the rules configuration of this run. The invalid user file's
 * location is kept; its path, message, and pattern text are not.
 */
export function feedbackRulesConfig(ruleSet: StateRuleSet): StateFeedbackRulesConfig {
  const error = ruleSet.userError;
  return {
    source: ruleSet.configSource,
    ...(error
      ? {
          error: {
            file: error.file,
            ...(error.harness !== undefined ? { harness: error.harness } : {}),
            ...(error.position !== undefined ? { position: error.position } : {}),
            ...(error.line !== undefined ? { line: error.line } : {}),
          },
        }
      : {}),
  };
}

function sanitizeDecision(decision: StateFeedbackDecision | undefined): StateFeedbackDecision | undefined {
  if (!decision) {
    return undefined;
  }
  if (decision.kind === 'rule') {
    const { file, harness, position } = decision.rule;
    return { kind: 'rule', rule: { file, harness, position } };
  }
  return { kind: decision.kind };
}

function sanitizeCapture(capture: StateFeedbackCapture | undefined): StateFeedbackCapture {
  if (capture?.status === 'captured') {
    return { status: 'captured' };
  }
  return { status: 'failed', reason: capture?.reason || 'Terminal snapshot was not captured' };
}

/**
 * Builds the saved report from an allowlist of fields. The rules configuration
 * comes from the main process, not the renderer. A failed capture drops every
 * detection field and the tail, so nothing is guessed or carried over.
 */
export function buildFeedbackPayload(
  report: StateFeedbackReport,
  rulesConfig: StateFeedbackRulesConfig
): Record<string, unknown> {
  const capture = sanitizeCapture(report.capture);
  const captured = capture.status === 'captured';
  return {
    schemaVersion: STATE_FEEDBACK_SCHEMA_VERSION,
    sessionId: report.sessionId,
    sessionName: report.sessionName,
    harness: report.harness,
    worktreePath: report.worktreePath,
    branch: report.branch,
    observedStatus: report.observedStatus,
    expectedStatus: report.expectedStatus,
    capture,
    detectedStatus: captured ? report.detectedStatus : undefined,
    detectedSource: captured ? report.detectedSource : undefined,
    detectedConfidence: captured ? report.detectedConfidence : undefined,
    detectedPrompt: captured ? report.detectedPrompt : undefined,
    detectionReason: captured ? report.detectionReason : undefined,
    decision: captured ? sanitizeDecision(report.decision) : undefined,
    rulesConfig,
    userNotes: report.userNotes || '',
    tailLines: captured ? report.tailLines || [] : [],
    timestamp: report.timestamp || new Date().toISOString(),
  };
}
