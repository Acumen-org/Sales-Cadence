import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, SYSTEM_ACTOR } from '../audit';
import { exitEnrollment } from '../engine/enrollment';
import { isRoleEmail } from '../sandbox/normalize';
import { crmDoNotContactTwin } from '../sandbox/dedupe';
import { needsNewOwner } from './ownership';
import { moveWorkTo } from './transfer';
import { optOutPerson, type OptOutSource } from './transitions';

/*
 * The cold outreach release's clean-up of the data written since 3 Nov (PLAN 9.7), the part that is
 * neither a migration nor S1's backfill: it runs by itself, once, from the worker, with no review step
 * (owner, 5 Nov). Whatever can be put right safely is put right and audited with what it was; what
 * only a person could judge is listed, never changed, and the list shows in Settings > Cold outreach.
 * Every step is idempotent, so a run cut short simply runs again at the next start.
 *
 *   step 0   the counts the plan asked for, as they stood at the release;
 *   step 7   contacts, next steps and forms of reps who left: counted (the "Needs a new owner" view
 *            lists them for their pod's leaders, live);
 *   step 8   running campaigns and open next steps whose rep is not the contact's owner: given to the
 *            owner, the way a transfer does it (B049, B147); kept and listed when the owner cannot
 *            run them (not in the campaign's pod);
 *   step 9   N001 a CRM person made by a move while the contact was being opted out: opted out too,
 *            in Cadence and the CRM (D6), from the contact's own source; N002 a campaign still
 *            running for a contact opted out, removed or moved: ended with the reason; N025 live
 *            contacts with the same personal email: marked "Possibly the same as"; listed only: N003
 *            contacts matching a CRM Do not contact person by name and firm (their outreach is
 *            blocked already), N011 refusals that may have come through a shared line, N027 removed
 *            contacts whose details were cleared before the release kept their keys, N016 emails
 *            sent after an opt-out;
 *   step 10  attach moves (B097, B006) and contacts moved more than once (B005): listed;
 *   step 11  N058, N059 an address marked bounced only by a delay notice or a subject match: marked
 *            "Possible bounce" instead, for the rep to clear or confirm (Confirm marks it bounced again);
 *   step 13  names with the audit's test prefixes: listed, never deleted.
 * Steps 1 to 6, 11's other parts, 12 and 14 are done by the release's migrations, S1's backfill
 * (src/lib/outreach/backfills.ts) and Bellwether's own start-up.
 */

export const COLD_OUTREACH_RELEASE = 'coldOutreachRelease20261106';
/** How many ids each list keeps; the counts are always whole. */
const KEEP = 200;
const RELEASE_REASON = 'release_drift';
/** The prefixes the audit gave its test data (PLAN 9.7 step 13). */
const TEST_PREFIXES = ['WRD', 'MSC', 'Mapb', 'Wc', 'V19', 'Wrn'];
/** Delay, delivered and relayed notices are not bounces (N059). */
const NOT_A_FAILURE = /(delay|delayed|deferred|delivered|relayed|expanded|will retry|still trying|warning)/i;

type Listed = { count: number; ids: string[] };
const listed = (ids: string[]): Listed => ({ count: ids.length, ids: ids.slice(0, KEEP) });

export type ReleaseReport = {
  at: string;
  /** Step 0. */
  counts: Record<string, Record<string, number>>;
  /** Step 7: what reps who left still hold. */
  leavers: { reps: number; contacts: number; nextSteps: number; forms: number };
  /** Step 8, put right. */
  drift: { contacts: number; nextSteps: number; enrollments: number; tasks: number; kept: Listed };
  /** N001, put right. */
  movedWhileOptedOut: Listed;
  /** N002, put right. */
  endedForInactive: Listed;
  /** N025, marked. */
  duplicates: Listed;
  /** N058, N059, put right. */
  doubtedBounces: Listed;
  /** Listed only. */
  dncByNameAndFirm: Listed;
  sharedLineRefusals: Listed;
  removedWithoutKeys: Listed;
  emailsAfterOptOut: Listed;
  attachMoves: Listed;
  movedTwice: Listed;
  testData: Listed;
};

