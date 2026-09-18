-- Step offsets become calendar days (18 September 2026): "three days after the call" includes the
-- weekend, and a step that lands on a day nobody works rolls forward to the next working day.
-- Every stored plan was written in business days, so each day d becomes d + 2 * floor((d - 1) / 5),
-- which keeps every step on the same actual date for a Monday start. A plan also carries how many
-- days it spans, set here to its last step.
ALTER TABLE "Sequence" ADD COLUMN "durationDays" INTEGER;

UPDATE "Sequence" s
SET "steps" = (
  SELECT COALESCE(jsonb_agg(
    jsonb_set(step, '{day}', to_jsonb(((step->>'day')::int) + 2 * (((step->>'day')::int - 1) / 5)))
    ORDER BY ordinality
  ), '[]'::jsonb)
  FROM jsonb_array_elements(s."steps"::jsonb) WITH ORDINALITY AS t(step, ordinality)
)
WHERE jsonb_typeof(s."steps"::jsonb) = 'array' AND jsonb_array_length(s."steps"::jsonb) > 0;

UPDATE "Sequence" s
SET "durationDays" = (
  SELECT MAX((step->>'day')::int) FROM jsonb_array_elements(s."steps"::jsonb) AS step
)
WHERE jsonb_typeof(s."steps"::jsonb) = 'array' AND jsonb_array_length(s."steps"::jsonb) > 0;
