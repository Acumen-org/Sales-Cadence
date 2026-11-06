import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { toActor } from '@/lib/auth/rbac';
import { upsertPersonCache } from '@/lib/person-cache';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { isRoleEmail } from '@/lib/sandbox/normalize';
import { suppressValue } from '@/lib/sandbox/opt-out';
import { addSuppressions, contactKeys, findSuppressed, widenedKeys } from '@/lib/sandbox/suppression';
import { setSandboxNextAction } from '@/lib/sandbox/work';
import { preflightMove, queueMove, retryFailedItems, runMoveQueue } from '@/lib/sandbox/move';
import { rerunSuppressionAgainstCrm, widenOptOutSuppressions } from '@/lib/outreach/backfills';
import { runTool } from '../scripts/local-runtime';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/**
 * Stage S1 of the cold outreach rebuild (PLAN 8.12, 9.7): the data model, its migrations and
 * backfills. A backfill migration is run a second time here, on rows made to look as they did before
 * the release, which shows both what it does and that running it again changes nothing.
 */

/** Run one migration's SQL again, as `prisma migrate deploy` ran it. */
function rerun(name: string) {
  const file = path.join('prisma', 'migrations', name, 'migration.sql');
  const r = runTool(process.cwd(), 'prisma', ['db', 'execute', '--file', file, '--url', process.env.DATABASE_URL!], process.env, 'pipe');
  if (r.status !== 0) throw new Error(`${name} failed: ${r.stderr || r.stdout}`);
}

const auditRows = (action: string) => prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });

