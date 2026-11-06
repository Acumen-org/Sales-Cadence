import { beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { toActor } from '@/lib/auth/rbac';
import { canAct, type Act, type ColdSubject, type GuardActor } from '@/lib/outreach/guard';
import { contactability } from '@/lib/outreach/contactability';
import { coldRef, workWhere } from '@/lib/subject';
import { addNote, claimContact, removeContact } from '@/lib/sandbox/contacts';
import { optOutSandboxContact } from '@/lib/sandbox/opt-out';
import { setColdNextStep } from '@/lib/sandbox/work';
import { dueCounts } from '@/lib/tasks-query';
import { coldAudienceIssues } from '@/lib/sandbox/campaigns';
import { logManualCall, submitCallForm } from '@/lib/calls/form';
import { statusByIds } from '@/lib/sandbox/status';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/**
 * Stage S2 of the cold outreach rebuild: one guard for every write (PLAN 8.1). The matrix below is
 * the role table of 8.1 written as data; the test checks the code against it cell by cell, so the
 * table and the code cannot drift apart.
 */

type Who = 'own' | 'colleague' | 'unclaimed' | 'other_pod';
const ALL: Who[] = ['own', 'colleague', 'unclaimed', 'other_pod'];
const POD: Who[] = ['own', 'colleague', 'unclaimed'];
const ROLES: Role[] = ['SALES_LEADER', 'POD_MANAGER', 'SENIOR_FO', 'JUNIOR_FO', 'BIZ_OPS', 'ADMIN'];
const sales = (leader: Who[], junior: Who[], admin: Who[] = ALL, pm: Who[] = leader): Record<Role, Who[]> => ({ SALES_LEADER: leader, POD_MANAGER: pm, SENIOR_FO: leader, JUNIOR_FO: junior, BIZ_OPS: [], ADMIN: admin });

/** PLAN 8.1 "Who may do what", one row per act: which contacts each role may act on. */
const TABLE: Partial<Record<Act, Record<Role, Who[]>>> = {
  note: sales(POD, ['own', 'unclaimed']),
  edit: sales(POD, ['own', 'unclaimed']),
  call: sales(POD, ['own', 'unclaimed']),
  log_call: sales(POD, ['own', 'unclaimed']),
  next_action: sales(POD, ['own', 'unclaimed']),
  form_next_step: sales(POD, ['own', 'unclaimed']),
  claim: sales(['unclaimed'], ['unclaimed'], []),
  assign: sales(POD, []),
  release: sales(POD, ['own']),
  enroll: sales(POD, ['own', 'unclaimed'], ALL, ALL),
  move: sales(POD, ['own']),
  remove: sales(POD, ['own']),
  opt_out: sales(ALL, ALL),
  erase: sales([], [], ALL),
};

const actor = (role: Role): GuardActor => ({ id: `me-${role}`, role, podIds: role === 'ADMIN' || role === 'BIZ_OPS' ? [] : ['pod-a'] });
function subject(a: GuardActor, who: Who, over: Partial<ColdSubject> = {}): ColdSubject {
  const base: ColdSubject = { kind: 'cold', id: 'c1', status: 'ACTIVE', name: 'Jane Doe', ownerId: null, ownerName: null, ownerActive: true, podId: 'pod-a', podName: 'Pod A', twentyPersonId: null, movedById: null, optedOutAt: null, optOutSource: null, crmMatchPersonId: null, crmAutoPersonId: null, moving: false };
  if (who === 'own') return { ...base, ownerId: a.id, ownerName: 'Me', ...over };
  if (who === 'colleague') return { ...base, ownerId: 'colleague', ownerName: 'Alisa', ...over };
  if (who === 'other_pod') return { ...base, ownerId: 'stranger', ownerName: 'Leigh', podId: 'pod-b', podName: 'Pod B', ...over };
  return { ...base, ...over };
}

describe('the guard (PLAN 8.1)', () => {
  describe('the role table, cell by cell', () => {
    for (const [act, row] of Object.entries(TABLE) as [Act, Record<Role, Who[]>][]) {
      for (const role of ROLES) {
        it(`${act} by ${role}`, () => {
          const a = actor(role);
          // Assign gives the contact to someone else; letting go of it is Release.
          const opts = act === 'assign' ? { toUserId: 'someone-else' } : {};
          for (const who of ALL) expect({ who, ok: canAct(a, subject(a, who), act, opts).ok }).toEqual({ who, ok: row[role].includes(who) });
        });
      }
    }
    it('undo: leaders of the pod, the mover, admins', () => {
      for (const role of ROLES) {
        const a = actor(role);
        const moved = (who: Who, movedById: string | null) => canAct(a, subject(a, who, { status: 'MOVED', movedById, twentyPersonId: 'p1' }), 'undo').ok;
        expect(moved('colleague', 'colleague')).toBe(['SALES_LEADER', 'POD_MANAGER', 'SENIOR_FO', 'ADMIN'].includes(role));
        expect(moved('own', a.id)).toBe(role !== 'BIZ_OPS');
      }
    });
    it('lifting a form opt-out: admins any time, Biz Ops only when closing its ticket (D4)', () => {
      for (const role of ROLES) {
        const a = actor(role);
        const s = subject(a, 'colleague', { status: 'OPTED_OUT', optOutSource: 'call_form', optedOutAt: new Date() });
        expect(canAct(a, s, 'lift_opt_out').ok).toBe(role === 'ADMIN');
        expect(canAct(a, s, 'lift_opt_out', { viaTicket: true }).ok).toBe(role === 'ADMIN' || role === 'BIZ_OPS');
      }
      const admin = actor('ADMIN');
      const page = canAct(admin, subject(admin, 'own', { status: 'OPTED_OUT', optOutSource: 'contact_page' }), 'lift_opt_out');
      expect(page).toEqual(expect.objectContaining({ ok: false, reason: 'Only an opt-out from the post-call form can be lifted. This one came from the contact page.' }));
    });
  });

  it('which status allows which act', () => {
    const a = actor('ADMIN');
    const at = (status: ColdSubject['status'], act: Act) => canAct(a, subject(a, 'own', { status, twentyPersonId: status === 'MOVED' ? 'p1' : null }), act).ok;
    expect(['ACTIVE', 'REMOVED', 'MOVED'].map((s) => at(s as ColdSubject['status'], 'opt_out'))).toEqual([true, true, true]);
    expect(['ACTIVE', 'REMOVED', 'MOVED', 'OPTED_OUT'].map((s) => at(s as ColdSubject['status'], 'erase'))).toEqual([true, true, true, true]);
    expect(['ACTIVE', 'MOVED'].map((s) => at(s as ColdSubject['status'], 'undo'))).toEqual([false, true]);
    for (const act of ['note', 'edit', 'next_action', 'call', 'assign', 'enroll', 'move', 'remove'] as Act[]) {
      expect(['ACTIVE', 'OPTED_OUT', 'REMOVED', 'MOVED'].map((s) => at(s as ColdSubject['status'], act))).toEqual([true, false, false, false]);
    }
    const fo = actor('SENIOR_FO');
    expect(['ACTIVE', 'OPTED_OUT', 'REMOVED', 'MOVED'].map((status) => canAct(fo, subject(fo, 'unclaimed', { status: status as ColdSubject['status'] }), 'claim').ok)).toEqual([true, false, false, false]);
  });

  it('a move in flight stops every act but opt out and erase', () => {
    const a = actor('ADMIN');
    const s = subject(a, 'own', { moving: true });
    expect(canAct(a, s, 'note')).toEqual(expect.objectContaining({ ok: false, code: 'moving' }));
    expect(canAct(a, s, 'opt_out').ok).toBe(true);
    expect(canAct(a, s, 'erase').ok).toBe(true);
  });

  it('N017: an owner who has left counts as no owner, so the pod can work the contact', () => {
    const a = actor('JUNIOR_FO');
    expect(canAct(a, subject(a, 'colleague'), 'note').ok).toBe(false);
    expect(canAct(a, subject(a, 'colleague', { ownerActive: false }), 'note').ok).toBe(true);
  });

  it('B193: claim refusals give the real reason', () => {
    const fo = actor('JUNIOR_FO');
    expect(canAct(fo, subject(fo, 'own'), 'claim')).toEqual(expect.objectContaining({ reason: 'This contact is already yours.' }));
    expect(canAct(fo, subject(fo, 'colleague'), 'claim')).toEqual(expect.objectContaining({ reason: 'Alisa owns this contact.' }));
    expect(canAct(actor('BIZ_OPS'), subject(fo, 'unclaimed'), 'claim')).toEqual(expect.objectContaining({ reason: 'Biz Ops can view cold contacts but cannot change them.' }));
    expect(canAct(actor('ADMIN'), subject(fo, 'unclaimed'), 'claim')).toEqual(expect.objectContaining({ reason: 'Admins assign contacts; they do not own them.' }));
  });

  describe('on the database', () => {
    let b: Basics;
    beforeEach(async () => {
      await resetDb();
      b = await seedBasics();
    });
    const g = (u: { id: string; role: Role; pods?: unknown }, podIds: string[]) => toActor({ id: u.id, role: u.role, podIds });
    const alisa = () => g(b.users.alisa, [b.pods.Alisa.id]);
    const karson = () => g(b.users.karson, [b.pods.Alisa.id]);
    const leigh = () => g(b.users.leigh, [b.pods.Leigh.id]);
    const next = { label: 'Call', action: 'CALL' as const, dueDate: '2099-01-05' };

    it('B009: a next step on an opted-out, removed or moved contact is refused, and the Tasks list counts active contacts only', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      await setColdNextStep(c.id, { ...next, foUserId: b.users.alisa.id }, userActor(b.users.alisa), { guard: alisa() });
      expect(await dueCounts(b.users.alisa.id, 'cold', '2099-12-31')).toEqual({ today: 0, overdue: 1 });
      await optOutSandboxContact(c.id, { source: 'contact_page', actor: userActor(b.users.alisa) });
      const r = await setColdNextStep(c.id, { ...next, foUserId: b.users.alisa.id }, userActor(b.users.alisa), { guard: alisa() });
      expect(r).toEqual(expect.objectContaining({ ok: false, reason: 'This contact was opted out; nothing was changed.' }));
      expect(await prisma.nextAction.count({ where: { sandboxContactId: c.id, state: 'OPEN' } })).toBe(0);
      const removed = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      await removeContact(removed.id, userActor(b.users.alisa));
      expect((await setColdNextStep(removed.id, { ...next, foUserId: b.users.alisa.id }, userActor(b.users.alisa), { guard: alisa() }))).toEqual(expect.objectContaining({ ok: false, code: 'removed' }));
      // A stale open row on a contact that is no longer active never reaches the Tasks list or its count.
      const moved = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      await prisma.nextAction.create({ data: { sandboxContactId: moved.id, foUserId: b.users.alisa.id, ...next } });
      await prisma.sandboxContact.update({ where: { id: moved.id }, data: { status: 'OPTED_OUT' } });
      expect(await prisma.nextAction.count({ where: { AND: [workWhere('cold'), { foUserId: b.users.alisa.id, state: 'OPEN' }] } })).toBe(0);
      expect(await dueCounts(b.users.alisa.id, 'cold', '2099-12-31')).toEqual({ today: 0, overdue: 0 });
    });

    it('B048: a note on a moved contact is refused and says where it belongs', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { status: 'MOVED', twentyPersonId: 'person-03' });
      const r = await addNote(c.id, 'Spoke again', b.users.alisa, userActor(b.users.alisa), alisa());
      expect(r).toEqual({ ok: false, error: 'This contact is in the CRM now; nothing was changed here. Work them on their People page.' });
      expect(await prisma.sandboxNote.count({ where: { sandboxContactId: c.id } })).toBe(0);
    });

    it('B008: someone from another pod or Biz Ops cannot write; a Junior FO not to a colleague\'s contact', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      expect(await addNote(c.id, 'x', b.users.leigh, userActor(b.users.leigh), leigh())).toEqual(expect.objectContaining({ ok: false }));
      expect(await addNote(c.id, 'x', b.users.karson, userActor(b.users.karson), karson())).toEqual({ ok: false, error: 'This is Alisa Example\'s contact. Ask Alisa Example or your pod leader.'.replace(/Alisa Example/g, b.users.alisa.name) });
      const bea = await prisma.user.create({ data: { email: 'bea@cadence.local', name: 'Bea Ops', role: 'BIZ_OPS', passwordHash: 'x' } });
      expect(await addNote(c.id, 'x', bea, userActor(bea), toActor({ id: bea.id, role: 'BIZ_OPS', podIds: [] }))).toEqual({ ok: false, error: 'Biz Ops can view cold contacts but cannot change them.' });
      expect(await addNote(c.id, 'Fine', b.users.alisa, userActor(b.users.alisa), alisa())).toEqual({ ok: true, id: c.id });
    });

    it('B149: the first write on an unclaimed contact claims it, and a claim that loses says who won', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null, podId: null, claimedAt: null });
      expect((await setColdNextStep(c.id, { ...next, foUserId: b.users.karson.id }, userActor(b.users.karson), { guard: karson() })).ok).toBe(true);
      expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).toEqual(expect.objectContaining({ ownerId: b.users.karson.id, podId: b.pods.Alisa.id, firstClaimedAt: expect.any(Date) }));
      const r = await claimContact(c.id, { id: b.users.alisa.id, podIds: [b.pods.Alisa.id], role: 'SENIOR_FO' }, userActor(b.users.alisa));
      expect(r).toEqual({ ok: false, error: `${b.users.karson.name} claimed this contact first.` });
    });

    it('B053: a contact also in the CRM gets no next step and no call', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { crmMatchPersonId: 'person-03' });
      const r = await setColdNextStep(c.id, { ...next, foUserId: b.users.alisa.id }, userActor(b.users.alisa), { guard: alisa() });
      expect(r).toEqual(expect.objectContaining({ ok: false, code: 'in_crm', fix: { label: 'Move to CRM' } }));
      expect(await contactability(coldRef(c.id), { act: 'call', number: c.phone })).toEqual(expect.objectContaining({ ok: false, block: 'in_crm' }));
    });

    it('N077: an Email next step needs a usable email, a LinkedIn one a profile', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: null });
      const email = await setColdNextStep(c.id, { label: 'Email', action: 'EMAIL', dueDate: '2099-01-05', foUserId: b.users.alisa.id }, userActor(b.users.alisa), { guard: alisa() });
      expect(email).toEqual(expect.objectContaining({ ok: false, code: 'no_channel', reason: 'There is no email address for this contact. Pick another way, or add an email first.' }));
      const li = await setColdNextStep(c.id, { label: 'Connect', action: 'LINKEDIN_CONNECT', dueDate: '2099-01-05', foUserId: b.users.alisa.id }, userActor(b.users.alisa), { guard: alisa() });
      expect(li).toEqual(expect.objectContaining({ ok: false, code: 'no_channel' }));
      const bounced = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { badEmail: true });
      expect(await setColdNextStep(bounced.id, { label: 'Email', action: 'EMAIL', dueDate: '2099-01-05', foUserId: b.users.alisa.id }, userActor(b.users.alisa), { guard: alisa() })).toEqual(expect.objectContaining({ ok: false, reason: expect.stringContaining('bounced') }));
      // The form's next step refuses the same way, before anything is saved.
      const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
      const form = await submitCallForm(call.id, { outcome: 'no_answer', nextStep: 'email', nextStepDate: '2099-01-05' }, { id: b.users.alisa.id, name: 'Alisa', timezone: 'Europe/London' });
      expect(form).toEqual(expect.objectContaining({ ok: false, field: 'nextStep' }));
      expect(await prisma.callForm.count({ where: { callId: call.id } })).toBe(0);
    });

    it('B004: a form filed after the contact was opted out saves the call and form, sets no next step, and says why', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
      await optOutSandboxContact(c.id, { source: 'contact_page', actor: userActor(b.users.alisa) });
      const r = await submitCallForm(call.id, { outcome: 'no_answer', nextStep: 'call_again', nextStepDate: '2099-01-05' }, { id: b.users.alisa.id, name: 'Alisa', timezone: 'Europe/London', role: 'SENIOR_FO', podIds: [b.pods.Alisa.id] });
      expect(r).toEqual(expect.objectContaining({ ok: true, reminder: 'No next step was set: This contact was opted out; nothing was changed.' }));
      expect(await prisma.callForm.count({ where: { callId: call.id } })).toBe(1);
      expect(await prisma.nextAction.count({ where: { sandboxContactId: c.id, state: 'OPEN' } })).toBe(0);
    });

    it('B027: a colleague\'s form never replaces the owner\'s next step; it reaches them as a suggestion', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      await setColdNextStep(c.id, { label: 'Meeting', action: 'CALL', dueDate: '2099-01-09', foUserId: b.users.alisa.id }, userActor(b.users.alisa), { guard: alisa() });
      const call = await logManualCall({ userId: b.users.karson.id, sandboxContactId: c.id });
      const r = await submitCallForm(call.id, { outcome: 'no_answer', nextStep: 'call_again', nextStepDate: '2099-01-05' }, { id: b.users.karson.id, name: 'Karson', timezone: 'Europe/London', role: 'JUNIOR_FO', podIds: [b.pods.Alisa.id] });
      expect(r.ok).toBe(true);
      expect(await prisma.nextAction.findFirstOrThrow({ where: { sandboxContactId: c.id, state: 'OPEN' } })).toEqual(expect.objectContaining({ label: 'Meeting', foUserId: b.users.alisa.id }));
      expect(await prisma.notification.findFirstOrThrow({ where: { userId: b.users.alisa.id } })).toEqual(expect.objectContaining({ kind: 'next_step_suggestion', fromUserId: b.users.karson.id, sandboxContactId: c.id }));
    });

    it('B120: Call says why for a viewer who may not work the contact', async () => {
      const a = karson();
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const s = { kind: 'cold' as const, id: c.id, status: c.status, name: 'Sam', ownerId: c.ownerId, ownerName: 'Alisa', ownerActive: true, podId: c.podId, podName: 'Pod Alisa', twentyPersonId: null, movedById: null, optedOutAt: null, optOutSource: null, crmMatchPersonId: null, crmAutoPersonId: null, moving: false };
      expect(canAct(a, s, 'call')).toEqual(expect.objectContaining({ ok: false, reason: 'This is Alisa\'s contact. Ask Alisa or your pod leader.' }));
    });

    it('B132: a Junior FO cannot put a colleague\'s contact in a campaign', async () => {
      const mine = await readyContact(b.users.karson.id, b.pods.Alisa.id);
      const hers = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      // S7: the one cold audience check the studio, adding people and launch use.
      const issues = await coldAudienceIssues([mine.id, hers.id], { podId: b.pods.Alisa.id, podName: 'Pod Alisa', foIds: [], actor: karson() });
      expect(issues).toEqual([expect.objectContaining({ id: hers.id, reason: `Owned by ${b.users.alisa.name}. Junior FOs add only their own contacts` })]);
    });

    it('N008: the Call check at the click refuses a pending form, an opt-out and calling hours', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { state: 'IL' });
      const user = { id: b.users.alisa.id, timezone: 'Europe/London' };
      const noon = new Date('2026-11-04T18:00:00Z'); // 12:00 in Chicago
      expect((await contactability(coldRef(c.id), { act: 'call', number: c.phone, user, now: noon })).ok).toBe(true);
      expect(await contactability(coldRef(c.id), { act: 'call', number: c.phone, user, now: new Date('2026-11-05T04:00:00Z') })).toEqual(expect.objectContaining({ ok: false, block: 'calling_hours' }));
      const other = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      await logManualCall({ userId: b.users.alisa.id, sandboxContactId: other.id });
      expect(await contactability(coldRef(c.id), { act: 'call', number: c.phone, user, now: noon })).toEqual(expect.objectContaining({ ok: false, block: 'form_pending', reason: expect.stringContaining('Fill in the form for your call with') }));
      await optOutSandboxContact(c.id, { source: 'contact_page', actor: userActor(b.users.alisa) });
      expect(await contactability(coldRef(c.id), { act: 'call', number: c.phone, user, now: noon })).toEqual(expect.objectContaining({ ok: false, block: 'inactive' }));
    });

    it('N026: Remove after an opt-out changes nothing, and Bellwether reads opted_out', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      await Promise.all([
        optOutSandboxContact(c.id, { source: 'contact_page', actor: userActor(b.users.alisa) }),
        removeContact(c.id, userActor(b.users.alisa)),
      ]);
      const row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } });
      expect(row.status).toBe('OPTED_OUT');
      expect((await statusByIds([c.bellwetherContactId!]))[0].status).toBe('opted_out');
      expect(await removeContact(c.id, userActor(b.users.alisa))).toEqual({ ok: false, error: 'This contact was opted out; nothing was changed.' });
    });
  });
});
