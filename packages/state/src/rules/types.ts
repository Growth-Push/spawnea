export type RuleCategory =
  | 'confirmation'
  | 'choice'
  | 'question'
  | 'idle_prompt'
  | 'error'
  | 'working'
  | 'shell_prompt';

export interface PatternRule {
  id: string;
  name: string;
  category: RuleCategory;
  pattern: RegExp | string;
  confidence?: number;
  description?: string;
  harness?: string;
}

export interface HarnessRules {
  harness: string;
  confirmationPatterns?: (RegExp | string)[];
  choicePatterns?: (RegExp | string)[];
  questionPatterns?: (RegExp | string)[];
  idlePromptPatterns?: (RegExp | string)[];
  errorPatterns?: (RegExp | string)[];
}

export interface DetectionRulesConfig {
  rules: PatternRule[];
  harnessRules?: Record<string, HarnessRules>;
}
