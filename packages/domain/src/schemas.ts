import { z } from 'zod';

export const SessionStatusSchema = z.enum([
  'starting',
  'working',
  'needs_input',
  'idle',
  'done',
  'error',
  'disconnected',
]);

export const SessionCreationSourceSchema = z.enum(['ui', 'mcp']);

export const StatusSourceSchema = z.enum([
  'tmux',
  'process',
  'pty_activity',
  'terminal_prompt',
  'process_exit',
]);

export const SessionSignalsSchema = z.object({
  sessionId: z.string().min(1),
  hostReachable: z.boolean().default(true),
  tmuxSessionExists: z.boolean().default(false),
  paneExists: z.boolean().default(false),
  paneDead: z.boolean().default(false),
  paneCurrentCommand: z.string().optional(),
  panePid: z.number().int().positive().optional(),
  isPtyAttached: z.boolean().default(false),
  lastOutputAt: z.date().optional(),
  lastInputAt: z.date().optional(),
  recentOutputBytes: z.number().int().nonnegative().optional(),
  tailLines: z.array(z.string()).optional(),
  matchedPrompt: z.string().optional(),
  detectedPromptKind: z
    .enum(['confirmation', 'choice', 'text_input', 'shell_prompt', 'none'])
    .optional(),
  exitCode: z.number().int().optional(),
});

export const SessionStatusResultSchema = z.object({
  status: SessionStatusSchema,
  confidence: z.number().min(0).max(1),
  source: StatusSourceSchema,
  detectedPrompt: z.string().optional(),
  reason: z.string(),
  updatedAt: z.date().default(() => new Date()),
});

export const ArtifactDirectionSchema = z.enum(['input', 'output']);

export const ServerSchema = z.object({
  id: z.string().uuid().or(z.string().min(1)),
  name: z.string().min(1),
  host: z.string().min(1),
  sshUser: z.string().optional(),
  sshPort: z.number().int().min(1).max(65535).default(22),
  sshConfigAlias: z.string().optional(),
  enabled: z.boolean().default(true),
  createdAt: z.date().default(() => new Date()),
});

export const ProjectSchema = z.object({
  id: z.string().uuid().or(z.string().min(1)),
  serverId: z.string().min(1),
  name: z.string().min(1),
  rootPath: z.string().min(1),
  repoUrl: z.string().url().optional().or(z.literal('')),
  createdAt: z.date().default(() => new Date()),
});

export const AgentSchema = z.object({
  id: z.string().uuid().or(z.string().min(1)),
  name: z.string().min(1),
  harness: z.string().min(1),
  command: z.string().min(1),
  argsTemplate: z.array(z.string()).optional(),
  envVars: z.record(z.string(), z.string()).optional(),
  createdAt: z.date().default(() => new Date()),
});

export const SessionSchema = z.object({
  id: z.string().uuid().or(z.string().min(1)),
  name: z.string().min(1),
  parentSessionId: z.string().min(1).optional(),
  childAlias: z.string().min(1).optional(),
  serverId: z.string().min(1),
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  task: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  tmuxSessionName: z.string().min(1),
  tmuxWindowName: z.string().optional(),
  status: SessionStatusSchema.default('disconnected'),
  creationSource: SessionCreationSourceSchema.default('ui'),
  isExternal: z.boolean().default(false),
  createdAt: z.date().default(() => new Date()),
  lastActivityAt: z.date().default(() => new Date()),
}).superRefine((session, ctx) => {
  if (Boolean(session.parentSessionId) !== Boolean(session.childAlias)) {
    ctx.addIssue({ code: 'custom', path: ['parentSessionId'], message: 'parentSessionId and childAlias must be provided together' });
  }
});

export const ArtifactSchema = z.object({
  id: z.string().uuid().or(z.string().min(1)),
  sessionId: z.string().min(1),
  direction: ArtifactDirectionSchema,
  remotePath: z.string().min(1),
  cachedLocalPath: z.string().optional(),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.date().default(() => new Date()),
});
