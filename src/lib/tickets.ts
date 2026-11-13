import type { Prisma, Role } from '@prisma/client';
import { prisma } from './db';
import { logAudit, type AuditActor } from './audit';
import { canCheckMeetingNumbers, type Actor } from './auth/rbac';
import { coldRef, personRef, subjectHref, type SubjectRef } from './subject';
import { liftOptOut } from './outreach/transitions';
import { contactability } from './outreach/contactability';
import type { GuardActor } from './outreach/guard';

/**
 * Tickets (D4, owner 5 November 2026): a question someone raises for Biz Ops, who look into it and
 * close it with a note. Two kinds today, in one list: "Think this is wrong?" on an opt-out that came
 * from the post-call form (Ticket, kind OPT_OUT), and the meeting-number checks (MeetingNumberTicket,
 * src/lib/actions/number-checks.ts), whose own page stays where it was.
 *
 * A form opt-out can be lifted by any admin at any time with no reason, or by Biz Ops when they close
 * its ticket. Every lift goes through liftOptOut: audited with who and when, it removes only that
 * opt-out's own suppression rows, restarts nothing, and stamps optOutLiftedAt (with statusChangedAt)
 * for Bellwether's status feed. It never takes away a Do not contact Bellwether set: when Bellwether
 * marked the person too, the lift is refused and says so.
 */

/** Biz Ops and admins work the Tickets section. */
export const canWorkTickets = (a: Actor) => canCheckMeetingNumbers(a);

export type TicketRow = {
  key: string;
  kind: 'opt_out' | 'meeting_number';
  kindLabel: string;
  /** Who it is about, and where their page is. */
  name: string;
  firm: string | null;
  subjectHref: string | null;
  /** The ticket's own page. */
  href: string;
  what: string | null;
  raisedBy: string | null;
  raisedAt: Date;
  open: boolean;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  outcome: string | null;
};

const OUTCOME_WORDS: Record<string, string> = { lifted: 'Opt-out lifted', kept: 'Opt-out kept' };
export const ticketOutcomeWords = (o: string | null) => (o ? OUTCOME_WORDS[o] ?? o : null);

/** Every ticket, open or closed, newest last when open (oldest waits longest) and newest first when closed. */
export async function listTickets(open: boolean): Promise<TicketRow[]> {
  const [tickets, checks] = await Promise.all([
    prisma.ticket.findMany({ where: { open }, orderBy: { createdAt: open ? 'asc' : 'desc' }, take: 200, include: { person: { select: { firstName: true, lastName: true, companyName: true } }, sandboxContact: { select: { firstName: true, lastName: true, companyName: true } }, raisedBy: { select: { name: true } }, resolvedBy: { select: { name: true } } } }),
    prisma.meetingNumberTicket.findMany({ where: { open }, orderBy: { createdAt: open ? 'asc' : 'desc' }, take: 200, include: { person: { select: { firstName: true, lastName: true, companyName: true } }, raisedBy: { select: { name: true } }, resolvedBy: { select: { name: true } } } }),
  ]);
  const rows: TicketRow[] = [
    ...tickets.map((t) => {
      const who = t.person ?? t.sandboxContact;
      const ref = t.personId ? personRef(t.personId) : t.sandboxContactId ? coldRef(t.sandboxContactId) : null;
      return { key: `ticket:${t.id}`, kind: t.kind === 'OPT_OUT' ? 'opt_out' as const : 'meeting_number' as const, kindLabel: t.kind === 'OPT_OUT' ? 'Opt-out' : 'Meeting number', name: who ? `${who.firstName} ${who.lastName}`.trim() || 'Removed contact' : 'Removed contact', firm: who?.companyName ?? null, subjectHref: ref ? subjectHref(ref) : null, href: `/tickets/${t.id}`, what: t.note, raisedBy: t.raisedBy?.name ?? null, raisedAt: t.createdAt, open: t.open, resolution: t.resolution, resolvedBy: t.resolvedBy?.name ?? null, resolvedAt: t.resolvedAt, outcome: t.outcome };
    }),
    ...checks.map((c) => ({ key: `check:${c.id}`, kind: 'meeting_number' as const, kindLabel: 'Meeting number', name: `${c.person.firstName} ${c.person.lastName}`.trim() || 'Unnamed contact', firm: c.person.companyName, subjectHref: subjectHref(personRef(c.personId)), href: `/meetings/checks/${c.id}`, what: c.note, raisedBy: c.raisedBy?.name ?? null, raisedAt: c.createdAt, open: c.open, resolution: c.resolution, resolvedBy: c.resolvedBy?.name ?? null, resolvedAt: c.resolvedAt, outcome: null })),
  ];
  return rows.sort((a, b) => (open ? a.raisedAt.getTime() - b.raisedAt.getTime() : (b.resolvedAt ?? b.raisedAt).getTime() - (a.resolvedAt ?? a.raisedAt).getTime()));
}

