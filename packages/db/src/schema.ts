import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';
import type {
  SessionStatus,
  SessionCreationSource,
  ArtifactDirection,
  SessionTopologySnapshot,
  PersistedControlTurnStatus,
  TurnRequestDeliveryStatus,
  SessionHistorySource,
} from '@spawnea/domain';

export const servers = sqliteTable('servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  host: text('host').notNull(),
  sshUser: text('ssh_user'),
  sshPort: integer('ssh_port').notNull().default(22),
  sshConfigAlias: text('ssh_config_alias'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  rootPath: text('root_path').notNull(),
  repoUrl: text('repo_url'),
  baseBranch: text('base_branch'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  harness: text('harness').notNull(),
  command: text('command').notNull(),
  argsTemplate: text('args_template', { mode: 'json' }).$type<string[]>(),
  envVars: text('env_vars', { mode: 'json' }).$type<Record<string, string>>(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'restrict' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),
    task: text('task').notNull(),
    originIssueUrl: text('origin_issue_url'),
    worktreePath: text('worktree_path').notNull(),
    branch: text('branch').notNull(),
    baseBranch: text('base_branch'),
    baseCommit: text('base_commit'),
    managedWorktree: integer('managed_worktree', { mode: 'boolean' }).notNull().default(false),
    tmuxSessionName: text('tmux_session_name').notNull(),
    tmuxWindowName: text('tmux_window_name'),
    status: text('status').$type<SessionStatus>().notNull().default('disconnected'),
    creationSource: text('creation_source').$type<SessionCreationSource>().notNull().default('ui'),
    requestedModel: text('requested_model'),
    parentSessionId: text('parent_session_id'),
    childAlias: text('child_alias'),
    isExternal: integer('is_external', { mode: 'boolean' }).notNull().default(false),
    savedTopology: text('saved_topology', { mode: 'json' }).$type<SessionTopologySnapshot>(),
    agentSessionId: text('agent_session_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    lastActivityAt: integer('last_activity_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('idx_sessions_server_id').on(table.serverId),
    index('idx_sessions_project_id').on(table.projectId),
    index('idx_sessions_parent_session_id').on(table.parentSessionId),
    uniqueIndex('idx_sessions_parent_child_alias').on(table.parentSessionId, table.childAlias),
  ],
);

export const githubProjectSettings = sqliteTable('github_project_settings', {
  projectId: text('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  trackerEnabled: integer('tracker_enabled', { mode: 'boolean' }).notNull().default(false),
  ciEnabled: integer('ci_enabled', { mode: 'boolean' }).notNull().default(false),
});

export const sessionLinks = sqliteTable('session_links', {
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  kind: text('kind').notNull(),
  source: text('source').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [uniqueIndex('idx_session_links_identity').on(table.sessionId, table.url, table.source)]);

export const sessionOutputSnapshots = sqliteTable(
  'session_output_snapshots',
  {
    sessionId: text('session_id').primaryKey().references(() => sessions.id, { onDelete: 'cascade' }),
    output: text('output').notNull(),
    truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
    snapshotGeneration: text('snapshot_generation').notNull().default(''),
    version: integer('version').notNull().default(1),
    source: text('source').$type<SessionHistorySource>().notNull().default('screen'),
    historyItemsJson: text('history_items_json').notNull().default('[]'),
    historyTruncated: integer('history_truncated', { mode: 'boolean' }).notNull().default(false),
    payloadBytes: integer('payload_bytes').notNull().default(0),
    capturedAt: integer('captured_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('idx_session_output_snapshots_updated_at').on(table.updatedAt)],
);

export const sessionTurns = sqliteTable(
  'session_turns',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    harness: text('harness').notNull(),
    prompt: text('prompt').notNull(),
    output: text('output').notNull(),
    outputGeneration: integer('output_generation').notNull().default(1),
    baseOffset: integer('base_offset').notNull().default(0),
    version: integer('version').notNull().default(1),
    status: text('status').$type<PersistedControlTurnStatus>().notNull(),
    observedWorking: integer('observed_working', { mode: 'boolean' }).notNull().default(false),
    outputChanges: integer('output_changes').notNull().default(0),
    promptDelimiterPairs: integer('prompt_delimiter_pairs').notNull().default(0),
    submissionUncertain: integer('submission_uncertain', { mode: 'boolean' }).notNull().default(false),
    interrupted: integer('interrupted', { mode: 'boolean' }).notNull().default(false),
    truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
    payloadBytes: integer('payload_bytes').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    changedAt: integer('changed_at').notNull(),
  },
  (table) => [
    index('idx_session_turns_session_changed').on(table.sessionId, table.changedAt, table.createdAt),
    index('idx_session_turns_changed_at').on(table.changedAt),
  ],
);

export const sessionTurnRequests = sqliteTable(
  'session_turn_requests',
  {
    sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    clientRequestId: text('client_request_id').notNull(),
    turnId: text('turn_id').notNull().references(() => sessionTurns.id, { onDelete: 'cascade' }),
    fingerprintHash: text('fingerprint_hash').notNull(),
    delivered: integer('delivered', { mode: 'boolean' }).notNull().default(false),
    deliveryMethod: text('delivery_method').$type<'pty' | 'tmux'>().notNull(),
    deliveryStatus: text('delivery_status').$type<TurnRequestDeliveryStatus>().notNull(),
    acceptedAt: integer('accepted_at').notNull(),
    payloadBytes: integer('payload_bytes').notNull().default(0),
  },
  (table) => [
    uniqueIndex('idx_session_turn_requests_pk').on(table.sessionId, table.clientRequestId),
    index('idx_session_turn_requests_turn_id').on(table.turnId),
    index('idx_session_turn_requests_accepted_at').on(table.acceptedAt),
  ],
);

export const sessionChildAliasCounters = sqliteTable(
  'session_child_alias_counters',
  {
    parentSessionId: text('parent_session_id')
      .primaryKey()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    nextAliasIndex: integer('next_alias_index').notNull().default(1),
  },
);

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    direction: text('direction').$type<ArtifactDirection>().notNull(),
    remotePath: text('remote_path').notNull(),
    cachedLocalPath: text('cached_local_path'),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('idx_artifacts_session_id').on(table.sessionId),
  ],
);

export const serversRelations = relations(servers, ({ many }) => ({
  projects: many(projects),
  sessions: many(sessions),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  server: one(servers, {
    fields: [projects.serverId],
    references: [servers.id],
  }),
  sessions: many(sessions),
}));

export const agentsRelations = relations(agents, ({ many }) => ({
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  server: one(servers, {
    fields: [sessions.serverId],
    references: [servers.id],
  }),
  project: one(projects, {
    fields: [sessions.projectId],
    references: [projects.id],
  }),
  agent: one(agents, {
    fields: [sessions.agentId],
    references: [agents.id],
  }),
  parent: one(sessions, {
    fields: [sessions.parentSessionId],
    references: [sessions.id],
    relationName: 'sessionHierarchy',
  }),
  children: many(sessions, {
    relationName: 'sessionHierarchy',
  }),
  artifacts: many(artifacts),
}));

export const artifactsRelations = relations(artifacts, ({ one }) => ({
  session: one(sessions, {
    fields: [artifacts.sessionId],
    references: [sessions.id],
  }),
}));

export type ServerRow = typeof servers.$inferSelect;
export type NewServerRow = typeof servers.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type AgentRow = typeof agents.$inferSelect;
export type NewAgentRow = typeof agents.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type SessionChildAliasCounterRow = typeof sessionChildAliasCounters.$inferSelect;
export type NewSessionChildAliasCounterRow = typeof sessionChildAliasCounters.$inferInsert;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type NewArtifactRow = typeof artifacts.$inferInsert;
export type SessionOutputSnapshotRow = typeof sessionOutputSnapshots.$inferSelect;
export type SessionTurnRow = typeof sessionTurns.$inferSelect;
export type SessionTurnRequestRow = typeof sessionTurnRequests.$inferSelect;
