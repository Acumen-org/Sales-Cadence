-- Fill the new columns from what the rows already say (PLAN 9.7 steps 5, 6 and 7, W1). Every statement
-- is deterministic and only fills what is still empty, so it cannot fail on today's rows and running
-- it again changes nothing. One audit row (cold_outreach_backfill) records what it filled, and which
-- calls and contacts it could not give a pod, when it changed anything.
DO $$
DECLARE
  stamp timestamp(3) := now() AT TIME ZONE 'UTC';
  undo_days integer;
  call_pods integer; meeting_kinds integer; opt_out_sources integer; pusher_names integer; first_claims integer;
  removers integer; outcomes integer; role_emails integer; undo_deadlines integer; email_norms integer;
  extra_email_norms integer; person_opt_outs integer; person_sources integer; suppression_sources integer; contact_pods integer;
  calls_without_pod text[]; contacts_without_pod text[];
BEGIN
  -- Calls: the pod each counts for, at the time (B040): the enrollment's, else the contact's (a cold
  -- contact's pod, or the pod a CRM person's podOwner names), else the rep's pod when they have one.
  WITH pods AS (
    SELECT c."id", COALESCE(
      (SELECT e."podId" FROM "Enrollment" e WHERE e."id" = c."enrollmentId"),
      (SELECT s."podId" FROM "SandboxContact" s WHERE s."id" = c."sandboxContactId"),
      (SELECT p."id" FROM "PersonCache" pc JOIN "Pod" p ON p."podOwnerValue" = pc."podOwner" WHERE pc."id" = c."personId"),
      (SELECT MIN(up."podId") FROM "UserPod" up WHERE up."userId" = c."userId" HAVING COUNT(*) = 1)
    ) AS "podId"
    FROM "CallLog" c WHERE c."podId" IS NULL
  )
  UPDATE "CallLog" c SET "podId" = pods."podId" FROM pods WHERE pods."id" = c."id" AND pods."podId" IS NOT NULL;
  GET DIAGNOSTICS call_pods = ROW_COUNT;
  -- A rep's call that still has no pod (a rep in several pods, or in none) is listed for a leader.
  SELECT array_agg(x."id" ORDER BY x."startedAt") INTO calls_without_pod
  FROM (SELECT "id", "startedAt" FROM "CallLog" WHERE "podId" IS NULL AND "userId" IS NOT NULL ORDER BY "startedAt" LIMIT 500) x;

  -- A cold contact with an owner but no pod can never move (B050): an owner in exactly one pod fills
  -- it. Owners in several pods or none (admins, Biz Ops) are listed for a leader to choose.
  UPDATE "SandboxContact" s SET "podId" = (SELECT MIN(up."podId") FROM "UserPod" up WHERE up."userId" = s."ownerId")
  WHERE s."podId" IS NULL AND s."ownerId" IS NOT NULL AND s."status" = 'ACTIVE'
    AND (SELECT COUNT(*) FROM "UserPod" up WHERE up."userId" = s."ownerId") = 1;
  GET DIAGNOSTICS contact_pods = ROW_COUNT;
  SELECT array_agg(x."id" ORDER BY x."id") INTO contacts_without_pod
  FROM (SELECT "id" FROM "SandboxContact" WHERE "podId" IS NULL AND "ownerId" IS NOT NULL AND "status" = 'ACTIVE' ORDER BY "id" LIMIT 500) x;

  -- A post-call form's "Meeting" next step was stored as a Call (B183): mark those as meetings.
  UPDATE "NextAction" n SET "kind" = 'MEETING'
  WHERE n."kind" = 'ACTION' AND n."label" = 'Meeting' AND n."action" = 'CALL'
    AND EXISTS (SELECT 1 FROM "CallForm" f WHERE f."nextActionId" = n."id" AND f."nextStep" = 'meeting');
  GET DIAGNOSTICS meeting_kinds = ROW_COUNT;

  -- Where each cold opt-out came from: its own audit row, else the source written as its reason.
  WITH sources AS (
    SELECT s."id", COALESCE(
      (SELECT a."details"->>'source' FROM "AuditLog" a WHERE a."entityType" = 'sandbox_contact' AND a."entityId" = s."id" AND a."action" = 'opted_out' ORDER BY a."createdAt" DESC LIMIT 1),
      CASE WHEN s."optOutReason" IN ('call_form', 'contact_page', 'suppression_list', 'skip_reason', 'erase') THEN s."optOutReason" END
    ) AS source
    FROM "SandboxContact" s WHERE s."optOutSource" IS NULL AND s."optedOutAt" IS NOT NULL
  )
  UPDATE "SandboxContact" s SET "optOutSource" = sources.source FROM sources WHERE sources."id" = s."id" AND sources.source IS NOT NULL;
  GET DIAGNOSTICS opt_out_sources = ROW_COUNT;

  -- The pusher's name, where Cadence knows the address (B205).
  UPDATE "SandboxContact" s SET "pushedByName" = u."name" FROM "User" u
  WHERE s."pushedByName" IS NULL AND s."pushedByEmail" IS NOT NULL AND lower(u."email") = lower(s."pushedByEmail");
  GET DIAGNOSTICS pusher_names = ROW_COUNT;

  -- The first real claim: a claim, or an assignment to someone; a push with an owner is not one (B194).
  UPDATE "SandboxContact" s SET "firstClaimedAt" = a.first FROM (
    SELECT "entityId", MIN("createdAt") AS first FROM "AuditLog"
    WHERE "entityType" = 'sandbox_contact' AND ("action" = 'claimed' OR ("action" = 'assigned' AND "details"->>'to' IS NOT NULL))
    GROUP BY "entityId"
  ) a WHERE a."entityId" = s."id" AND s."firstClaimedAt" IS NULL;
  GET DIAGNOSTICS first_claims = ROW_COUNT;

  -- Who removed a contact (B086). Retention's removals were the system's and stay empty.
  UPDATE "SandboxContact" s SET "removedById" = a."actorId" FROM (
    SELECT DISTINCT ON ("entityId") "entityId", "actorId" FROM "AuditLog"
    WHERE "entityType" = 'sandbox_contact' AND "action" = 'removed' AND "actorType" = 'USER' AND "actorId" IS NOT NULL
    ORDER BY "entityId", "createdAt" DESC
  ) a WHERE a."entityId" = s."id" AND s."status" = 'REMOVED' AND s."removedById" IS NULL;
  GET DIAGNOSTICS removers = ROW_COUNT;

  -- The latest post-call outcome on each cold contact (D3).
  UPDATE "SandboxContact" s SET "lastOutcome" = f."outcome", "lastOutcomeAt" = f."submittedAt" FROM (
    SELECT DISTINCT ON (c."sandboxContactId") c."sandboxContactId", cf."outcome", cf."submittedAt"
    FROM "CallForm" cf JOIN "CallLog" c ON c."id" = cf."callId"
    WHERE c."sandboxContactId" IS NOT NULL
    ORDER BY c."sandboxContactId", cf."submittedAt" DESC
  ) f WHERE f."sandboxContactId" = s."id" AND s."lastOutcomeAt" IS NULL;
  GET DIAGNOSTICS outcomes = ROW_COUNT;

  -- Shared inboxes (B177): the same pattern as src/lib/sandbox/normalize.ts ROLE_EMAIL and Bellwether's.
  UPDATE "SandboxContact" SET "emailIsRole" = true
  WHERE NOT "emailIsRole" AND "email" IS NOT NULL
    AND split_part("email", '@', 1) ~* '^(info|contact|hello|hi|hey|enquir(y|ies)|inquir(y|ies)|sales|support|help|admin|office|team|mail|press|media|marketing|careers|jobs|hr|recruit(ing|ment)?|billing|accounts?|accounting|finance|invoices?|legal|privacy|security|partners|partnerships|business|bd|general|customerservice|customer[-_.]?care|service|services|booking|reservations|orders?|webmaster|hostmaster|it|desk|reception|newsletter|subscribe|feedback|questions|ask|talk|connect|compliance|operations|ops|clientservices?|client[-_.]?service|clients?|advisors?|planning|wealth|invest(ments?|ing)?|trading|trade|custody|transfers?|documents?|statements?|noreply|no[-_.]?reply|frontdesk|main|appointments?|scheduling|events?)s?([-_.].*)?$';
  GET DIAGNOSTICS role_emails = ROW_COUNT;

  -- Each finished move keeps the undo deadline it was made with (N062): the setting as it is today.
  SELECT CASE WHEN ("value"->>'undoDays') ~ '^[0-9]+$' THEN ("value"->>'undoDays')::integer END INTO undo_days FROM "Setting" WHERE "key" = 'sandbox';
  UPDATE "SandboxMoveItem" SET "undoUntil" = "doneAt" + make_interval(days => COALESCE(undo_days, 365))
  WHERE "undoUntil" IS NULL AND "doneAt" IS NOT NULL AND "state" IN ('DONE', 'UNDONE');
  GET DIAGNOSTICS undo_deadlines = ROW_COUNT;

  -- The CRM copy's emails, trimmed and lower-cased as normalizeEmail does (B011).
  UPDATE "PersonCache" SET "emailNorm" = lower(regexp_replace("email", '^\s+|\s+$', '', 'g'))
  WHERE "emailNorm" IS NULL AND "email" IS NOT NULL
    AND length(regexp_replace("email", '^\s+|\s+$', '', 'g')) <= 254
    AND lower(regexp_replace("email", '^\s+|\s+$', '', 'g')) ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$';
  GET DIAGNOSTICS email_norms = ROW_COUNT;
  WITH norms AS (
    SELECT p."id", ARRAY(
      SELECT x.n FROM (SELECT lower(regexp_replace(t.e, '^\s+|\s+$', '', 'g')) AS n, t.ord FROM unnest(p."additionalEmails") WITH ORDINALITY AS t(e, ord)) x
      WHERE length(x.n) <= 254 AND x.n ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' ORDER BY x.ord
    ) AS emails
    FROM "PersonCache" p WHERE cardinality(p."additionalEmails") > 0 AND cardinality(COALESCE(p."additionalEmailsNorm", ARRAY[]::text[])) = 0
  )
  UPDATE "PersonCache" p SET "additionalEmailsNorm" = norms.emails FROM norms WHERE norms."id" = p."id" AND cardinality(norms.emails) > 0;
  GET DIAGNOSTICS extra_email_norms = ROW_COUNT;

  -- When a CRM person was opted out in Cadence, and whether it came from the post-call form (D4).
  UPDATE "PersonCache" p SET "optedOutAt" = a.at FROM (
    SELECT "entityId", MAX("createdAt") AS at FROM "AuditLog"
    WHERE "entityType" = 'person' AND "action" = 'flags_updated' AND "details"->>'optedOut' = 'true'
    GROUP BY "entityId"
  ) a WHERE a."entityId" = p."id" AND p."optedOut" AND p."optedOutAt" IS NULL;
  GET DIAGNOSTICS person_opt_outs = ROW_COUNT;
  UPDATE "PersonCache" p SET "optOutSource" = 'call_form'
  WHERE p."optedOut" AND p."optOutSource" IS NULL
    AND EXISTS (SELECT 1 FROM "CallForm" f JOIN "CallLog" c ON c."id" = f."callId" WHERE c."personId" = p."id" AND f."outcome" = 'do_not_contact');
  GET DIAGNOSTICS person_sources = ROW_COUNT;

  -- Which opt-out wrote each suppression row (D4): erasure, an admin's entry, or the subject's own opt-out.
  WITH sources AS (
    SELECT x."id", CASE
      WHEN x."reason" = 'erased' THEN 'erase'
      WHEN x."reason" = 'do_not_contact' THEN 'suppression_list'
      WHEN x."sandboxContactId" IS NOT NULL THEN (SELECT s."optOutSource" FROM "SandboxContact" s WHERE s."id" = x."sandboxContactId")
      WHEN x."personId" IS NOT NULL THEN (SELECT p."optOutSource" FROM "PersonCache" p WHERE p."id" = x."personId")
    END AS source
    FROM "Suppression" x WHERE x."source" IS NULL
  )
  UPDATE "Suppression" x SET "source" = sources.source FROM sources WHERE sources."id" = x."id" AND sources.source IS NOT NULL;
  GET DIAGNOSTICS suppression_sources = ROW_COUNT;

  IF call_pods + contact_pods + meeting_kinds + opt_out_sources + pusher_names + first_claims + removers + outcomes + role_emails + undo_deadlines
     + email_norms + extra_email_norms + person_opt_outs + person_sources + suppression_sources > 0 THEN
    INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
    VALUES (gen_random_uuid()::text, 'settings', 'migrations', 'cold_outreach_backfill', 'SYSTEM', 'Cadence (release migration)', jsonb_build_object(
      'migration', '20261105000001_cold_outreach_backfill',
      'callPods', call_pods, 'callsWithoutPod', to_jsonb(COALESCE(calls_without_pod, ARRAY[]::text[])), 'contactPods', contact_pods,
      'contactsWithoutPod', to_jsonb(COALESCE(contacts_without_pod, ARRAY[]::text[])), 'meetingNextActions', meeting_kinds,
      'optOutSources', opt_out_sources, 'pusherNames', pusher_names, 'firstClaims', first_claims, 'removedBy', removers,
      'lastOutcomes', outcomes, 'roleEmails', role_emails, 'undoDeadlines', undo_deadlines, 'emailNorms', email_norms,
      'additionalEmailNorms', extra_email_norms, 'crmOptOutDates', person_opt_outs, 'crmOptOutSources', person_sources,
      'suppressionSources', suppression_sources), stamp);
  END IF;
END $$;