/** The open tickets of every kind, for the nav badge. */
export async function openTicketCount(): Promise<number> {
  const [a, b] = await Promise.all([prisma.ticket.count({ where: { open: true } }), prisma.meetingNumberTicket.count({ where: { open: true } })]);
  return a + b;
}

const subjectWhere = (ref: SubjectRef) => (ref.kind === 'person' ? { personId: ref.id } : { sandboxContactId: ref.id });

/** A form opt-out as the pages show it: when, by whom, on which call; and its open ticket, if any. */
export async function formOptOut(ref: SubjectRef): Promise<null | { at: Date | null; byName: string | null; callId: string | null; ticket: { id: string; raisedBy: string | null; raisedAt: Date } | null; lastTicket: { resolution: string | null; outcome: string | null; resolvedAt: Date | null } | null }> {
  const row = ref.kind === 'cold'
    ? await prisma.sandboxContact.findUnique({ where: { id: ref.id }, select: { status: true, optOutSource: true, optedOutAt: true } })
    : await prisma.personCache.findUnique({ where: { id: ref.id }, select: { optedOut: true, optOutSource: true, optedOutAt: true } });
  if (!row || row.optOutSource !== 'call_form') return null;
  if ('status' in row ? row.status !== 'OPTED_OUT' : !row.optedOut) return null;
  const callForm = await prisma.callForm.findFirst({ where: { outcome: 'do_not_contact', call: ref.kind === 'person' ? { personId: ref.id } : { sandboxContactId: ref.id } }, orderBy: { submittedAt: 'desc' }, select: { callId: true, userId: true } });
  const [by, ticket, last] = await Promise.all([
    callForm ? prisma.user.findUnique({ where: { id: callForm.userId }, select: { name: true } }) : null,
    prisma.ticket.findFirst({ where: { kind: 'OPT_OUT', open: true, ...subjectWhere(ref) }, include: { raisedBy: { select: { name: true } } } }),
    prisma.ticket.findFirst({ where: { kind: 'OPT_OUT', open: false, ...subjectWhere(ref) }, orderBy: { resolvedAt: 'desc' }, select: { resolution: true, outcome: true, resolvedAt: true } }),
  ]);
  return { at: row.optedOutAt, byName: by?.name ?? null, callId: callForm?.callId ?? null, ticket: ticket ? { id: ticket.id, raisedBy: ticket.raisedBy?.name ?? null, raisedAt: ticket.createdAt } : null, lastTicket: last };
}

export type TicketResult = { ok: true; id: string; message: string } | { ok: false; error: string };

