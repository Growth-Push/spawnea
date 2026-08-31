import { describe, it, expect } from 'vitest';
import { HarnessLifecycleEventSchema } from '../src/harness.js';

describe('HarnessLifecycleEventSchema', () => {
  it('validates a valid lifecycle event', () => {
    const event = {
      sessionId: 'sess-123',
      harness: 'codex',
      eventType: 'turn_complete',
      timestamp: '2026-08-24T17:50:00Z',
      rawPayload: { type: 'agent-turn-complete', turnId: '1' },
      summary: 'Task complete',
    };

    const parsed = HarnessLifecycleEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sessionId).toBe('sess-123');
      expect(parsed.data.eventType).toBe('turn_complete');
    }
  });

  it('rejects an invalid event missing required fields', () => {
    const invalid = {
      sessionId: 'sess-123',
    };
    const parsed = HarnessLifecycleEventSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
  });
});
