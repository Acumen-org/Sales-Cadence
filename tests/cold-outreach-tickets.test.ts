import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/current-user';
import { logManualCall, submitCallForm } from '@/lib/calls/form';
import { suppressContacts } from '@/lib/sandbox/bellwether-suppress';
import { optOutContact } from '@/lib/outreach/transitions';
import { contactability } from '@/lib/outreach/contactability';
import { coldRef, personRef } from '@/lib/subject';
import { closeTicket, formOptOut, listTickets, openTicketCount } from '@/lib/tickets';
import { closeTicketAction, liftOptOutAction, raiseOptOutTicketAction } from '@/lib/actions/tickets';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/**
 * D4 (owner, 5 November 2026): a mistaken opt-out from the post-call form. Any admin undoes it at any
 * time; anyone raises "Think this is wrong?"; Biz Ops close the ticket with a note and may lift it.
 * Every lift is audited, removes only that opt-out's suppressions, restarts nothing, stamps
 * optOutLiftedAt for Bellwether, and never removes a Do not contact Bellwether set.
 */

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.requireUser, requireAdmin: auth.requireUser, toActor: (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let b: Basics;
const session = (u: { id: string; name: string; email: string; role: SessionUser['role'] }, podIds: string[] = []): SessionUser => ({ ...(u as unknown as SessionUser), podIds, pods: podIds.map((id) => ({ id, name: id })) });
const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return fd; };
const alisa = () => ({ id: b.users.alisa.id, name: b.users.alisa.name, timezone: 'Europe/London', role: 'SENIOR_FO' as const, podIds: [b.pods.Alisa.id] });

/** A cold contact Alisa opted out by the post-call form, in a running campaign with a next step first. */
async function formOptedOut() {
  const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
  const campaign = await prisma.campaign.create({ data: { name: 'Q4 Harbor', audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [c.id], startDate: '2026-11-02', status: 'ACTIVE' } });
  const enrollment = await prisma.enrollment.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, campaignId: campaign.id, sequenceId: b.sequence.id, startDate: '2026-11-02', status: 'ACTIVE', currentStep: 0, audience: 'SANDBOX' } });
  await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: '2099-01-05', crmPending: false, audience: 'SANDBOX' } });
  const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
  const r = await submitCallForm(call.id, { outcome: 'do_not_contact', rating: 2, notes: 'Said stop', nextStep: 'none' }, alisa());
  expect(r.ok).toBe(true);
  return { c, enrollment, call };
}

async function bizOps() {
  return prisma.user.create({ data: { email: 'bea@cadence.local', name: 'Bea Ops', role: 'BIZ_OPS', passwordHash: 'x' } });
}

