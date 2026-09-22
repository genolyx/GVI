-- Postgres has no `ON UPDATE CURRENT_TIMESTAMP`. Drizzle's `$onUpdate` covers writes
-- that go through the ORM; this trigger covers raw SQL and anything else that bypasses it.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW."updatedAt" = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DO $$
DECLARE
  target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'users',
    'organizations',
    'organization_members',
    'projects',
    'cases',
    'analysis_jobs',
    'variants',
    'interpretations',
    'criteria_assessments',
    'ai_conversations',
    'reports'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      target_table || '_set_updated_at',
      target_table
    );
  END LOOP;
END;
$$;
