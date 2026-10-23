export const NATIVE_AUTOMATION_MIGRATION_SQL = `
CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_client_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','paused','blocked','completing','completed','failed','cancelled')),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT
);

CREATE TABLE automation_milestones (
  run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  milestone_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  title TEXT NOT NULL,
  goal_step_id TEXT NOT NULL,
  depends_on_json TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider = 'shell'),
  role TEXT NOT NULL CHECK(role IN ('blocking_job','supporting_service')),
  cancel_with_goal INTEGER NOT NULL CHECK(cancel_with_goal IN (0,1)),
  dispatch_json TEXT NOT NULL,
  dispatch_digest TEXT NOT NULL CHECK(length(dispatch_digest) = 64),
  verification_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','ready','dispatching','running','verifying','completed','blocked','failed','cancelled')),
  attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 0 AND 3),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, milestone_id),
  UNIQUE (run_id, position)
);

CREATE TABLE automation_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 3),
  provider TEXT NOT NULL CHECK(provider = 'shell'),
  dispatch_status TEXT NOT NULL CHECK(dispatch_status IN ('reserved','launched','dispatched_unresolved','terminal')),
  durable_task_id TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  terminal_state TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id, milestone_id) REFERENCES automation_milestones(run_id, milestone_id) ON DELETE CASCADE,
  UNIQUE (run_id, milestone_id, ordinal)
);

CREATE TABLE automation_events (
  run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 4095),
  kind TEXT NOT NULL,
  milestone_id TEXT,
  attempt_id TEXT,
  payload_json TEXT NOT NULL CHECK(length(payload_json) <= 16384),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
);

CREATE UNIQUE INDEX uq_automation_runs_live_goal
  ON automation_runs(goal_id)
  WHERE status IN ('active','paused','blocked','completing');
CREATE INDEX idx_automation_runs_owner
  ON automation_runs(owner_client_id, workspace_id, updated_at DESC);
CREATE INDEX idx_automation_milestones_status
  ON automation_milestones(run_id, status, position);
CREATE INDEX idx_automation_attempts_milestone
  ON automation_attempts(run_id, milestone_id, ordinal);
CREATE INDEX idx_automation_events_run_sequence
  ON automation_events(run_id, sequence);
`;