/** Step 0: the counts PLAN 9.7 asked for, as they stand. */
async function releaseCounts(): Promise<ReleaseReport['counts']> {
  const by = <T extends { _count: { _all: number } }>(rows: T[], key: (r: T) => string) => Object.fromEntries(rows.map((r) => [key(r), r._count._all]));
  const [contacts, unclaimed, noPod, campaigns, coldEnrollments, moves, items, formsWaiting, oldestForm, suppressions, pushes, refusals, openNext] = await Promise.all([
    prisma.sandboxContact.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.sandboxContact.count({ where: { status: 'ACTIVE', OR: [{ ownerId: null }, { owner: { active: false } }] } }),
    prisma.sandboxContact.count({ where: { status: 'ACTIVE', podId: null } }),
    prisma.campaign.groupBy({ by: ['status'], where: { audience: 'SANDBOX' }, _count: { _all: true } }),
    prisma.enrollment.count({ where: { campaign: { audience: 'SANDBOX' } } }),
    prisma.sandboxMove.count(),
    prisma.sandboxMoveItem.groupBy({ by: ['state'], _count: { _all: true } }),
    prisma.callLog.count({ where: { formDueAt: { not: null }, formDoneAt: null, discardedAt: null } }),
    prisma.callLog.findFirst({ where: { formDueAt: { not: null }, formDoneAt: null, discardedAt: null }, orderBy: { formDueAt: 'asc' }, select: { formDueAt: true } }),
    prisma.suppression.groupBy({ by: ['kind'], _count: { _all: true } }),
    prisma.bellwetherPush.groupBy({ by: ['state'], _count: { _all: true } }),
    prisma.bellwetherRefusal.groupBy({ by: ['reason'], _count: { _all: true } }),
    prisma.nextAction.groupBy({ by: ['sandboxContactId'], where: { sandboxContactId: { not: null }, personId: null, state: 'OPEN' }, _count: { _all: true } }),
  ]);
  return {
    contacts: { ...by(contacts, (r) => r.status), unclaimed, withoutPod: noPod },
    coldCampaigns: { ...by(campaigns, (r) => r.status), enrollments: coldEnrollments },
    moves: { moves, ...by(items, (r) => r.state) },
    forms: { waiting: formsWaiting, oldestHours: oldestForm?.formDueAt ? Math.floor((Date.now() - oldestForm.formDueAt.getTime()) / 3600_000) : 0 },
    suppression: by(suppressions, (r) => r.kind),
    pushes: by(pushes, (r) => r.state),
    refusals: by(refusals, (r) => r.reason ?? 'none'),
    openColdNextSteps: { steps: openNext.reduce((n, r) => n + r._count._all, 0), contactsWithMoreThanOne: openNext.filter((r) => r._count._all > 1).length },
  };
}

