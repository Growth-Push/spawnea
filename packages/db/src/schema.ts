import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';
import type { SessionStatus, SessionCreationSource, ArtifactDirection } from '@spawnea/domain';

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
    worktreePath: text('worktree_path').notNull(),
    branch: text('branch').notNull(),
    baseBranch: text('base_branch'),
    baseCommit: text('base_commit'),
    managedWorktree: integer('managed_worktree', { mode: 'boolean' }).notNull().default(false),
    tmuxSessionName: text('tmux_session_name').notNull(),
    tmuxWindowName: text('tmux_window_name'),
    status: text('status').$type<SessionStatus>().notNull().default('disconnected'),
    creationSource: text('creation_source').$type<SessionCreationSource>().notNull().default('ui'),
    parentSessionId: text('parent_session_id'),
    childAlias: text('child_alias'),
    isExternal: integer('is_external', { mode: 'boolean' }).notNull().default(false),
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
