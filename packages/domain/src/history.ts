import { z } from 'zod';

export type SessionHistoryRole = 'user' | 'agent' | 'tool';

export type SessionHistorySource = 'transcript' | 'screen';

export type TurnBoundary = 'start' | 'end' | 'single';

export interface SessionHistoryItem {
  id: string;
  role: SessionHistoryRole;
  text: string;
  timestamp?: string;
  source: SessionHistorySource;
  turnBoundary?: TurnBoundary;
  turnId?: string;
  textTruncated?: boolean;
}

export interface SessionHistoryQuery {
  limit?: number;
  cursor?: string;
  maxItemChars?: number;
  mode?: 'recent_exchanges' | 'forward';
  recentExchanges?: number;
}

export interface SessionHistoryResult {
  sessionId: string;
  source: SessionHistorySource;
  items: SessionHistoryItem[];
  cursor?: string;
  hasMore?: boolean;
  transcriptPath?: string;
  captureSuccess?: boolean;
}

export const SessionHistoryRoleSchema = z.enum(['user', 'agent', 'tool']);

export const SessionHistorySourceSchema = z.enum(['transcript', 'screen']);

export const TurnBoundarySchema = z.enum(['start', 'end', 'single']);

export const SessionHistoryItemSchema = z.object({
  id: z.string(),
  role: SessionHistoryRoleSchema,
  text: z.string(),
  timestamp: z.string().optional(),
  source: SessionHistorySourceSchema,
  turnBoundary: TurnBoundarySchema.optional(),
  turnId: z.string().optional(),
  textTruncated: z.boolean().optional(),
});

export const SessionHistoryQuerySchema = z.object({
  limit: z.number().int().positive().optional(),
  cursor: z.string().optional(),
  maxItemChars: z.number().int().positive().optional(),
  mode: z.enum(['recent_exchanges', 'forward']).optional(),
  recentExchanges: z.number().int().positive().optional(),
});

export const SessionHistoryResultSchema = z.object({
  sessionId: z.string(),
  source: SessionHistorySourceSchema,
  items: z.array(SessionHistoryItemSchema),
  cursor: z.string().optional(),
  hasMore: z.boolean().optional(),
  transcriptPath: z.string().optional(),
  captureSuccess: z.boolean().optional(),
});