/** Step 8: work that drifted from its contact's owner goes to the owner, as a transfer moves it. */
async function giveDriftToOwners(): Promise<ReleaseReport['drift']> {
  const out: ReleaseReport['drift'] = { contacts: 0, nextSteps: 0, enrollments: 0, tasks: 0, kept: listed([]) };
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT c.id FROM "SandboxContact" c JOIN "User" o ON o.id = c."ownerId" AND o.active
    WHERE c.status = 'ACTIVE' AND (
      EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."sandboxContactId" = c.id AND e."personId" IS NULL AND e.status IN ('ACTIVE', 'PAUSED') AND e."foUserId" <> c."ownerId")
      OR EXISTS (SELECT 1 FROM "NextAction" n WHERE n."sandboxContactId" = c.id AND n."personId" IS NULL AND n.state = 'OPEN' AND n."foUserId" <> c."ownerId"))
    ORDER BY c.id`;
  const kept: string[] = [];
  for (const { id } of rows) {
    const done = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SandboxContact" WHERE id = ${id} FOR UPDATE`;
      const c = await tx.sandboxContact.findUniqueOrThrow({ where: { id }, select: { id: true, ownerId: true, status: true, owner: { select: { active: true, pods: { select: { podId: true } } } } } });
      if (c.status !== 'ACTIVE' || !c.ownerId || !c.owner?.active) return null;
      // A campaign in a pod the owner does not work stays with its rep: someone has to choose.
      const pods = new Set(c.owner.pods.map((p) => p.podId));
      const elsewhere = await tx.enrollment.count({ where: { sandboxContactId: id, personId: null, status: { in: ['ACTIVE', 'PAUSED'] }, foUserId: { not: c.ownerId }, podId: { notIn: [...pods] } } });
      if (elsewhere) return 'kept' as const;
      const moved = await moveWorkTo(tx, id, c.ownerId, SYSTEM_ACTOR, RELEASE_REASON);
      await logAudit({ entityType: 'sandbox_contact', entityId: id, action: 'work_given_to_owner', actor: SYSTEM_ACTOR, details: { job: COLD_OUTREACH_RELEASE, to: c.ownerId, ...moved } }, tx);
      return moved;
    });
    if (done === 'kept') kept.push(id);
    else if (done) { out.contacts++; out.nextSteps += done.nextSteps; out.enrollments += done.enrollments; out.tasks += done.tasks; }
  }
  out.kept = listed(kept);
  return out;
}

/** N001: a contact opted out while its move was running ended MOVED, and its CRM person was never opted out. */
async function optOutMovedWhileOptedOut(): Promise<Listed> {
  const rows = await prisma.sandboxContact.findMany({
    where: { status: 'MOVED', optedOutAt: { not: null }, twentyPersonId: { not: null } },
    select: { id: true, twentyPersonId: true, optOutSource: true, optedOutAt: true, movedAt: true }, orderBy: { id: 'asc' },
  });
  const people = new Map((await prisma.personCache.findMany({ where: { id: { in: rows.map((r) => r.twentyPersonId!) } }, select: { id: true, optedOut: true } })).map((p) => [p.id, p]));
  const done: string[] = [];
  for (const r of rows) {
    const p = people.get(r.twentyPersonId!);
    if (!p || p.optedOut) continue;
    const source = (r.optOutSource ?? 'contact_page') as OptOutSource;
    const res = await optOutPerson(p.id, { source, actor: SYSTEM_ACTOR, reason: 'Asked not to be contacted while being moved to the CRM; put right when the release went out.' });
    if (res.ok && res.changed) done.push(p.id);
  }
  return listed(done);
}

const COLD_EXIT: Record<string, string> = { OPTED_OUT: 'opted_out', REMOVED: 'removed', MOVED: 'moved_to_crm' };

/** N002: campaigns still running for a contact who can no longer be contacted end, with the reason. */
async function endCampaignsOfInactive(): Promise<Listed> {
  const rows = await prisma.enrollment.findMany({ where: { sandboxContactId: { not: null }, personId: null, status: { in: ['ACTIVE', 'PAUSED'] }, sandboxContact: { status: { not: 'ACTIVE' } } }, select: { id: true, sandboxContact: { select: { status: true } } }, orderBy: { id: 'asc' } });
  for (const e of rows) await exitEnrollment(e.id, { reason: COLD_EXIT[e.sandboxContact!.status] ?? 'removed', actor: SYSTEM_ACTOR });
  return listed(rows.map((e) => e.id));
}