/** "Think this is wrong?": anyone raises it on an opt-out from the post-call form, saying what they know. One open at a time. */
export async function raiseOptOutTicket(ref: SubjectRef, note: string, user: { id: string; name: string }, actor: AuditActor): Promise<TicketResult> {
  const what = note.trim();
  if (!what) return { ok: false, error: 'Say why you think this opt-out is a mistake.' };
  if (what.length > 1000) return { ok: false, error: 'Keep it under 1,000 characters.' };
  const opt = await formOptOut(ref);
  if (!opt) return { ok: false, error: 'Only an opt-out from the post-call form can be checked. This person is not opted out that way.' };
  if (opt.ticket) return { ok: false, error: `${opt.ticket.raisedBy ?? 'Someone'} raised this already. Biz Ops are looking at it.` };
  const moved = ref.kind === 'cold' ? await prisma.sandboxContact.findUnique({ where: { id: ref.id }, select: { twentyPersonId: true } }) : null;
  // S32: checked again under a lock on this person, so two people raising it at once open one ticket.
  const ticket = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`ticket:opt-out:${ref.kind}:${ref.id}`}))`;
    if (await tx.ticket.count({ where: { kind: 'OPT_OUT', open: true, ...subjectWhere(ref) } })) return null;
    return tx.ticket.create({
      data: { kind: 'OPT_OUT', ...subjectWhere(ref), ...(moved?.twentyPersonId ? { personId: moved.twentyPersonId } : {}), note: what, raisedById: user.id, details: { optedOutAt: opt.at?.toISOString() ?? null, source: 'call_form', callId: opt.callId, by: opt.byName } as Prisma.InputJsonValue },
    });
  });
  if (!ticket) return { ok: false, error: 'Someone raised this already. Biz Ops are looking at it.' };
  await logAudit({ entityType: 'ticket', entityId: ticket.id, action: 'raised', actor, details: { kind: 'OPT_OUT', subject: `${ref.kind}:${ref.id}` } });
  return { ok: true, id: ticket.id, message: 'Raised. Biz Ops will look at it and answer here.' };
}

/** Did Bellwether mark this person Do not contact too? Then a lift here would take that away: refused. */
async function bellwetherStillSays(ref: SubjectRef, since: Date | null): Promise<boolean> {
  const ids = [ref.id];
  if (ref.kind === 'person') ids.push(...(await prisma.sandboxContact.findMany({ where: { twentyPersonId: ref.id }, select: { id: true } })).map((c) => c.id));
  return (await prisma.auditLog.count({ where: { entityId: { in: ids }, action: 'bellwether_do_not_contact', ...(since ? { createdAt: { gte: since } } : {}) } })) > 0;
}

/**
 * Lift a form opt-out (D4): an admin at any time with no reason, or Biz Ops closing its ticket.
 * Its open ticket closes with it. The answer says what still blocks contact, if anything does.
 */
export async function liftFormOptOut(ref: SubjectRef, user: { id: string; name: string; role: Role; podIds: string[] }, actor: AuditActor, opts: { viaTicket?: string; note?: string | null; now?: Date } = {}): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const now = opts.now ?? new Date();
  const opt = await formOptOut(ref);
  if (!opt) return { ok: false, error: 'Only an opt-out from the post-call form can be lifted, and this one is not, or was lifted already.' };
  if (await bellwetherStillSays(ref, opt.at)) return { ok: false, error: 'Bellwether marked this person Do not contact too. That stays, so the opt-out stays: ask in Bellwether first.' };
  const guard: GuardActor = { id: user.id, role: user.role, podIds: user.podIds };
  const r = await liftOptOut(ref, { actor, guard, now, viaTicket: Boolean(opts.viaTicket) });
  if (!r.ok) return { ok: false, error: r.reason };
  // The ticket closes with the lift: the one Biz Ops is closing, or any left open when an admin lifts it directly.
  const resolution = opts.note?.trim() || `Lifted by ${user.name}.`;
  await prisma.ticket.updateMany({ where: { kind: 'OPT_OUT', open: true, ...subjectWhere(ref) }, data: { open: false, resolvedById: user.id, resolvedAt: now, resolution: resolution.slice(0, 1000), outcome: 'lifted' } });
  const still = await contactability(ref, { act: 'next_step', now });
  return { ok: true, message: `Opt-out lifted. Nothing restarts: set a next step if one is wanted.${!still.ok && still.block !== 'no_channel' ? ` Still blocked: ${still.reason}` : ''}` };
}

/** Biz Ops (or an admin) closes a ticket with a note; on an opt-out ticket they may lift the opt-out (D4). */
export async function closeTicket(id: string, input: { note: string; lift: boolean }, user: { id: string; name: string; role: Role; podIds: string[] }, actor: AuditActor, now = new Date()): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  if (!canWorkTickets({ id: user.id, role: user.role, podIds: user.podIds })) return { ok: false, error: 'Only Biz Ops and admins close tickets.' };
  const note = input.note.trim();
  if (!note) return { ok: false, error: 'Say what you found: the person who raised it reads it.' };
  const ticket = await prisma.ticket.findUnique({ where: { id } });
  if (!ticket) return { ok: false, error: 'Ticket not found.' };
  if (!ticket.open) return { ok: false, error: 'This ticket is closed already.' };
  if (input.lift) {
    if (ticket.kind !== 'OPT_OUT') return { ok: false, error: 'Only an opt-out ticket can lift an opt-out.' };
    const ref = ticket.sandboxContactId && !(await prisma.sandboxContact.count({ where: { id: ticket.sandboxContactId, status: 'MOVED' } })) ? coldRef(ticket.sandboxContactId) : ticket.personId ? personRef(ticket.personId) : null;
    if (!ref) return { ok: false, error: 'The person this ticket is about is no longer in Cadence.' };
    const r = await liftFormOptOut(ref, user, actor, { viaTicket: id, note, now });
    if (!r.ok) return r;
    // liftFormOptOut closed it; make sure this one reads as closed by this note.
    await prisma.ticket.updateMany({ where: { id }, data: { open: false, resolvedById: user.id, resolvedAt: now, resolution: note.slice(0, 1000), outcome: 'lifted' } });
    await logAudit({ entityType: 'ticket', entityId: id, action: 'closed', actor, details: { outcome: 'lifted' } });
    return { ok: true, message: r.message };
  }
  const done = await prisma.ticket.updateMany({ where: { id, open: true }, data: { open: false, resolvedById: user.id, resolvedAt: now, resolution: note.slice(0, 1000), outcome: ticket.kind === 'OPT_OUT' ? 'kept' : 'unchanged' } });
  if (!done.count) return { ok: false, error: 'This ticket is closed already.' };
  await logAudit({ entityType: 'ticket', entityId: id, action: 'closed', actor, details: { outcome: ticket.kind === 'OPT_OUT' ? 'kept' : 'unchanged' } });
  return { ok: true, message: ticket.kind === 'OPT_OUT' ? 'Closed. The opt-out stays.' : 'Closed.' };
}
