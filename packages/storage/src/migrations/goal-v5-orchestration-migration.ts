export const GOAL_V5_ORCHESTRATION_MIGRATION_SQL = `
ALTER TABLE goals ADD COLUMN acceptance_criteria_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE goals ADD COLUMN user_intent_revision INTEGER NOT NULL DEFAULT 0 CHECK(user_intent_revision >= 0);
ALTER TABLE goals ADD COLUMN iteration_policy_json TEXT NOT NULL DEFAULT '{"mode":"outcome","maxIterations":1,"currentIteration":0,"stopOnNoNewEvidence":true}';
ALTER TABLE goals ADD COLUMN current_context_capsule_id TEXT;

CREATE TABLE IF NOT EXISTS goal_context_capsules (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL,
  source_goal_revision INTEGER NOT NULL CHECK(source_goal_revision >= 0),
  source_user_intent_revision INTEGER NOT NULL CHECK(source_user_intent_revision >= 0),
  previous_capsule_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(goal_id) REFERENCES goals(id) ON DELETE RESTRICT,
  FOREIGN KEY(previous_capsule_id) REFERENCES goal_context_capsules(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_goal_context_capsules_goal_created
  ON goal_context_capsules(goal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS goal_delivery_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','attempted_unresolved','dispatched_unresolved','host_confirmed','completed','cancelled','retired')),
  based_on_user_intent_revision INTEGER NOT NULL CHECK(based_on_user_intent_revision >= 0),
  external_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(goal_id) REFERENCES goals(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_goal_delivery_receipts_goal_updated
  ON goal_delivery_receipts(goal_id, updated_at DESC);
`;