describe('D4: mistaken opt-outs and the Tickets section', () => {
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });

  it('D4: any admin undoes a form opt-out at any time, with no reason; it is audited and restarts nothing', async () => {
    const { c, enrollment } = await formOptedOut();
    await prisma.sandboxContact.update({ where: { id: c.id }, data: { optedOutAt: new Date(Date.now() - 40 * 86_400_000) } });
    const before = await prisma.suppression.count();
    await prisma.suppression.create({ data: { kind: 'email', valueHash: 'admin-added-elsewhere', label: 'x', reason: 'opted_out', source: 'settings' } });
    auth.requireUser.mockResolvedValue(session(b.users.ria));
    expect(await liftOptOutAction(form({ sandboxContactId: c.id }))).toEqual({ ok: true, message: expect.stringContaining('Opt-out lifted. Nothing restarts') });
    const after = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } });
    expect(after).toEqual(expect.objectContaining({ status: 'ACTIVE', optedOutAt: null, optOutSource: null, optOutLiftedAt: expect.any(Date) }));
    // Bellwether's status feed reads the change from here.
    expect(after.statusChangedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // Only that opt-out's own suppression rows went; another source's stays.
    expect(await prisma.suppression.count({ where: { source: 'call_form', sandboxContactId: c.id } })).toBe(0);
    expect(await prisma.suppression.count({ where: { valueHash: 'admin-added-elsewhere' } })).toBe(1);
    expect(before).toBeGreaterThan(0);
    // Nothing restarts: the campaign stays ended and no next step comes back.
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status).toBe('EXITED');
    expect(await prisma.nextAction.count({ where: { sandboxContactId: c.id, state: 'OPEN' } })).toBe(0);
    expect(await prisma.auditLog.findFirst({ where: { entityId: c.id, action: 'opt_out_lifted' } })).toEqual(expect.objectContaining({ actorId: b.users.ria.id }));
    expect((await contactability(coldRef(c.id), { act: 'next_step', channel: 'EMAIL' })).ok).toBe(true);
  });

  it('D4: only an admin lifts directly, and only an opt-out from the post-call form', async () => {
    const { c } = await formOptedOut();
    auth.requireUser.mockResolvedValue(session(b.users.alisa, [b.pods.Alisa.id]));
    expect(await liftOptOutAction(form({ sandboxContactId: c.id }))).toEqual({ ok: false, error: expect.stringContaining('Only an admin') });
    const other = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await optOutContact(other.id, { source: 'contact_page', actor: userActor(b.users.alisa) });
    auth.requireUser.mockResolvedValue(session(b.users.ria));
    expect(await liftOptOutAction(form({ sandboxContactId: other.id }))).toEqual({ ok: false, error: expect.stringContaining('Only an opt-out from the post-call form') });
  });

  it('D4: anyone raises "Think this is wrong?" on a form opt-out, with what they know; one open at a time', async () => {
    const { c, call } = await formOptedOut();
    auth.requireUser.mockResolvedValue(session(b.users.karson, [b.pods.Alisa.id]));
    expect(await raiseOptOutTicketAction(form({ sandboxContactId: c.id, reason: '' }))).toEqual({ ok: false, error: 'Say why you think this opt-out is a mistake.' });
    expect(await raiseOptOutTicketAction(form({ sandboxContactId: c.id, reason: 'Alisa picked the wrong outcome: he booked a meeting' }))).toEqual({ ok: true, message: expect.stringContaining('Biz Ops will look at it') });
    const ticket = await prisma.ticket.findFirstOrThrow();
    expect(ticket).toEqual(expect.objectContaining({ kind: 'OPT_OUT', sandboxContactId: c.id, open: true, raisedById: b.users.karson.id, details: expect.objectContaining({ callId: call.id, source: 'call_form' }) }));
    expect(await raiseOptOutTicketAction(form({ sandboxContactId: c.id, reason: 'Again' }))).toEqual({ ok: false, error: expect.stringContaining('raised this already') });
    expect((await formOptOut(coldRef(c.id)))?.ticket?.id).toBe(ticket.id);
  });

  it('S32: two people raising it at the same moment open one ticket', async () => {
    const { c } = await formOptedOut();
    auth.requireUser.mockResolvedValue(session(b.users.karson, [b.pods.Alisa.id]));
    const both = await Promise.all([raiseOptOutTicketAction(form({ sandboxContactId: c.id, reason: 'One' })), raiseOptOutTicketAction(form({ sandboxContactId: c.id, reason: 'Two' }))]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.ticket.count({ where: { open: true } })).toBe(1);
  });

  it('D4: the Tickets section lists every open ticket, meeting-number checks included', async () => {
    const { c } = await formOptedOut();
    auth.requireUser.mockResolvedValue(session(b.users.karson, [b.pods.Alisa.id]));
    await raiseOptOutTicketAction(form({ sandboxContactId: c.id, reason: 'Wrong outcome' }));
    await prisma.meetingNumberTicket.create({ data: { personId: 'person-01', meetingDay: '2026-11-03', shownNumber: 2, expectedNumber: 1, note: 'First meeting', raisedById: b.users.alisa.id } });
    const open = await listTickets(true);
    expect(open.map((r) => [r.kindLabel, r.href.split('/')[1]])).toEqual([['Opt-out', 'tickets'], ['Meeting number', 'meetings']]);
    expect(await openTicketCount()).toBe(2);
  });

  it('D4: Biz Ops close an opt-out ticket with a note and may lift it; the lift is theirs and logged', async () => {
    const { c } = await formOptedOut();
    const bea = await bizOps();
    auth.requireUser.mockResolvedValue(session(b.users.karson, [b.pods.Alisa.id]));
    await raiseOptOutTicketAction(form({ sandboxContactId: c.id, reason: 'Wrong outcome' }));
    const ticket = await prisma.ticket.findFirstOrThrow();
    auth.requireUser.mockResolvedValue(session(bea));
    expect(await closeTicketAction(form({ ticketId: ticket.id, resolution: '', lift: '1' }))).toEqual({ ok: false, error: expect.stringContaining('Say what you found') });
    expect(await closeTicketAction(form({ ticketId: ticket.id, resolution: 'Listened to the call: he booked a meeting.', lift: '1' }))).toEqual(expect.objectContaining({ ok: true, redirectTo: '/tickets' }));
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toEqual(expect.objectContaining({ open: false, outcome: 'lifted', resolvedById: bea.id, resolution: 'Listened to the call: he booked a meeting.' }));
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('ACTIVE');
    expect(await prisma.auditLog.findFirst({ where: { entityId: c.id, action: 'opt_out_lifted' } })).toEqual(expect.objectContaining({ actorId: bea.id, details: expect.objectContaining({ viaTicket: true }) }));
    expect(await openTicketCount()).toBe(0);
  });

  it('D4: closing without the lift keeps the opt-out; reps cannot close tickets', async () => {
    const { c } = await formOptedOut();
    const bea = await bizOps();
    auth.requireUser.mockResolvedValue(session(b.users.karson, [b.pods.Alisa.id]));
    await raiseOptOutTicketAction(form({ sandboxContactId: c.id, reason: 'Wrong outcome' }));
    const ticket = await prisma.ticket.findFirstOrThrow();
    expect(await closeTicket(ticket.id, { note: 'x', lift: false }, { ...b.users.karson, podIds: [b.pods.Alisa.id] }, userActor(b.users.karson))).toEqual({ ok: false, error: 'Only Biz Ops and admins close tickets.' });
    expect(await closeTicket(ticket.id, { note: 'He did ask us to stop.', lift: false }, { ...bea, podIds: [] }, userActor(bea))).toEqual({ ok: true, message: 'Closed. The opt-out stays.' });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toEqual(expect.objectContaining({ open: false, outcome: 'kept' }));
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('OPTED_OUT');
  });

  it('D4: an admin\'s lift closes the open ticket with it', async () => {
    const { c } = await formOptedOut();
    auth.requireUser.mockResolvedValue(session(b.users.karson, [b.pods.Alisa.id]));
    await raiseOptOutTicketAction(form({ sandboxContactId: c.id, reason: 'Wrong outcome' }));
    auth.requireUser.mockResolvedValue(session(b.users.ria));
    await liftOptOutAction(form({ sandboxContactId: c.id }));
    expect(await prisma.ticket.findFirstOrThrow()).toEqual(expect.objectContaining({ open: false, outcome: 'lifted', resolution: `Lifted by ${b.users.ria.name}.` }));
  });

  it('D4: a lift never removes a Do not contact Bellwether set', async () => {
    const { c } = await formOptedOut();
    const row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } });
    await suppressContacts({ contacts: [{ bellwetherContactId: row.bellwetherContactId!, emails: [row.email!], phones: [], individualCrd: null }], reason: 'do_not_contact', note: 'Set in Bellwether', actor: { email: 'leigh@acumen-strategy.com', name: 'Leigh' } });
    auth.requireUser.mockResolvedValue(session(b.users.ria));
    expect(await liftOptOutAction(form({ sandboxContactId: c.id }))).toEqual({ ok: false, error: expect.stringContaining('Bellwether marked this person Do not contact too') });
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('OPTED_OUT');
    expect(await prisma.suppression.count({ where: { sandboxContactId: c.id, source: 'call_form' } })).toBeGreaterThan(0);
  });

  it('D4: a CRM person opted out by the form is lifted too, and their moved contact reads the lift', async () => {
    const call = await logManualCall({ userId: b.users.alisa.id, personId: 'person-03' });
    await submitCallForm(call.id, { outcome: 'do_not_contact', rating: 1, notes: 'Stop', nextStep: 'none' }, alisa());
    expect(await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-03' } })).toEqual(expect.objectContaining({ optedOut: true, optOutSource: 'call_form' }));
    auth.requireUser.mockResolvedValue(session(b.users.ria));
    expect((await liftOptOutAction(form({ personId: 'person-03' }))).ok).toBe(true);
    expect(await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-03' } })).toEqual(expect.objectContaining({ optedOut: false, optOutLiftedAt: expect.any(Date) }));
    expect(await formOptOut(personRef('person-03'))).toBeNull();
  });
});
