ALTER TABLE "somatic_clinical_assertions"
ADD COLUMN "proposalFlags" jsonb
DEFAULT '{"conflict":false,"reasonCodes":[],"diseaseMatches":[],"appliedRule":null}'::jsonb
NOT NULL;--> statement-breakpoint

ALTER TABLE "somatic_clinical_assertions"
ADD CONSTRAINT "somatic_clinical_assertions_proposal_flags_ck"
CHECK (
  jsonb_typeof("proposalFlags") = 'object'
  AND jsonb_typeof("proposalFlags"->'conflict') = 'boolean'
  AND jsonb_typeof("proposalFlags"->'reasonCodes') = 'array'
  AND jsonb_typeof("proposalFlags"->'diseaseMatches') = 'array'
  AND ("proposalFlags"->'appliedRule' = 'null'::jsonb OR jsonb_typeof("proposalFlags"->'appliedRule') = 'object')
);
