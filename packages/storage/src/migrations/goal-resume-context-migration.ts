/** Persist reconstruction-grade resume context atomically with each goal checkpoint. */
export const GOAL_RESUME_CONTEXT_MIGRATION_SQL = `
ALTER TABLE goal_checkpoints ADD COLUMN resume_context_json TEXT;
`;
