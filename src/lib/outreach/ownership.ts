import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { isAdmin, isPodLeader, needsPod, ROLES_NEEDING_POD } from '../auth/rbac';
import { logAudit, type AuditActor } from '../audit';
import { coldRef } from '../subject';
import { formsHeldBy } from '../calls/form-holder';
import { refuse, RefusedError, withSubjectLock, type GuardActor, type Refusal } from './guard';
import { applyTransfer, enrollmentPodClash, loadOwnerCandidate, ownerRefusal, podForOwner, type OwnerCandidate, type TransferDone } from './transfer';

/**
 * Ownership and team changes (cold outreach PLAN 8.8, W3). `transferContact` is the one way a cold
 * contact changes hands, under its row lock and the guard: claim, assign and release. It moves the
 * contact's open next step and its running enrollments with their pending steps (B049, B147), keeps
 * the pod right (B050), gives contacts only to active sales reps of the contact's pod (B119), and an
 * assign happens only if the owner is still the one the leader saw (N076).
 *
 * Removing a rep's access (`leaverWork`, then the users action) and changing a rep's pods
 * (`rehomeContacts`) use the same rules, so nothing stays stranded with a removed user (N033, N034,
 * N035, N010, N107). What has no new owner yet is listed by `needsNewOwner` for the pod's leaders.
 */

export type TransferAct = 'claim' | 'assign' | 'release';
export type TransferOptions = {
  actor: AuditActor;
  /** The signed-in user the guard judges; null is Cadence itself. */
  guard: GuardActor | null;
  act?: TransferAct;
  /** The pod chosen, when the new owner is in more than one and the contact's is not theirs. */
  podId?: string | null;
  /**
   * N076: the owner the person giving it saw (null for "unclaimed"). The transfer happens only if
   * it is still the owner; left undefined, no check.
   */
  expectedOwnerId?: string | null;
  now?: Date;
  reason?: string | null;
};
export type TransferResult = ({ ok: true } & TransferDone & { ownerId: string | null; podId: string | null }) | Refusal;

