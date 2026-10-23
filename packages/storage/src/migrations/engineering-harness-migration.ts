export const ENGINEERING_HARNESS_MIGRATION_SQL = `
ALTER TABLE goals ADD COLUMN engineering_metadata_json TEXT;
`;
