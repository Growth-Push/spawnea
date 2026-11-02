/** Applied by the dashboard history migration once its ordering is agreed. */
export const dashboardHistorySchema = `
  CREATE TABLE dashboard_activity_samples (
    id INTEGER PRIMARY KEY,
    observed_at INTEGER NOT NULL,
    parents INTEGER NOT NULL CHECK (parents >= 0),
    children INTEGER NOT NULL CHECK (children >= 0),
    gap INTEGER NOT NULL CHECK (gap IN (0, 1))
  );
  CREATE INDEX dashboard_activity_samples_time ON dashboard_activity_samples(observed_at, id);
  CREATE INDEX dashboard_activity_samples_gaps ON dashboard_activity_samples(gap, observed_at, id);
  CREATE TABLE dashboard_closed_sessions (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    count INTEGER NOT NULL CHECK (count >= 0)
  );
  INSERT INTO dashboard_closed_sessions(singleton, count) VALUES (1, 0);
`;
