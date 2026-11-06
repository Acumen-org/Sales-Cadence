-- B165: a calling number belongs to its rep from the moment it was assigned. Calls on the line from
-- before then keep the rep they had (none). Null on numbers assigned before this release: those
-- assignments keep counting for every call, as they always did.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "callerNumberSince" TIMESTAMP(3);

-- N043: the "What" of the form's next step, as the next action reads it ("Follow up: wants a deck").
ALTER TABLE "CallForm" ADD COLUMN IF NOT EXISTS "nextStepLabel" TEXT;
-- B025, B029: what leaders should look at on a call: long_voicemail, no_conversation, called_opted_out.
ALTER TABLE "CallForm" ADD COLUMN IF NOT EXISTS "flags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