async function podNames(tx: Prisma.TransactionClient, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  return new Map((await tx.pod.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
}

/** Give a cold contact to someone, or let it go (`toUserId` null), with its work. */
export async function transferContact(contactId: string, toUserId: string | null, opts: TransferOptions): Promise<TransferResult> {
  const now = opts.now ?? new Date();
  const act: TransferAct = toUserId === null ? 'release' : opts.act ?? 'assign';
  const r = await withSubjectLock(coldRef(contactId), opts.guard, act, async (tx, s) => {
    if (s.kind !== 'cold') throw new RefusedError(refuse('not_allowed', 'Only a cold contact changes hands here.'));
    if (opts.expectedOwnerId !== undefined && s.ownerId !== opts.expectedOwnerId) {
      // N076: someone claimed it, or was given it, after the page was drawn: nothing is taken from them.
      throw new RefusedError(refuse('claimed', s.ownerId ? `Just claimed by ${s.ownerName ?? 'someone else'}. Nothing was changed; reload to see it.` : 'This contact was let go since you looked. Nothing was changed; reload to see it.'));
    }
    if (act === 'claim' && !opts.guard && s.ownerId && s.ownerActive) throw new RefusedError(refuse('claimed', `${s.ownerName ?? 'Someone else'} claimed this contact first.`));
    if (act === 'release') {
      // 8.8: letting go of a contact with work would leave that work with nobody.
      const [open, running] = await Promise.all([
        tx.nextAction.count({ where: { sandboxContactId: contactId, personId: null, state: 'OPEN' } }),
        tx.enrollment.count({ where: { sandboxContactId: contactId, personId: null, status: { in: ['ACTIVE', 'PAUSED'] } } }),
      ]);
      if (open || running) throw new RefusedError(refuse('not_allowed', `${s.name} has ${running ? 'a campaign running' : 'an open next step'}. Hand it to someone instead, so the work is not left with nobody.`));
      // A release keeps the pod (B050): the contact stays in its pod's Unclaimed view.
      const done = await applyTransfer(tx, s, null, s.podId, { actor: opts.actor, now, action: 'released', reason: opts.reason });
      return { ...done, ownerId: null, podId: s.podId };
    }
    const to = await loadOwnerCandidate(tx, toUserId!);
    if (!to) throw new RefusedError(refuse('not_allowed', 'That person is not a Cadence user.'));
    const refusal = ownerRefusal(opts.guard, to, s.podId, s.podName);
    if (refusal) throw new RefusedError(refuse('not_allowed', refusal));
    const pod = podForOwner(to, s.podId, opts.podId, await podNames(tx, to.podIds));
    if (!pod.ok) throw new RefusedError(refuse('not_allowed', pod.reason));
    const clash = await enrollmentPodClash(tx, contactId, to);
    if (clash) throw new RefusedError(refuse('not_allowed', clash));
    const done = await applyTransfer(tx, s, to, pod.podId, { actor: opts.actor, now, action: act === 'claim' ? 'claimed' : 'assigned', reason: opts.reason });
    return { ...done, ownerId: to.id, podId: pod.podId };
  }, { audit: opts.actor, now, toUserId });
  return r.ok ? { ok: true, ...r.value } : r;
}

/**
 * Who this reader may give cold contacts to (B119, B208): active sales reps only, never admins or Biz
 * Ops; a pod leader's list is the reps of their own pods, an admin's every rep.
 */
export async function assignableOwners(reader: { id: string; role: GuardActor['role']; podIds: string[] }): Promise<{ id: string; name: string; podIds: string[] }[]> {
  if (!isAdmin(reader) && !isPodLeader(reader)) return [];
  const users = await prisma.user.findMany({
    where: { active: true, role: { in: ROLES_NEEDING_POD }, ...(isAdmin(reader) ? {} : { pods: { some: { podId: { in: reader.podIds } } } }) },
    select: { id: true, name: true, pods: { where: { pod: { archived: false } }, select: { podId: true } } }, orderBy: { name: 'asc' },
  });
  return users.map((u) => ({ id: u.id, name: u.name, podIds: u.pods.map((p) => p.podId) }));
}

// ---------------------------------------------------------------------------
// Removing a rep's access (N033, N034, N035, N010, N089, N107)
// ---------------------------------------------------------------------------


/** What a leaver still holds, which the Remove access dialog lists and moves (N089). */
export type LeaverWork = {
  contacts: number;
  coldNextSteps: number;
  crmNextActions: number;
  meetings: number;
  enrollments: number;
  forms: number;
  callerNumber: string | null;
  /** The pods their live enrollments and cold contacts are in: the replacement must be in the first. */
  enrollmentPodIds: string[];
  contactPodIds: string[];
};

export const leaverHasWork = (w: LeaverWork) => Boolean(w.contacts || w.coldNextSteps || w.crmNextActions || w.enrollments || w.forms || w.callerNumber);

/** What each of these users holds, a few queries for any number of users. */
export async function leaverWork(userIds: string[]): Promise<Map<string, LeaverWork>> {
  const out = new Map<string, LeaverWork>();
  if (!userIds.length) return out;
  const [contacts, next, enrollments, forms, users] = await Promise.all([
    prisma.sandboxContact.groupBy({ by: ['ownerId', 'podId'], where: { ownerId: { in: userIds }, status: 'ACTIVE' }, _count: { _all: true } }),
    prisma.nextAction.groupBy({ by: ['foUserId', 'kind'], where: { foUserId: { in: userIds }, state: 'OPEN', OR: [{ personId: { not: null } }, { sandboxContact: { status: 'ACTIVE' } }] }, _count: { _all: true } }),
    prisma.enrollment.groupBy({ by: ['foUserId', 'podId'], where: { foUserId: { in: userIds }, status: { in: ['ACTIVE', 'PAUSED'] } }, _count: { _all: true } }),
    prisma.callLog.findMany({ where: { formDueAt: { not: null }, formDoneAt: null, discardedAt: null, OR: [{ formUserId: { in: userIds } }, { formUserId: null, userId: { in: userIds } }] }, select: { userId: true, formUserId: true } }),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, callerNumber: true } }),
  ]);
  const coldNext = await prisma.nextAction.groupBy({ by: ['foUserId'], where: { foUserId: { in: userIds }, state: 'OPEN', personId: null, sandboxContact: { status: 'ACTIVE' } }, _count: { _all: true } });
  for (const u of users) {
    const mine = <T extends { _count: { _all: number } }>(rows: T[], key: (r: T) => string | null) => rows.filter((r) => key(r) === u.id);
    const cold = coldNext.find((r) => r.foUserId === u.id)?._count._all ?? 0;
    const allNext = mine(next, (r) => r.foUserId);
    out.set(u.id, {
      contacts: mine(contacts, (r) => r.ownerId).reduce((n, r) => n + r._count._all, 0),
      coldNextSteps: cold,
      crmNextActions: allNext.reduce((n, r) => n + r._count._all, 0) - cold,
      meetings: allNext.filter((r) => r.kind === 'MEETING').reduce((n, r) => n + r._count._all, 0),
      enrollments: mine(enrollments, (r) => r.foUserId).reduce((n, r) => n + r._count._all, 0),
      forms: forms.filter((f) => (f.formUserId ?? f.userId) === u.id).length,
      callerNumber: u.callerNumber,
      enrollmentPodIds: [...new Set(mine(enrollments, (r) => r.foUserId).flatMap((r) => (r.podId ? [r.podId] : [])))],
      contactPodIds: [...new Set(mine(contacts, (r) => r.ownerId).flatMap((r) => (r.podId ? [r.podId] : [])))],
    });
  }
  return out;
}