describe('cold outreach data model (S1)', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });

  const actorOf = async (id: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id }, include: { pods: true } });
    return { actor: toActor({ id: u.id, role: u.role, podIds: u.pods.map((p) => p.podId) }), audit: userActor(u) };
  };

  it('B037: rows from before stamping are classified by where the work happened, and a move then changes none of them', async () => {
    const alisa = b.users.alisa.id;
    const cold = await readyContact(alisa, b.pods.Alisa.id);
    const moved = await readyContact(alisa, b.pods.Alisa.id, { status: 'MOVED', movedAt: new Date('2026-11-04T15:00:00Z'), twentyPersonId: 'person-02' });
    const at = new Date('2026-11-03T10:00:00Z');
    const touch = (externalId: string, ids: { personId?: string; sandboxContactId?: string }) => prisma.touch.create({ data: { ...ids, channel: 'CALL', direction: 'OUTBOUND', occurredAt: at, summary: externalId, externalId } });
    const crmTouch = await touch('b037:crm', { personId: 'person-01' });
    const coldTouch = await touch('b037:cold', { sandboxContactId: cold.id });
    const movedTouch = await touch('b037:moved', { sandboxContactId: moved.id, personId: 'person-02' });
    const call = (ids: { personId?: string; sandboxContactId?: string }) => prisma.callLog.create({ data: { ...ids, source: 'MANUAL', direction: 'OUTBOUND', status: 'COMPLETED', userId: alisa, startedAt: at } });
    const crmCall = await call({ personId: 'person-01' });
    const coldCall = await call({ sandboxContactId: cold.id });
    const unmatched = await call({});
    const form = await prisma.callForm.create({ data: { callId: coldCall.id, userId: alisa, outcome: 'connected', nextStep: 'none' } });
    const next = (ids: { personId?: string; sandboxContactId?: string }, label: string) => prisma.nextAction.create({ data: { ...ids, foUserId: alisa, label, action: 'CALL', dueDate: '2026-11-09', createdAt: at } });
    const crmNext = await next({ personId: 'person-01' }, 'CRM call');
    const coldNext = await next({ sandboxContactId: cold.id }, 'Cold call');
    const movedNext = await next({ sandboxContactId: moved.id, personId: 'person-02' }, 'Call after the move');
    const coldCampaign = await prisma.campaign.create({ data: { name: 'Q4 Harbor', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-11-03', audience: 'SANDBOX' } });
    const coldEnrollment = await prisma.enrollment.create({ data: { sandboxContactId: cold.id, campaignId: coldCampaign.id, foUserId: alisa, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-03' } });
    const crmEnrollment = await prisma.enrollment.create({ data: { personId: 'person-03', foUserId: alisa, sequenceId: b.sequence.id, startDate: '2026-11-03' } });
    // As they were before the release: nothing stamped.
    for (const table of ['Touch', 'CallLog', 'NextAction', 'Enrollment', 'CallForm']) await prisma.$executeRawUnsafe(`UPDATE "${table}" SET "audience" = NULL`);

    rerun('20261105000101_audience_backfill');

    const audienceOf = async () => ({
      touches: (await prisma.touch.findMany({ where: { id: { in: [crmTouch.id, coldTouch.id, movedTouch.id] } }, select: { id: true, audience: true } })).map((t) => [t.id, t.audience]),
      calls: (await prisma.callLog.findMany({ where: { id: { in: [crmCall.id, coldCall.id, unmatched.id] } }, select: { id: true, audience: true } })).map((c) => [c.id, c.audience]),
    });
    expect(new Map((await audienceOf()).touches as [string, string][])).toEqual(new Map([[crmTouch.id, 'CRM'], [coldTouch.id, 'SANDBOX'], [movedTouch.id, 'SANDBOX']]));
    expect(new Map((await audienceOf()).calls as [string, string | null][])).toEqual(new Map([[crmCall.id, 'CRM'], [coldCall.id, 'SANDBOX'], [unmatched.id, null]]));
    expect((await prisma.callForm.findUniqueOrThrow({ where: { id: form.id } })).audience).toBe('SANDBOX');
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: coldEnrollment.id } })).audience).toBe('SANDBOX');
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: crmEnrollment.id } })).audience).toBe('CRM');
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: crmNext.id } })).audience).toBe('CRM');
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: coldNext.id } })).audience).toBe('SANDBOX');

    // The moved contact's open next step: the cold row is closed, and the same step is open again as CRM work.
    expect(await prisma.nextAction.findUniqueOrThrow({ where: { id: movedNext.id } })).toEqual(expect.objectContaining({ state: 'CANCELLED', audience: 'SANDBOX' }));
    const reopened = await prisma.nextAction.findFirstOrThrow({ where: { personId: 'person-02', state: 'OPEN' } });
    expect(reopened).toEqual(expect.objectContaining({ audience: 'CRM', label: 'Call after the move', dueDate: '2026-11-09', foUserId: alisa, sandboxContactId: moved.id, createdAt: moved.movedAt }));
    expect((await auditRows('next_action_recreated'))[0].details).toEqual(expect.objectContaining({ from: movedNext.id, to: reopened.id }));
    expect(await auditRows('audience_backfill')).toHaveLength(1);

    // Running it again changes nothing.
    const before = await prisma.nextAction.count();
    rerun('20261105000101_audience_backfill');
    expect(await prisma.nextAction.count()).toBe(before);
    expect(await auditRows('audience_backfill')).toHaveLength(1);

    // A move hands the cold rows to the CRM person, but their audience stays where the work happened.
    const { actor, audit } = await actorOf(alisa);
    await prisma.enrollment.update({ where: { id: coldEnrollment.id }, data: { status: 'EXITED' } });
    const q = await queueMove([{ contactId: cold.id, mode: 'create', noConversation: true }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    expect(await runMoveQueue()).toEqual({ done: 1, failed: 0, dryRun: 0 });
    const personId = (await prisma.sandboxContact.findUniqueOrThrow({ where: { id: cold.id } })).twentyPersonId;
    expect(await prisma.touch.findUniqueOrThrow({ where: { id: coldTouch.id } })).toEqual(expect.objectContaining({ personId, audience: 'SANDBOX' }));
    expect(await prisma.callLog.findUniqueOrThrow({ where: { id: coldCall.id } })).toEqual(expect.objectContaining({ personId, audience: 'SANDBOX' }));
    expect(await prisma.enrollment.findUniqueOrThrow({ where: { id: coldEnrollment.id } })).toEqual(expect.objectContaining({ personId, audience: 'SANDBOX' }));
  });

  it('B005: one open next step per cold contact is a database rule, and two requests at once leave one', async () => {
    const alisa = b.users.alisa.id;
    const c = await readyContact(alisa, b.pods.Alisa.id);
    const row = { sandboxContactId: c.id, foUserId: alisa, label: 'Call', action: 'CALL' as const, dueDate: '2026-11-09' };
    await prisma.nextAction.create({ data: row });
    await expect(prisma.nextAction.create({ data: row })).rejects.toThrow();
    // A done one does not hold the place.
    await prisma.nextAction.create({ data: { ...row, state: 'DONE' } });

    const d = await readyContact(alisa, b.pods.Alisa.id);
    const actor = userActor(b.users.alisa);
    await Promise.all([
      setSandboxNextAction(d.id, { label: 'Email', action: 'EMAIL', dueDate: '2026-11-10', foUserId: alisa }, actor),
      setSandboxNextAction(d.id, { label: 'Call', action: 'CALL', dueDate: '2026-11-11', foUserId: alisa }, actor),
    ]);
    expect(await prisma.nextAction.count({ where: { sandboxContactId: d.id, state: 'OPEN' } })).toBe(1);
  });

  it('B005: duplicate open next steps from before the release are closed, never deleted, and the newest stays', async () => {
    const alisa = b.users.alisa.id;
    const c = await readyContact(alisa, b.pods.Alisa.id);
    await prisma.$executeRawUnsafe('DROP INDEX "NextAction_one_open_per_sandbox_contact"');
    const row = { sandboxContactId: c.id, foUserId: alisa, action: 'CALL' as const, dueDate: '2026-11-09' };
    const older = await prisma.nextAction.create({ data: { ...row, label: 'Older', createdAt: new Date('2026-11-03T09:00:00Z') } });
    const newer = await prisma.nextAction.create({ data: { ...row, label: 'Newer', createdAt: new Date('2026-11-04T09:00:00Z') } });

    rerun('20261105000200_one_open_cold_next_action');

    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: older.id } })).state).toBe('CANCELLED');
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: newer.id } })).state).toBe('OPEN');
    const logged = (await auditRows('deduped_by_migration')).filter((a) => a.entityType === 'sandbox_contact');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toEqual(expect.objectContaining({ entityId: c.id, details: expect.objectContaining({ nextActionId: older.id, kept: newer.id, label: 'Older', was: 'OPEN' }) }));
    // The index is back, and a second run finds nothing to close.
    await expect(prisma.nextAction.create({ data: { ...row, label: 'Third' } })).rejects.toThrow();
    rerun('20261105000200_one_open_cold_next_action');
    expect((await auditRows('deduped_by_migration')).filter((a) => a.entityType === 'sandbox_contact')).toHaveLength(1);
  });

  it('B005: a contact already being moved cannot be queued again, from the dialog, a second tab or the database', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const first = await queueMove([{ contactId: c.id, mode: 'create', noConversation: true }], actor, audit);
    expect(first.ok).toBe(true);
    expect((await preflightMove([c.id], actor)).items[0]).toEqual(expect.objectContaining({ group: 'left_out', reason: 'Being moved already' }));
    expect(await queueMove([{ contactId: c.id, mode: 'create', noConversation: true }], actor, audit)).toEqual(expect.objectContaining({ ok: false }));
    await expect(prisma.sandboxMove.create({ data: { createdById: b.users.alisa.id, count: 1, state: 'QUEUED', items: { create: [{ sandboxContactId: c.id, state: 'QUEUED', mode: 'create', snapshot: {} }] } } })).rejects.toThrow();

    // Two tabs at the same moment: one move is queued, the other is refused, one CRM person is made.
    const d = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const both = await Promise.all([queueMove([{ contactId: d.id, mode: 'create', noConversation: true }], actor, audit), queueMove([{ contactId: d.id, mode: 'create', noConversation: true }], actor, audit)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    // Which check stops the second depends on timing: the database's one-move-in-flight index when both
    // got past the checks, or the checks themselves when the first had already queued. Both refuse it.
    expect(both.find((r) => !r.ok)).toEqual({ ok: false, error: expect.stringMatching(/already being moved|Being moved already/) });
    expect(await prisma.sandboxMoveItem.count({ where: { sandboxContactId: d.id } })).toBe(1);
    expect(await runMoveQueue()).toEqual({ done: 2, failed: 0, dryRun: 0 });
    expect(getMockTwentyClient().writes.filter((w) => w.op === 'createPerson')).toHaveLength(2);
  });

  it('B005: moves of one contact queued twice before the release: the newest runs, the older fails for good and Retry leaves it', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.$executeRawUnsafe('DROP INDEX "SandboxMoveItem_one_in_flight_per_contact"');
    const item = { sandboxContactId: c.id, state: 'QUEUED', mode: 'create', snapshot: {} };
    const older = await prisma.sandboxMove.create({ data: { createdById: b.users.alisa.id, count: 1, state: 'QUEUED', createdAt: new Date('2026-11-03T09:00:00Z'), items: { create: [item] } }, include: { items: true } });
    const newer = await prisma.sandboxMove.create({ data: { createdById: b.users.alisa.id, count: 1, state: 'QUEUED', createdAt: new Date('2026-11-03T09:01:00Z'), items: { create: [item] } }, include: { items: true } });

    rerun('20261105000300_one_move_in_flight');

    expect(await prisma.sandboxMoveItem.findUniqueOrThrow({ where: { id: older.items[0].id } })).toEqual(expect.objectContaining({ state: 'FAILED', failure: 'permanent', error: expect.stringContaining('queued again') }));
    expect((await prisma.sandboxMoveItem.findUniqueOrThrow({ where: { id: newer.items[0].id } })).state).toBe('QUEUED');
    expect((await prisma.sandboxMove.findUniqueOrThrow({ where: { id: older.id } })).state).toBe('DONE');
    expect((await auditRows('deduped_by_migration')).filter((a) => a.entityType === 'sandbox_move')[0]).toEqual(expect.objectContaining({ entityId: older.id, details: expect.objectContaining({ itemId: older.items[0].id, kept: newer.items[0].id, was: 'QUEUED' }) }));
    expect((await retryFailedItems(older.id)).queued).toBe(0);
    rerun('20261105000300_one_move_in_flight');
    expect((await auditRows('deduped_by_migration')).filter((a) => a.entityType === 'sandbox_move')).toHaveLength(1);
  });

  it('B011: an entry on the suppression list opts out a CRM person whose cached email has capitals', async () => {
    const person = getMockTwentyClient().people.find((p) => p.email && !p.dnd)!;
    await upsertPersonCache({ ...person, email: 'Jane.Q.Capital@Example-Wealth.com', additionalEmails: ['J.Capital@Example-Wealth.COM'], updatedAt: new Date().toISOString() });
    expect(await prisma.personCache.findUniqueOrThrow({ where: { id: person.id } })).toEqual(expect.objectContaining({ emailNorm: 'jane.q.capital@example-wealth.com', additionalEmailsNorm: ['j.capital@example-wealth.com'] }));
    const r = await suppressValue({ kind: 'email', value: 'j.capital@example-wealth.com' }, { actor: userActor(b.users.ria) });
    expect(r.optedOut).toBe(1);
    expect(await prisma.personCache.findUniqueOrThrow({ where: { id: person.id } })).toEqual(expect.objectContaining({ optedOut: true, optOutSource: 'suppression_list', optedOutAt: expect.any(Date) }));
  });

  it('B011: the release runs the suppression list again against the CRM copy, in lower case, once', async () => {
    const mk = (id: string, email: string) => prisma.personCache.create({ data: { id, firstName: 'Old', lastName: id, email } });
    await mk('b011-personal', 'Pat.Old@Old-Firm.com');
    await mk('b011-shared', 'Info@Old-Firm.com');
    await mk('b011-clean', 'Someone.Else@Old-Firm.com');
    // Rows cached before the release have no normalised email until the migration fills it.
    rerun('20261105000001_cold_outreach_backfill');
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: 'b011-personal' } })).emailNorm).toBe('pat.old@old-firm.com');
    await addSuppressions([{ kind: 'email', value: 'pat.old@old-firm.com' }, { kind: 'email', value: 'info@old-firm.com' }], { reason: 'opted_out', source: 'contact_page' });

    const first = await rerunSuppressionAgainstCrm();
    expect(first.optedOut).toEqual(['b011-personal']);
    expect(first.sharedInbox).toEqual(['b011-shared']);
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: 'b011-personal' } })).optedOut).toBe(true);
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: 'b011-shared' } })).optedOut).toBe(false);
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: 'b011-clean' } })).optedOut).toBe(false);
    expect((await rerunSuppressionAgainstCrm()).optedOut).toEqual([]);
  });

  it('suppression per person: two colleagues opted out over one office line both keep their row, and it blocks only them', async () => {
    const office = '+13125550100';
    const a = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: office, phoneType: 'office', individualCrd: '0001234567' });
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: office, phoneType: 'office' });
    expect(await addSuppressions(widenedKeys(a, a.id), { reason: 'opted_out', source: 'contact_page', sandboxContactId: a.id })).toBe(4);
    expect(await addSuppressions(widenedKeys(c, c.id), { reason: 'opted_out', source: 'contact_page', sandboxContactId: c.id })).toBe(3);
    expect((await prisma.suppression.findMany({ where: { kind: 'phone_subject' }, select: { subjectId: true } })).map((r) => r.subjectId).sort()).toEqual([a.id, c.id].sort());
    expect(await prisma.suppression.findFirst({ where: { kind: 'individual_crd' } })).toEqual(expect.objectContaining({ subjectId: null, label: 'CRD ***567' }));
    expect(await findSuppressed([{ kind: 'phone_subject', value: office, subjectId: a.id }])).not.toBeNull();
    expect(await findSuppressed([{ kind: 'phone_subject', value: office, subjectId: 'a-colleague' }])).toBeNull();
    // A value that protects everyone is still one row, whoever adds it again.
    expect(await addSuppressions(widenedKeys(a, a.id), { reason: 'opted_out', sandboxContactId: a.id })).toBe(0);
    expect(await prisma.suppression.count({ where: { kind: 'email' } })).toBe(2);
  });

  it('B001, B002: opt-outs from before the release are re-hashed under the wider keys, once, with their source', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550111', phoneType: 'main', additionalPhones: [{ number: '+13125550112', type: 'mobile' }], individualCrd: '7654321' });
    // An opt-out as it was before the release: personal keys only. Today's opt-out writes the wider ones itself (S2).
    await prisma.sandboxContact.update({ where: { id: c.id }, data: { status: 'OPTED_OUT', optedOutAt: new Date(), optOutSource: 'call_form' } });
    await addSuppressions(contactKeys(c), { reason: 'opted_out', source: 'call_form', sandboxContactId: c.id });
    expect(await prisma.suppression.count({ where: { kind: { in: ['phone_subject', 'individual_crd'] } } })).toBe(0);
    const erased = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { status: 'OPTED_OUT', optedOutAt: new Date(), piiClearedAt: new Date() });

    const first = await widenOptOutSuppressions();
    expect(first).toEqual({ contacts: 1, added: 2, cleared: [erased.id] });
    expect(await prisma.suppression.findMany({ where: { kind: { in: ['phone_subject', 'individual_crd'] } }, select: { kind: true, subjectId: true, source: true, sandboxContactId: true }, orderBy: { kind: 'asc' } })).toEqual([
      { kind: 'individual_crd', subjectId: null, source: 'call_form', sandboxContactId: c.id },
      { kind: 'phone_subject', subjectId: c.id, source: 'call_form', sandboxContactId: c.id },
    ]);
    expect((await widenOptOutSuppressions()).added).toBe(0);
  });

  it('the release fills the new columns from what the rows already say, once', async () => {
    const alisa = b.users.alisa.id;
    const [person] = await prisma.personCache.findMany({ where: { podOwner: 'LEIGH' }, take: 1 });
    const contact = await readyContact(alisa, b.pods.Alisa.id, { email: 'Compliance.Desk@harbor-wealth.com', pushedByEmail: 'ALISA@cadence.local' });
    const optedOut = await readyContact(alisa, b.pods.Alisa.id, { status: 'OPTED_OUT', optedOutAt: new Date(), optOutReason: 'Rude' });
    await prisma.auditLog.create({ data: { entityType: 'sandbox_contact', entityId: optedOut.id, action: 'opted_out', actorType: 'USER', details: { source: 'call_form', reason: 'Rude' } } });
    await prisma.auditLog.create({ data: { entityType: 'sandbox_contact', entityId: contact.id, action: 'claimed', actorType: 'USER', createdAt: new Date('2026-11-03T11:00:00Z') } });
    const enrollment = await prisma.enrollment.create({ data: { sandboxContactId: contact.id, foUserId: alisa, podId: b.pods.Andrew.id, sequenceId: b.sequence.id, startDate: '2026-11-03', status: 'EXITED' } });
    const call = (data: { enrollmentId?: string; sandboxContactId?: string; personId?: string; userId?: string }) => prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', status: 'COMPLETED', startedAt: new Date(), ...data } });
    const byEnrollment = await call({ enrollmentId: enrollment.id, sandboxContactId: contact.id, userId: alisa });
    const byContact = await call({ sandboxContactId: contact.id, userId: alisa });
    const byPerson = await call({ personId: person.id, userId: b.users.ria.id });
    const byRep = await call({ userId: b.users.karson.id });
    const noPod = await call({ userId: b.users.ria.id });
    const meeting = await prisma.nextAction.create({ data: { sandboxContactId: contact.id, foUserId: alisa, label: 'Meeting', action: 'CALL', dueDate: '2026-11-12' } });
    await prisma.callForm.create({ data: { callId: byContact.id, userId: alisa, outcome: 'meeting_booked', nextStep: 'meeting', nextStepDate: '2026-11-12', nextActionId: meeting.id, submittedAt: new Date('2026-11-04T12:00:00Z') } });
    const move = await prisma.sandboxMove.create({ data: { createdById: alisa, count: 1, state: 'DONE', items: { create: [{ sandboxContactId: optedOut.id, state: 'DONE', mode: 'create', snapshot: {}, doneAt: new Date('2026-11-04T12:00:00Z') }] } }, include: { items: true } });
    await prisma.personCache.update({ where: { id: person.id }, data: { email: ' Mixed@Case.COM ', emailNorm: null, additionalEmails: ['Two@Case.com', 'not an address'], additionalEmailsNorm: [] } });
    // Owned contacts without a pod, as they were before the release: the pod CHECK (S3, M2) is not there yet.
    await prisma.$executeRawUnsafe('ALTER TABLE "SandboxContact" DROP CONSTRAINT "SandboxContact_owner_has_pod"');
    const podless = await readyContact(b.users.karson.id, b.pods.Alisa.id, { podId: null });
    const adminOwned = await readyContact(b.users.ria.id, b.pods.Alisa.id, { podId: null });
    // The write paths fill these from now on; as they were before the release, they are empty.
    await prisma.sandboxContact.updateMany({ data: { emailIsRole: false, firstClaimedAt: null, pushedByName: null } });

    rerun('20261105000001_cold_outreach_backfill');

    const pods = new Map((await prisma.callLog.findMany({ select: { id: true, podId: true } })).map((c) => [c.id, c.podId]));
    expect(pods.get(byEnrollment.id)).toBe(b.pods.Andrew.id);
    expect(pods.get(byContact.id)).toBe(b.pods.Alisa.id);
    expect(pods.get(byPerson.id)).toBe(b.pods.Leigh.id);
    expect(pods.get(byRep.id)).toBe(b.pods.Alisa.id);
    expect(pods.get(noPod.id)).toBeNull();
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: meeting.id } })).kind).toBe('MEETING');
    // B050: an owner in one pod gives the contact that pod; an admin owner is listed instead.
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: podless.id } })).podId).toBe(b.pods.Alisa.id);
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: adminOwned.id } })).podId).toBeNull();
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: contact.id } })).toEqual(expect.objectContaining({
      emailIsRole: true, pushedByName: b.users.alisa.name, firstClaimedAt: new Date('2026-11-03T11:00:00Z'), lastOutcome: 'meeting_booked', lastOutcomeAt: new Date('2026-11-04T12:00:00Z'),
    }));
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: optedOut.id } })).optOutSource).toBe('call_form');
    expect((await prisma.sandboxMoveItem.findUniqueOrThrow({ where: { id: move.items[0].id } })).undoUntil).toEqual(new Date('2027-11-04T12:00:00Z'));
    expect(await prisma.personCache.findUniqueOrThrow({ where: { id: person.id } })).toEqual(expect.objectContaining({ emailNorm: 'mixed@case.com', additionalEmailsNorm: ['two@case.com'] }));
    const [logged] = await auditRows('cold_outreach_backfill');
    expect(logged.details).toEqual(expect.objectContaining({ callsWithoutPod: [noPod.id], contactsWithoutPod: [adminOwned.id] }));

    rerun('20261105000001_cold_outreach_backfill');
    expect(await auditRows('cold_outreach_backfill')).toHaveLength(1);

    // B050 (S3, M2): the release then lets go of the admin-owned contact, audited with who held it, and the CHECK holds.
    rerun('20261105200000_owned_contact_has_pod');
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: adminOwned.id } })).toEqual(expect.objectContaining({ ownerId: null, podId: null }));
    expect((await auditRows('released_by_migration'))[0].details).toEqual(expect.objectContaining({ from: b.users.ria.id }));
    await expect(prisma.sandboxContact.update({ where: { id: podless.id }, data: { podId: null } })).rejects.toThrow();
  });

  it('shared inboxes are told apart from personal addresses the same way here, in SQL and in Bellwether', () => {
    for (const shared of ['info@harbor.com', 'Compliance.Desk@harbor.com', 'customer-care@x.com', 'investments@x.com', 'no_reply@x.com', 'sales.team@x.com']) expect(isRoleEmail(shared)).toBe(true);
    for (const personal of ['jane.doe@harbor.com', 'information.officer@x.com', 'mainard@x.com', 'itzel@x.com', 'not-an-email']) expect(isRoleEmail(personal)).toBe(false);
  });

  it('D4: a ticket keeps who raised it about which contact, and the note it was closed with', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { status: 'OPTED_OUT', optedOutAt: new Date(), optOutSource: 'call_form' });
    const ticket = await prisma.ticket.create({ data: { kind: 'OPT_OUT', sandboxContactId: c.id, note: 'He said call next quarter, not never.', details: { source: 'call_form' }, raisedById: b.users.karson.id } });
    await prisma.ticket.update({ where: { id: ticket.id }, data: { open: false, resolvedById: b.users.ria.id, resolvedAt: new Date(), resolution: 'Lifted: the form was misfiled.', outcome: 'lifted' } });
    expect(await prisma.ticket.findMany({ where: { open: true } })).toEqual([]);
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id }, include: { raisedBy: true, sandboxContact: true } })).toEqual(expect.objectContaining({ kind: 'OPT_OUT', outcome: 'lifted', raisedBy: expect.objectContaining({ id: b.users.karson.id }), sandboxContact: expect.objectContaining({ id: c.id }) }));
  });
});