/** N025: live contacts sharing a personal email point at each other ("Possibly the same as"). */
async function markDuplicates(): Promise<Listed> {
  const groups = await prisma.$queryRaw<{ ids: string[] }[]>`
    SELECT array_agg(id ORDER BY "createdAt", id) AS ids FROM "SandboxContact"
    WHERE status = 'ACTIVE' AND email IS NOT NULL AND NOT "emailIsRole"
    GROUP BY lower(email) HAVING count(*) > 1`;
  const marked: string[] = [];
  for (const { ids } of groups) {
    const [first, ...rest] = ids;
    for (const id of rest) {
      const r = await prisma.sandboxContact.updateMany({ where: { id, possibleDuplicateId: null }, data: { possibleDuplicateId: first } });
      if (!r.count) continue;
      await logAudit({ entityType: 'sandbox_contact', entityId: id, action: 'possible_duplicate_marked', actor: SYSTEM_ACTOR, details: { job: COLD_OUTREACH_RELEASE, of: first, why: 'The same personal email as another live contact.' } });
      marked.push(id);
    }
  }
  return listed(marked);
}

/**
 * N058, N059: an address marked bounced only by notices the new rules would not call a bounce (a
 * delay or delivered notice, or one matched by subject alone, not by its conversation) becomes a
 * "Possible bounce" the rep can clear or confirm. A contact with any real bounce keeps it.
 */
async function doubtBounces(): Promise<Listed> {
  const contacts = await prisma.sandboxContact.findMany({
    where: { status: 'ACTIVE', badEmail: true, possibleBounceAt: null, emails: { some: { kind: 'BOUNCE' } } },
    select: { id: true, emails: { select: { kind: true, subject: true, conversationId: true, at: true } } }, orderBy: { id: 'asc' },
  });
  const confirmed = new Set((await prisma.auditLog.findMany({ where: { entityType: 'sandbox_contact', entityId: { in: contacts.map((c) => c.id) }, action: { in: ['possible_bounce_confirmed', 'email_bounced'] } }, select: { entityId: true } })).map((a) => a.entityId));
  const doubted: string[] = [];
  for (const c of contacts) {
    if (confirmed.has(c.id)) continue;
    const sent = new Set(c.emails.filter((e) => e.kind === 'SENT' && e.conversationId).map((e) => e.conversationId));
    const bounces = c.emails.filter((e) => e.kind === 'BOUNCE');
    const why = (b: (typeof bounces)[number]) => (NOT_A_FAILURE.test(b.subject ?? '') ? 'a delay or delivered notice' : !b.conversationId || !sent.has(b.conversationId) ? 'matched by its subject only' : null);
    const reasons = bounces.map(why);
    if (reasons.some((r) => r === null)) continue;
    const at = bounces.map((b) => b.at).sort((a, b) => a.getTime() - b.getTime())[0];
    const r = await prisma.sandboxContact.updateMany({ where: { id: c.id, badEmail: true, possibleBounceAt: null }, data: { badEmail: false, possibleBounceAt: at } });
    if (!r.count) continue;
    await logAudit({ entityType: 'sandbox_contact', entityId: c.id, action: 'possible_bounce_backfill', actor: SYSTEM_ACTOR, details: { job: COLD_OUTREACH_RELEASE, was: 'Email bounced', why: [...new Set(reasons)].join('; ') } });
    doubted.push(c.id);
  }
  return listed(doubted);
}

