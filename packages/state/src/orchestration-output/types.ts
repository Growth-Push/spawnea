export interface OmittedOutputBlock {
  adapter: string;
  rule: string;
  category: 'chrome' | 'progress' | 'tool_activity';
  lineCount: number;
}

export interface CompactOutputResult {
  output: string;
  omitted: OmittedOutputBlock[];
}

export interface HarnessOutputAdapter {
  readonly id: string;
  compact(output: string): CompactOutputResult;
}