/** "12 cold contacts, 3 next steps (1 meeting), 2 forms waiting and the line +1...": what moves. */
export function leaverWorkWords(w: LeaverWork): string {
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  const next = w.coldNextSteps + w.crmNextActions;
  const parts = [
    ...(w.contacts ? [n(w.contacts, 'cold contact')] : []),
    ...(next ? [`${n(next, 'next step')}${w.meetings ? ` (${n(w.meetings, 'meeting')})` : ''}`] : []),
    ...(w.enrollments ? [n(w.enrollments, 'live enrollment')] : []),
    ...(w.forms ? [`${n(w.forms, 'call form')} waiting`] : []),
    ...(w.callerNumber ? [`the calling number ${w.callerNumber}`] : []),
  ];
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? 'nothing';
}

export type HandOverResult = { contacts: number; leftForLeaders: number; coldNextSteps: number; crmNextActionIds: string[]; forms: number; number: 'released' | 'moved' | null };

/**
 * Inside the access-removal transaction (users.ts locks both users first): the leaver's cold contacts
 * go to the replacement with their work when the replacement is in the contact's pod; the rest keep
 * the leaver, whose contacts count as unclaimed (N017) and show in the pod's "Needs a new owner" list.
 * Their open next steps (CRM ones are re-pushed to Twenty after), their pending forms and, if chosen,
 * their calling number go too.
 */
export async function handOverLeaverWork(tx: Prisma.TransactionClient, leaverId: string, replacement: OwnerCandidate, opts: { actor: AuditActor; now: Date; number: 'release' | 'move' }): Promise<HandOverResult> {
  const done: HandOverResult = { contacts: 0, leftForLeaders: 0, coldNextSteps: 0, crmNextActionIds: [], forms: 0, number: null };
  const owned = await tx.$queryRaw<{ id: string; podId: string | null }[]>`SELECT id, "podId" FROM "SandboxContact" WHERE "ownerId" = ${leaverId} AND status = 'ACTIVE' ORDER BY id FOR UPDATE`;
  for (const c of owned) {
    const pod = podForOwner(replacement, c.podId);
    if (!pod.ok || (c.podId && pod.podId !== c.podId) || (await enrollmentPodClash(tx, c.id, replacement))) { done.leftForLeaders++; continue; }
    const moved = await applyTransfer(tx, { id: c.id, ownerId: leaverId }, replacement, pod.podId, { actor: opts.actor, now: opts.now, action: 'reassigned', reason: 'team_access_removed' });
    done.contacts++;
    done.coldNextSteps += moved.nextSteps;
  }
  // B061: the contacts left with the leaver read unclaimed in Bellwether now (N017), so their change time moves.
  if (done.leftForLeaders) await tx.$executeRaw`UPDATE "SandboxContact" SET "statusChangedAt" = now() WHERE "ownerId" = ${leaverId} AND status = 'ACTIVE'`;
  // Cold next steps the leaver works on someone else's contact, in a pod the replacement is in.
  const coldLeft = await tx.nextAction.findMany({ where: { foUserId: leaverId, state: 'OPEN', personId: null, sandboxContact: { status: 'ACTIVE' } }, select: { id: true, sandboxContact: { select: { podId: true } } } });
  const coldIds = coldLeft.filter((n) => !n.sandboxContact?.podId || replacement.podIds.includes(n.sandboxContact.podId)).map((n) => n.id);
  if (coldIds.length) done.coldNextSteps += (await tx.nextAction.updateMany({ where: { id: { in: coldIds } }, data: { foUserId: replacement.id } })).count;
  // CRM next actions, a booked meeting included (N034): re-pushed to Twenty once the transaction ends.
  const crm = await tx.nextAction.findMany({ where: { foUserId: leaverId, state: 'OPEN', personId: { not: null } }, select: { id: true } });
  if (crm.length) {
    await tx.nextAction.updateMany({ where: { id: { in: crm.map((n) => n.id) } }, data: { foUserId: replacement.id, crmPending: true } });
    done.crmNextActionIds = crm.map((n) => n.id);
  }
  if (coldIds.length || crm.length) await logAudit({ entityType: 'user', entityId: leaverId, action: 'next_actions_reassigned', actor: opts.actor, details: { to: replacement.id, cold: coldIds.length, crm: crm.length } }, tx);
  // N010: forms waiting for the leaver go to the replacement; the call keeps its rep.
  const forms = await tx.callLog.findMany({ where: formsHeldBy(leaverId), select: { id: true } });
  for (const f of forms) {
    await tx.callLog.update({ where: { id: f.id }, data: { formUserId: replacement.id } });
    await logAudit({ entityType: 'call', entityId: f.id, action: 'form_reassigned', actor: opts.actor, details: { from: leaverId, to: replacement.id, reason: 'team_access_removed' } }, tx);
  }
  done.forms = forms.length;
  // N107: the leaver's Twilio line is let go, or moved to the replacement.
  const leaver = await tx.user.findUniqueOrThrow({ where: { id: leaverId }, select: { callerNumber: true } });
  if (leaver.callerNumber) {
    const number = leaver.callerNumber;
    await tx.user.update({ where: { id: leaverId }, data: { callerNumber: null } });
    if (opts.number === 'move') {
      const holder = await tx.user.findUniqueOrThrow({ where: { id: replacement.id }, select: { callerNumber: true } });
      if (holder.callerNumber) throw new RefusedError(refuse('not_allowed', `${replacement.name} already has the calling number ${holder.callerNumber}. Let ${number} go instead, and assign it in Settings > Calling.`));
      await tx.user.update({ where: { id: replacement.id }, data: { callerNumber: number } });
    }
    await logAudit({ entityType: 'user', entityId: leaverId, action: opts.number === 'move' ? 'caller_number_moved' : 'caller_number_released', actor: opts.actor, details: { number, to: opts.number === 'move' ? replacement.id : null } }, tx);
    done.number = opts.number === 'move' ? 'moved' : 'released';
  }
  return done;
}

