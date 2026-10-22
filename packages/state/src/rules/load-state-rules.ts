import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { StateRulesStatus } from '@spawnea/domain';
import { getFactoryStateRules } from './factory-rules.js';
import { mergeStateRules, parseStateRules, StateRuleSet, StateRulesConfigError } from './rule-config.js';

/** File name of the optional user rules inside the application user-data directory. */
export const USER_STATE_RULES_FILE_NAME = 'state-rules.yaml';

export interface LoadStateRulesOptions {
  /** Absolute path of the optional user rules file. */
  userFilePath: string;
  /** Injected for tests; defaults to a synchronous UTF-8 read. */
  readFile?: (path: string) => string;
}

export interface LoadedStateRules {
  ruleSet: StateRuleSet;
  status: StateRulesStatus;
}

/**
 * Loads, validates, and compiles the state rules once. A missing user file
 * uses the factory rules; an invalid one is ignored completely and reported.
 * Nothing watches or rereads the file afterwards.
 */
export function loadStateRules(options: LoadStateRulesOptions): LoadedStateRules {
  const factory = getFactoryStateRules();
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  let text: string;
  try {
    text = readFile(options.userFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return factoryOnly(options.userFilePath);
    }
    return invalidUser(options.userFilePath, {
      file: basename(options.userFilePath),
      message: `Could not read the file: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  try {
    const user = parseStateRules(text, basename(options.userFilePath), 'user');
    return {
      ruleSet: new StateRuleSet(mergeStateRules(factory, user), 'merged'),
      status: { source: 'merged', userFilePath: options.userFilePath },
    };
  } catch (error) {
    if (error instanceof StateRulesConfigError) {
      return invalidUser(options.userFilePath, error.detail);
    }
    throw error;
  }

  function factoryOnly(userFilePath: string): LoadedStateRules {
    return {
      ruleSet: new StateRuleSet(factory, 'factory'),
      status: { source: 'factory', userFilePath },
    };
  }

  function invalidUser(userFilePath: string, error: StateRulesConfigError['detail']): LoadedStateRules {
    return {
      ruleSet: new StateRuleSet(factory, 'user_invalid', error),
      status: { source: 'user_invalid', userFilePath, error },
    };
  }
}