/** N003, listed: live contacts the name-and-firm check now blocks (contactability refuses them). */
async function dncByNameAndFirm(): Promise<Listed> {
  const candidates = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT c.id FROM "SandboxContact" c JOIN "PersonCache" p
      ON lower(p."firstName") = lower(c."firstName") AND lower(p."lastName") = lower(c."lastName")
    WHERE c.status = 'ACTIVE' AND p."deletedAt" IS NULL AND (p.dnd OR p."optedOut") ORDER BY c.id`;
  const hits: string[] = [];
  for (const { id } of candidates) {
    const c = await prisma.sandboxContact.findUniqueOrThrow({ where: { id }, select: { firstName: true, lastName: true, companyName: true, companyDomain: true, companyCrd: true } });
    if (await crmDoNotContactTwin(c)) hits.push(id);
  }
  return listed(hits);
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

/** Run every step once and record the report. */
export async function runColdOutreachRelease(): Promise<ReleaseReport> {
  const counts = await releaseCounts();
  const stranded = await needsNewOwner(null);
  const drift = await giveDriftToOwners();
  const movedWhileOptedOut = await optOutMovedWhileOptedOut();
  const endedForInactive = await endCampaignsOfInactive();
  const duplicates = await markDuplicates();
  const doubtedBounces = await doubtBounces();
  const testLike = { OR: TEST_PREFIXES.flatMap((p) => [{ firstName: { startsWith: p } }, { lastName: { startsWith: p } }, { companyName: { startsWith: p } }]) } satisfies Prisma.SandboxContactWhereInput;
  const [sharedLine, removed, afterOptOut, attach, movedTwice, testContacts] = await Promise.all([
    // Refusals turned to opted out before the release recorded what they matched on: perhaps a shared line (N011).
    prisma.bellwetherRefusal.findMany({ where: { status: 'opted_out', matchedOn: null }, select: { bellwetherContactId: true }, orderBy: { bellwetherContactId: 'asc' } }),
    prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "SandboxContact" WHERE status = 'REMOVED' AND "piiClearedAt" IS NOT NULL AND "optedOutAt" IS NULL AND "keptKeys" = '[]'::jsonb ORDER BY id`,
    prisma.$queryRaw<{ id: string }[]>`SELECT DISTINCT c.id FROM "SandboxContact" c JOIN "SandboxEmail" e ON e."sandboxContactId" = c.id WHERE e.kind = 'SENT' AND c."optedOutAt" IS NOT NULL AND e.at > c."optedOutAt" ORDER BY c.id`,
    prisma.sandboxMoveItem.findMany({ where: { mode: 'attach', state: { in: ['DONE', 'UNDONE', 'UNDO_PARTIAL'] } }, select: { id: true }, orderBy: { id: 'asc' } }),
    prisma.$queryRaw<{ id: string }[]>`SELECT "sandboxContactId" AS id FROM "SandboxMoveItem" WHERE state = 'DONE' GROUP BY "sandboxContactId" HAVING count(*) > 1 ORDER BY 1`,
    prisma.sandboxContact.findMany({ where: testLike, select: { id: true }, orderBy: { id: 'asc' } }),
  ]);
  const report: ReleaseReport = {
    at: new Date().toISOString(),
    counts,
    leavers: { reps: stranded.length, contacts: stranded.reduce((n, s) => n + s.contacts, 0), nextSteps: stranded.reduce((n, s) => n + s.nextSteps, 0), forms: stranded.reduce((n, s) => n + s.forms, 0) },
    drift, movedWhileOptedOut, endedForInactive, duplicates, doubtedBounces,
    dncByNameAndFirm: await dncByNameAndFirm(),
    sharedLineRefusals: listed(sharedLine.map((r) => r.bellwetherContactId)),
    removedWithoutKeys: listed(ids(removed)),
    emailsAfterOptOut: listed(ids(afterOptOut)),
    attachMoves: listed(ids(attach)),
    movedTwice: listed(ids(movedTwice)),
    testData: listed(ids(testContacts)),
  };
  await logAudit({ entityType: 'settings', entityId: 'migrations', action: 'release_checks', actor: SYSTEM_ACTOR, details: JSON.parse(JSON.stringify(report)) as Prisma.InputJsonValue });
  return report;
}

/** The report the worker recorded, for Settings > Cold outreach; null until it has run. */
export async function releaseReport(): Promise<ReleaseReport | null> {
  const row = await prisma.setting.findUnique({ where: { key: COLD_OUTREACH_RELEASE } });
  return (row?.value ?? null) as ReleaseReport | null;
}

/** The worker's once: run, then keep the report under its key, so it never runs again. */
export async function coldOutreachReleaseOnce(): Promise<ReleaseReport | null> {
  if (await prisma.setting.findUnique({ where: { key: COLD_OUTREACH_RELEASE } })) return null;
  const report = await runColdOutreachRelease();
  const value = JSON.parse(JSON.stringify(report)) as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: COLD_OUTREACH_RELEASE }, create: { key: COLD_OUTREACH_RELEASE, value }, update: { value } });
  return report;
}