// ---------------------------------------------------------------------------
// Changing a rep's pods (N090)
// ---------------------------------------------------------------------------

/**
 * Inside updateUserAction's transaction: a rep leaving a pod takes their cold contacts there along,
 * to their only new pod or the one the admin chose. Otherwise the change is refused with the count
 * and the choice to make. Their next steps follow the contacts.
 */
export async function rehomeContacts(tx: Prisma.TransactionClient, userId: string, userName: string, newPodIds: string[], chosenPodId: string | null, actor: AuditActor, now: Date): Promise<{ ok: true; moved: number } | { ok: false; error: string }> {
  const stranded = await tx.$queryRaw<{ id: string; podId: string | null }[]>`SELECT id, "podId" FROM "SandboxContact" WHERE "ownerId" = ${userId} AND status = 'ACTIVE' AND ("podId" IS NULL OR NOT ("podId" = ANY(${newPodIds}::text[]))) ORDER BY id FOR UPDATE`;
  if (!stranded.length) return { ok: true, moved: 0 };
  const target = chosenPodId && newPodIds.includes(chosenPodId) ? chosenPodId : newPodIds.length === 1 ? newPodIds[0] : null;
  if (!target) {
    const n = stranded.length;
    return { ok: false, error: newPodIds.length ? `${userName} owns ${n} cold contact${n === 1 ? '' : 's'} in a pod they are leaving. Choose which of their new pods ${n === 1 ? 'it moves' : 'they move'} to.` : `${userName} owns ${n} cold contact${n === 1 ? '' : 's'}. Give ${n === 1 ? 'it' : 'them'} to someone else before taking ${userName} out of every pod.` };
  }
  for (const c of stranded) await applyTransfer(tx, { id: c.id, ownerId: userId }, { id: userId }, target, { actor, now, action: 'reassigned', reason: 'pod_change' });
  return { ok: true, moved: stranded.length };
}

// ---------------------------------------------------------------------------
// Needs a new owner (N033, N034, N035, N069)
// ---------------------------------------------------------------------------

export type Stranded = { userId: string; name: string; contacts: number; nextSteps: number; forms: number; /** A few of the calls whose form waits, to open and hand on (N010). */ formCallIds: string[] };

