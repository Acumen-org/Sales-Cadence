import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { RETENTION_FORECAST_KEY, retentionForecast, runSandboxRetention } from '@/lib/sandbox/retention';
import { claimContact } from '@/lib/sandbox/contacts';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/**
 * Stage S2: retention, fixed and always on (owner, 5 Nov). Every action counts as activity, contacts
 * also in the CRM are kept, every candidate is read however many are kept, and each night the
 * contacts due in the next 30 days are recorded for Settings.
 */
const DAY = 86_400_000;
const NOW = new Date('2027-03-01T03:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

describe('retention', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });
  const old = (over: Parameters<typeof readyContact>[2] = {}) => readyContact(b.users.alisa.id, b.pods.Alisa.id, { createdAt: ago(200), lastActivityAt: null, ...over });

  it('N032: every action counts as activity: a claim, an assignment or an edit keeps the contact', async () => {
    const idle = await old();
    const claimed = await old({ ownerId: null, podId: null, claimedAt: null });
    await claimContact(claimed.id, { id: b.users.karson.id, podIds: [b.pods.Alisa.id], role: 'JUNIOR_FO' }, userActor(b.users.karson));
    await prisma.auditLog.updateMany({ where: { entityId: claimed.id }, data: { createdAt: ago(10) } });
    await prisma.sandboxContact.update({ where: { id: claimed.id }, data: { lastActivityAt: null } });
    const edited = await old();
    await prisma.auditLog.create({ data: { entityType: 'sandbox_contact', entityId: edited.id, action: 'edited', actorType: 'USER', actorId: b.users.alisa.id, createdAt: ago(20) } });
    const r = await runSandboxRetention(NOW);
    expect(r.removed).toBe(1);
    const status = async (id: string) => (await prisma.sandboxContact.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(idle.id)).toBe('REMOVED');
    expect(await status(claimed.id)).toBe('ACTIVE');
    expect(await status(edited.id)).toBe('ACTIVE');
  });

  it('N032: a next step done, a call, a note or a step done keeps the contact', async () => {
    const withCall = await old();
    await prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', sandboxContactId: withCall.id, startedAt: ago(30) } });
    const withNote = await old();
    await prisma.sandboxNote.create({ data: { sandboxContactId: withNote.id, body: 'x', createdAt: ago(5) } });
    const withDone = await old();
    await prisma.nextAction.create({ data: { sandboxContactId: withDone.id, foUserId: b.users.alisa.id, label: 'Call', action: 'CALL', dueDate: '2027-01-01', state: 'DONE', lastDoneAt: ago(40), createdAt: ago(60) } });
    expect((await runSandboxRetention(NOW)).removed).toBe(0);
  });

  it('N075: a contact also in the CRM is never removed and is listed as Move to CRM needed', async () => {
    const flagged = await old({ crmMatchPersonId: 'person-03' });
    const r = await runSandboxRetention(NOW);
    expect(r.removed).toBe(0);
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: flagged.id } })).status).toBe('ACTIVE');
    expect((await retentionForecast())?.moveToCrmNeeded).toEqual({ count: 1, ids: [flagged.id] });
  });

  it('never removes a contact with an open next step, a running enrollment, a form waiting or a move in flight', async () => {
    const a = await old();
    await prisma.nextAction.create({ data: { sandboxContactId: a.id, foUserId: b.users.alisa.id, label: 'Call', action: 'CALL', dueDate: '2027-05-01' } });
    const c = await old();
    await prisma.enrollment.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2027-01-01', status: 'PAUSED' } });
    const d = await old();
    await prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', sandboxContactId: d.id, startedAt: ago(300), formDueAt: ago(300) } });
    await prisma.sandboxContact.update({ where: { id: d.id }, data: { lastActivityAt: null } });
    expect((await runSandboxRetention(NOW)).removed).toBe(0);
  });

  it('B214: retention reads every candidate, however many come before the one that is due', async () => {
    // 600 contacts due within the month (never worked, 80 days old), and one due now with the last id.
    await prisma.sandboxContact.createMany({ data: Array.from({ length: 600 }, (_, i) => ({ id: `a-${String(i).padStart(4, '0')}`, source: 'BELLWETHER' as const, firstName: 'F', lastName: `L${i}`, ownerId: b.users.alisa.id, podId: b.pods.Alisa.id, createdAt: ago(80) })) });
    const due = await prisma.sandboxContact.create({ data: { id: 'zz-last', source: 'BELLWETHER', firstName: 'Due', lastName: 'Now', createdAt: ago(95) } });
    const r = await runSandboxRetention(NOW);
    expect(r.removed).toBe(1);
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: due.id } })).status).toBe('REMOVED');
    expect(r.forecast).toBe(600);
  });

  it('records each night what it would remove in the next 30 days, soonest first, and warns owners a week ahead', async () => {
    const soon = await old({ createdAt: ago(88) }); // never worked: due in 2 days
    const later = await old({ lastActivityAt: ago(160) }); // due in 20 days
    await old({ lastActivityAt: ago(100) }); // due in 80 days: not in the record
    await runSandboxRetention(NOW);
    const f = await retentionForecast();
    expect(f).toEqual(expect.objectContaining({ horizonDays: 30, total: 2, removedTonight: 0 }));
    expect(f!.items.map((i) => [i.id, i.basis, i.dueOn])).toEqual([[soon.id, 'never_worked', '2027-03-03'], [later.id, 'inactive', '2027-03-21']]);
    expect(await prisma.setting.findUnique({ where: { key: RETENTION_FORECAST_KEY } })).not.toBeNull();
    const notice = await prisma.notification.findFirstOrThrow({ where: { userId: b.users.alisa.id, kind: 'retention_warning' } });
    expect(notice.payload).toEqual(expect.objectContaining({ count: 1, contactIds: [soon.id] }));
    // Nothing is removed by recording.
    expect(await prisma.sandboxContact.count({ where: { status: 'REMOVED' } })).toBe(0);
  });
});
