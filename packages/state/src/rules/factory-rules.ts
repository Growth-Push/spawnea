// The declaration must reach consumers that compile this package from source.
// eslint-disable-next-line typescript/triple-slash-reference
/// <reference path="./yaml-raw.d.ts" />
import factoryRulesYaml from './state-rules.yaml?raw';
import { parseStateRules, StateRuleSet } from './rule-config.js';
import type { CompiledStateRules } from './rule-config.js';

/** File name reported for factory rule references and errors. */
export const FACTORY_STATE_RULES_FILE = 'state-rules.yaml (factory)';

/** Source text of the factory rules bundled with Spawnea. */
export const FACTORY_STATE_RULES_YAML: string = factoryRulesYaml;

let factoryRules: CompiledStateRules | undefined;

/**
 * Compiled factory rules. An invalid factory file throws, which fails tests,
 * the build check, and application startup.
 */
export function getFactoryStateRules(): CompiledStateRules {
  factoryRules ??= parseStateRules(FACTORY_STATE_RULES_YAML, FACTORY_STATE_RULES_FILE, 'factory');
  return factoryRules;
}

let factoryRuleSet: StateRuleSet | undefined;

/** Rule set with only the factory rules, used when no rule set is supplied. */
export function getFactoryStateRuleSet(): StateRuleSet {
  factoryRuleSet ??= new StateRuleSet(getFactoryStateRules(), 'factory');
  return factoryRuleSet;
}
