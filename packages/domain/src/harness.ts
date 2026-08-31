import { z } from 'zod';
import type { SessionStatus, StatusSource } from './index.js';

export const HarnessLifecycleEventSchema = z.object({
  id: z.string().optional(),
  sessionId: z.string(),
  harness: z.string(),
  eventType: z.string(),
  timestamp: z.string(),
  rawPayload: z.union([z.record(z.unknown()), z.string()]).optional(),
  summary: z.string().optional(),
});

export type HarnessLifecycleEvent = z.infer<typeof HarnessLifecycleEventSchema>;

export interface SessionStatusObservation {
  status: SessionStatus;
  confidence: number;
  source: StatusSource;
  reason: string;
  detectedPrompt?: string;
  lastEvent?: HarnessLifecycleEvent;
  observedAt: Date;
}

