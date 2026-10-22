import { join } from 'node:path';
import type { Logger, StateRulesStatus } from '@spawnea/domain';
import { formatStateRulesError, loadStateRules, StateDetector, USER_STATE_RULES_FILE_NAME } from '@spawnea/state';

export interface StateRulesRuntime {
  /** Detector shared by every consumer, so all use the same compiled rules. */
  detector: StateDetector;
  status: StateRulesStatus;
}

/**
 * Loads, validates, and compiles the state rules once at startup. The user
 * file is not watched or reread; edits apply when Spawnea restarts. An invalid
 * user file is ignored completely in favor of the factory rules and reported.
 */
export function initializeStateRules(
  userDataPath: string,
  logger: Logger,
  readFile?: (path: string) => string
): StateRulesRuntime {
  const { ruleSet, status } = loadStateRules({
    userFilePath: join(userDataPath, USER_STATE_RULES_FILE_NAME),
    readFile,
  });
  if (status.error) {
    logger.error('Ignoring invalid user state rules; using factory rules', {
      filePath: status.userFilePath,
      harness: status.error.harness,
      position: status.error.position,
      line: status.error.line,
      error: formatStateRulesError(status.error),
    });
  } else {
    logger.info('State rules loaded', {
      source: status.source,
      filePath: status.userFilePath,
      harnesses: ruleSet.harnesses(),
    });
  }
  return { detector: new StateDetector({ rules: ruleSet }), status };
}