/**
 * Work whose owner's access was removed, for the leaders of these pods (null: every pod, for admins):
 * cold contacts, open next steps (CRM and cold) and waiting forms, grouped by the removed rep.
 */
export async function needsNewOwner(podIds: string[] | null): Promise<Stranded[]> {
  const pods = podIds ? { in: podIds } : undefined;
  const [contacts, next, forms] = await Promise.all([
    prisma.sandboxContact.groupBy({ by: ['ownerId'], where: { status: 'ACTIVE', owner: { active: false }, ...(pods ? { podId: pods } : {}) }, _count: { _all: true } }),
    prisma.nextAction.groupBy({ by: ['foUserId'], where: { state: 'OPEN', fo: { active: false }, OR: [{ personId: { not: null } }, { sandboxContact: { status: 'ACTIVE' } }], ...(pods ? { fo: { active: false, pods: { some: { podId: pods } } } } : {}) }, _count: { _all: true } }),
    prisma.callLog.findMany({ where: { formDueAt: { not: null }, formDoneAt: null, discardedAt: null, ...(pods ? { podId: pods } : {}) }, select: { id: true, userId: true, formUserId: true } }),
  ]);
  const holders = [...new Set(forms.map((f) => f.formUserId ?? f.userId).filter((id): id is string => Boolean(id)))];
  const inactive = new Set((await prisma.user.findMany({ where: { id: { in: holders }, active: false }, select: { id: true } })).map((u) => u.id));
  const ids = [...new Set([...contacts.map((c) => c.ownerId), ...next.map((n) => n.foUserId), ...inactive].filter((id): id is string => Boolean(id)))];
  if (!ids.length) return [];
  const names = new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return ids.map((id) => ({
    userId: id, name: names.get(id) ?? 'Someone',
    contacts: contacts.find((c) => c.ownerId === id)?._count._all ?? 0,
    nextSteps: next.find((n) => n.foUserId === id)?._count._all ?? 0,
    forms: forms.filter((f) => (f.formUserId ?? f.userId) === id && inactive.has(id)).length,
    formCallIds: forms.filter((f) => (f.formUserId ?? f.userId) === id && inactive.has(id)).slice(0, 5).map((f) => f.id),
  })).filter((s) => s.contacts || s.nextSteps || s.forms).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A leader gives a removed rep's open next steps to a rep (N034): the CRM ones are re-pushed to
 * Twenty by the caller. Only next steps in the leader's pods move, and only to an active sales rep.
 */
export async function reassignStrandedNextActions(fromUserId: string, toUserId: string, reader: GuardActor, actor: AuditActor): Promise<{ ok: true; moved: number; crmIds: string[] } | { ok: false; error: string }> {
  if (!isAdmin(reader) && !isPodLeader(reader)) return { ok: false, error: 'Only pod leaders and admins can hand on a removed rep\'s next steps.' };
  const [from, to] = await Promise.all([prisma.user.findUnique({ where: { id: fromUserId } }), loadOwnerCandidate(prisma, toUserId)]);
  if (!from || from.active) return { ok: false, error: 'Only a removed rep\'s next steps are handed on here.' };
  if (!to || !to.active || !needsPod(to.role)) return { ok: false, error: 'Choose an active sales rep.' };
  const pods = isAdmin(reader) ? null : reader.podIds.filter((p) => to.podIds.includes(p));
  const where: Prisma.NextActionWhereInput = { foUserId: fromUserId, state: 'OPEN', ...(pods ? { OR: [{ sandboxContact: { podId: { in: pods }, status: 'ACTIVE' } }, { personId: { not: null }, fo: { pods: { some: { podId: { in: pods } } } } }] } : { OR: [{ personId: { not: null } }, { sandboxContact: { status: 'ACTIVE' } }] }) };
  const rows = await prisma.nextAction.findMany({ where, select: { id: true, personId: true } });
  if (!rows.length) return { ok: false, error: `${from.name} has no open next steps in a pod you and ${to.name} share.` };
  await prisma.nextAction.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { foUserId: toUserId } });
  const crmIds = rows.filter((r) => r.personId).map((r) => r.id);
  if (crmIds.length) await prisma.nextAction.updateMany({ where: { id: { in: crmIds } }, data: { crmPending: true } });
  await logAudit({ entityType: 'user', entityId: fromUserId, action: 'next_actions_reassigned', actor, details: { to: toUserId, count: rows.length } });
  return { ok: true, moved: rows.length, crmIds };
}
