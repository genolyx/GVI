-- `curation_runs` is written by the Engine API using raw SQL for the
-- `FOR UPDATE SKIP LOCKED` claim, which bypasses Drizzle's `$onUpdate` hook.
-- The trigger from migration 0001 is what keeps `updatedAt` honest there.

CREATE TRIGGER curation_runs_set_updated_at
  BEFORE UPDATE ON curation_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
