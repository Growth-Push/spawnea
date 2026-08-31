import { z } from 'zod';
import { maskSensitiveString } from './logger.js';
import { SessionCreationSourceSchema, SessionStatusSchema } from './schemas.js';

export const SessionContextHostSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    ssh: z
      .object({
        target: z.string().min(1),
        user: z.string().optional(),
        port: z.number().int().min(1).max(65535).optional(),
      })
      .optional(),
  })
  .strict();

export const SessionContextProjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    path: z.string().min(1),
    git_url: z.string().optional(),
  })
  .strict();

export const SessionContextHarnessSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
  })
  .strict();

export const SessionContextPersistentSessionSchema = z
  .object({
    type: z.literal('tmux'),
    name: z.string().min(1),
    window: z.string().optional(),
  })
  .strict();

export const SessionContextReconnectTargetSchema = z
  .object({
    type: z.literal('tmux'),
    name: z.string().min(1),
    hostId: z.string().min(1),
  })
  .strict();

export const SessionContextFileSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1),
    sessionName: z.string().min(1),
    task: z.string().min(1),
    host: SessionContextHostSchema,
    project: SessionContextProjectSchema,
    worktree: z
      .object({
        managed: z.boolean(),
        path: z.string().min(1),
        branch: z.string().min(1),
        baseBranch: z.string().min(1),
        baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/i).optional(),
      })
      .strict()
      .optional(),
    harness: SessionContextHarnessSchema,
    persistentSession: SessionContextPersistentSessionSchema,
    reconnectTarget: SessionContextReconnectTargetSchema,
    status: SessionStatusSchema,
    creationSource: SessionCreationSourceSchema.optional(),
    isExternal: z.boolean().optional(),
    createdAt: z.string().datetime({ offset: true }).or(z.string()),
    updatedAt: z.string().datetime({ offset: true }).or(z.string()),
  })
  .strict();

export type SessionContextFile = z.infer<typeof SessionContextFileSchema>;

export interface ContextValidationError {
  path: string;
  message: string;
}

export type ContextValidationResult =
  | { success: true; context: SessionContextFile; errors?: never }
  | { success: false; context?: never; errors: ContextValidationError[] };

/**
 * Validates a parsed object against the SessionContextFile specification.
 */
export function validateSessionContext(raw: unknown): ContextValidationResult {
  if (!raw || typeof raw !== 'object') {
    return {
      success: false,
      errors: [{ path: 'root', message: 'Session context must be a JSON object' }],
    };
  }

  const result = SessionContextFileSchema.safeParse(raw);
  if (!result.success) {
    const errors: ContextValidationError[] = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: maskSensitiveString(issue.message),
    }));
    return { success: false, errors };
  }

  return { success: true, context: result.data };
}

/**
 * Parses and validates a JSON string representing a Session Context File.
 */
export function parseSessionContextFile(jsonContent: string): ContextValidationResult {
  if (!jsonContent || jsonContent.trim() === '') {
    return {
      success: false,
      errors: [{ path: 'root', message: 'Session context content is empty' }],
    };
  }

  try {
    const parsed = JSON.parse(jsonContent);
    return validateSessionContext(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errors: [{ path: 'json', message: `Invalid JSON format: ${message}` }],
    };
  }
}

/**
 * Serializes a SessionContextFile to a formatted JSON string.
 */
export function serializeSessionContextFile(context: SessionContextFile): string {
  return JSON.stringify(context, null, 2);
}
