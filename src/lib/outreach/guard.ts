import type { Prisma, Role, SandboxStatus } from '@prisma/client';
import { prisma } from '../db';
import { isAdmin, isBizOps, isJuniorFo, isPodLeader, isPodManager, needsPod } from '../auth/rbac';
import type { AuditActor } from '../audit';
import type { SubjectRef } from '../subject';
import { applyTransfer, podForOwner } from './transfer';

/**
 * One guard for every write (cold outreach PLAN 8.1). `canAct(actor, subject, act)` says whether this
 * person may do this to this contact now, and why not in plain words with the fix. Server actions
 * run every write through `withSubjectLock`, which locks the contact's row, asks `canAct` again
 * inside the transaction, claims an unclaimed contact on its first write, and only then writes; so a
 * stale tab, a second tab or a race can never write to a contact that was opted out, removed or
 * moved meanwhile (B004, B008, B009, B048, B053, N026, N076). Network calls (Twenty, Twilio) never run
 * while the lock is held: callers make them after the transaction.
 */

export type Act = 'note' | 'edit' | 'next_action' | 'call' | 'log_call' | 'form_next_step' | 'claim' | 'assign' | 'release' | 'enroll' | 'move' | 'undo' | 'opt_out' | 'lift_opt_out' | 'remove' | 'erase';

/** The button that fixes a refusal, when there is one. */
export type Fix = { label: string; href?: string | null };
export type RefusalCode = 'not_found' | 'opted_out' | 'removed' | 'moved' | 'not_moved' | 'already_opted_out' | 'not_liftable' | 'moving' | 'read_only' | 'admins_assign' | 'already_yours' | 'claimed' | 'not_yours' | 'other_pod' | 'admins_only' | 'not_allowed' | 'deleted' | 'do_not_contact' | 'suppressed' | 'in_crm' | 'form_pending' | 'no_channel' | 'calling_hours' | 'call_limit';
export type Refusal = { ok: false; code: RefusalCode; reason: string; fix: Fix | null };
export type Verdict = { ok: true } | Refusal;

export const refuse = (code: RefusalCode, reason: string, fix: Fix | null = null): Refusal => ({ ok: false, code, reason, fix });

/** Who is acting: a signed-in user reduced to what the rules read. */
export type GuardActor = { id: string; role: Role; podIds: string[] };

/** A cold contact as the guard reads it, loaded inside the lock. */
export type ColdSubject = {
  kind: 'cold';
  id: string;
  status: SandboxStatus;
  name: string;
  ownerId: string | null;
  ownerName: string | null;
  /** False once the owner's access was removed: such a contact counts as unclaimed (N017). */
  ownerActive: boolean;
  podId: string | null;
  podName: string | null;
  twentyPersonId: string | null;
  movedById: string | null;
  optedOutAt: Date | null;
  optOutSource: string | null;
  crmMatchPersonId: string | null;
  crmAutoPersonId: string | null;
  /** A Move to CRM of this contact is queued or running (B005). */
  moving: boolean;
};

/** A CRM person as the guard reads it. */
export type PersonSubject = { kind: 'person'; id: string; name: string; deleted: boolean; dnd: boolean; optedOut: boolean; optOutSource: string | null };
export type GuardSubject = ColdSubject | PersonSubject;

/** Acts that do the contact's work: an unclaimed contact's first one claims it (8.1). */
export const WORK_ACTS = new Set<Act>(['note', 'edit', 'next_action', 'call', 'log_call', 'form_next_step']);
/** Acts that count as activity on the contact, for retention (N032). */
export const ACTIVITY_ACTS = new Set<Act>(['note', 'edit', 'next_action', 'call', 'log_call', 'form_next_step', 'claim', 'assign', 'enroll', 'undo']);

const SOURCE_WORDS: Record<string, string> = { call_form: 'the post-call form', contact_page: 'the contact page', suppression_list: 'the suppression list', bellwether: 'Bellwether', erase: 'an erasure', skip_reason: 'a skipped step', person_page: 'the person page', email_reply: 'an email reply asking to stop' };
export const optOutSourceWords = (source: string | null | undefined) => SOURCE_WORDS[source ?? ''] ?? 'Cadence';

const leadersOf = (pod: string | null) => (pod ? `the Senior FOs, Sales Leaders and Pod Managers of ${pod}` : 'the leaders of its pod');

/** Step 1 of the guard: which status allows which act. */
function statusAllows(s: ColdSubject, act: Act): Refusal | null {
  if (act === 'erase') return null;
  if (act === 'opt_out') {
    if (s.status === 'OPTED_OUT') return refuse('already_opted_out', 'This contact is already opted out.');
    return null;
  }
  if (act === 'undo') return s.status === 'MOVED' ? null : refuse('not_moved', 'Only a contact that was moved to the CRM can be moved back.');
  if (act === 'lift_opt_out') {
    if (s.status !== 'OPTED_OUT') return refuse('not_liftable', 'This contact is not opted out.');
    if (s.optOutSource !== 'call_form') return refuse('not_liftable', `Only an opt-out from the post-call form can be lifted. This one came from ${optOutSourceWords(s.optOutSource)}.`);
    return null;
  }
  if (s.status === 'ACTIVE') return null;
  if (s.status === 'OPTED_OUT') return refuse('opted_out', 'This contact was opted out; nothing was changed.');
  if (s.status === 'REMOVED') return refuse('removed', 'This contact was removed; nothing was changed.');
  return refuse('moved', 'This contact is in the CRM now; nothing was changed here. Work them on their People page.', s.twentyPersonId ? { label: 'Open in People', href: `/people/${s.twentyPersonId}` } : null);
}

/** The owner the rules read: one whose access was removed counts as nobody (N017). */
export const effectiveOwner = (s: Pick<ColdSubject, 'ownerId' | 'ownerActive'>) => (s.ownerId && s.ownerActive ? s.ownerId : null);

function workRefusal(a: GuardActor, s: ColdSubject): Refusal | null {
  if (isAdmin(a)) return null;
  const owner = effectiveOwner(s);
  if (!owner) {
    if (s.podId && !a.podIds.includes(s.podId)) return refuse('other_pod', `This contact is in ${s.podName ?? 'another pod'}, which is not one of your pods.`);
    return null;
  }
  if (owner === a.id) return null;
  if (isPodLeader(a) && s.podId && a.podIds.includes(s.podId)) return null;
  const who = s.ownerName ?? 'someone else';
  if (isJuniorFo(a)) return refuse('not_yours', `This is ${who}'s contact. Ask ${who} or your pod leader.`);
  return refuse('not_yours', `This is ${who}'s contact${s.podName ? ` in ${s.podName}, which is not one of your pods` : ''}. Only ${who}, ${leadersOf(s.podName)}, and admins can change it.`);
}

/** Step 4 of the guard: ownership and pod, from the role table in PLAN 8.1. */
function ownershipRefusal(a: GuardActor, s: ColdSubject, act: Act, opts: CanActOptions): Refusal | null {
  const owner = effectiveOwner(s);
  const inPod = Boolean(s.podId && a.podIds.includes(s.podId));
  const leaderHere = isPodLeader(a) && inPod;
  switch (act) {
    case 'note': case 'edit': case 'next_action': case 'call': case 'log_call': case 'form_next_step':
      return workRefusal(a, s);
    case 'claim':
      if (isAdmin(a)) return refuse('admins_assign', 'Admins assign contacts; they do not own them.');
      if (owner === a.id) return refuse('already_yours', 'This contact is already yours.');
      if (owner) return refuse('claimed', `${s.ownerName ?? 'Someone else'} owns this contact.`);
      if (s.podId && !inPod) return refuse('other_pod', `This contact is in ${s.podName ?? 'another pod'}, which is not one of your pods.`);
      return null;
    case 'assign':
      if (isAdmin(a)) return null;
      if (isJuniorFo(a)) return owner === a.id && (!opts.toUserId || opts.toUserId === a.id) ? null : refuse('not_allowed', 'Junior FOs can let go of their own contacts but cannot give contacts to someone else.');
      if (leaderHere || owner === a.id || !owner) return null;
      return refuse('not_allowed', `Only ${leadersOf(s.podName)}, and admins, can give this contact to someone else.`);
    case 'release':
      if (isAdmin(a) || owner === a.id || leaderHere) return null;
      return refuse('not_allowed', `Only ${s.ownerName ?? 'its owner'}, ${leadersOf(s.podName)}, and admins can let this contact go.`);
    case 'enroll':
      // B132: a Junior FO puts only their own (and unclaimed) contacts in a campaign; a Pod Manager any pod's.
      if (isAdmin(a) || isPodManager(a)) return null;
      if (!owner || owner === a.id) return null;
      if (!isJuniorFo(a) && inPod) return null;
      return refuse('not_yours', `Owned by ${s.ownerName ?? 'someone else'}${isJuniorFo(a) ? '. Junior FOs add only their own contacts.' : '.'}`);
    case 'move': case 'remove':
      if (isAdmin(a) || owner === a.id || leaderHere) return null;
      return refuse('not_allowed', `Only ${s.ownerName ?? 'the owner'}, ${leadersOf(s.podName)}, and admins can ${act === 'move' ? 'move this contact' : 'remove this contact'}.`);
    case 'undo':
      if (isAdmin(a) || s.movedById === a.id || leaderHere) return null;
      return refuse('not_allowed', `Only the person who moved it, ${leadersOf(s.podName)}, and admins can undo this move.`);
    case 'opt_out':
      // Honouring a stop request never waits for the owner (8.1): any sales user, any contact.
      return null;
    case 'erase':
      return isAdmin(a) ? null : refuse('admins_only', 'Only admins can erase a contact.');
    case 'lift_opt_out':
      return isAdmin(a) || (isBizOps(a) && opts.viaTicket) ? null : refuse('admins_only', 'Only an admin, or Biz Ops closing its ticket, can lift an opt-out.');
  }
}

export type CanActOptions = { toUserId?: string | null; viaTicket?: boolean };

/**
 * May this actor do this act to this subject now? The first refusal, in the order of PLAN 8.1:
 * status, a move in flight, role (Biz Ops never writes), then ownership and pod. Contactability
 * (8.2), for acts that start outreach, is the caller's next step: see contactability.ts.
 */
export function canAct(a: GuardActor, s: GuardSubject, act: Act, opts: CanActOptions = {}): Verdict {
  if (s.kind === 'person') {
    if (s.deleted) return refuse('deleted', 'This person is no longer in the CRM.');
    if (isBizOps(a) && !(act === 'lift_opt_out' && opts.viaTicket)) return refuse('read_only', 'Biz Ops can view people but cannot change them.');
    if (act === 'erase' || act === 'claim' || act === 'undo' || act === 'move') return refuse('not_allowed', 'That is done in the CRM for a CRM person.');
    if (act === 'lift_opt_out') {
      if (!s.optedOut) return refuse('not_liftable', 'This person is not opted out in Cadence.');
      if (s.optOutSource !== 'call_form') return refuse('not_liftable', `Only an opt-out from the post-call form can be lifted. This one came from ${optOutSourceWords(s.optOutSource)}.`);
      return isAdmin(a) || (isBizOps(a) && opts.viaTicket) ? { ok: true } : refuse('admins_only', 'Only an admin, or Biz Ops closing its ticket, can lift an opt-out.');
    }
    if (act === 'opt_out' && s.optedOut) return refuse('already_opted_out', 'This person is already opted out.');
    return { ok: true };
  }
  const status = statusAllows(s, act);
  if (status) return status;
  if (s.moving && act !== 'opt_out' && act !== 'erase') return refuse('moving', 'This contact is being moved to the CRM. Try again in a minute.');
  if (isBizOps(a) && !(act === 'lift_opt_out' && opts.viaTicket)) return refuse('read_only', 'Biz Ops can view cold contacts but cannot change them.');
  if (!isAdmin(a) && !needsPod(a.role) && !isBizOps(a)) return refuse('read_only', 'Only sales roles and admins can work cold contacts.');
  return ownershipRefusal(a, s, act, opts) ?? { ok: true };
}

type Tx = Prisma.TransactionClient | typeof prisma;

/** The contact as the guard reads it, or null. */
export async function loadColdSubject(id: string, tx: Tx = prisma): Promise<ColdSubject | null> {
  const c = await tx.sandboxContact.findUnique({ where: { id }, include: { owner: { select: { name: true, active: true } }, pod: { select: { name: true } } } });
  if (!c) return null;
  const moving = await tx.sandboxMoveItem.count({ where: { sandboxContactId: id, state: { in: ['QUEUED', 'RUNNING'] } } });
  return {
    kind: 'cold', id: c.id, status: c.status, name: `${c.firstName} ${c.lastName}`.trim() || 'Removed contact', ownerId: c.ownerId, ownerName: c.owner?.name ?? null, ownerActive: c.owner?.active ?? false,
    podId: c.podId, podName: c.pod?.name ?? null, twentyPersonId: c.twentyPersonId, movedById: c.movedById, optedOutAt: c.optedOutAt, optOutSource: c.optOutSource,
    crmMatchPersonId: c.crmMatchPersonId, crmAutoPersonId: c.crmAutoPersonId, moving: moving > 0,
  };
}

export async function loadPersonSubject(id: string, tx: Tx = prisma): Promise<PersonSubject | null> {
  const p = await tx.personCache.findUnique({ where: { id }, select: { id: true, firstName: true, lastName: true, email: true, deletedAt: true, dnd: true, optedOut: true, optOutSource: true } });
  if (!p) return null;
  return { kind: 'person', id: p.id, name: `${p.firstName} ${p.lastName}`.trim() || p.email || 'This person', deleted: Boolean(p.deletedAt), dnd: p.dnd, optedOut: p.optedOut, optOutSource: p.optOutSource };
}

export async function loadSubject(ref: SubjectRef, tx: Tx = prisma): Promise<GuardSubject | null> {
  return ref.kind === 'cold' ? loadColdSubject(ref.id, tx) : loadPersonSubject(ref.id, tx);
}

/** Thrown inside a locked write to refuse after all; the transaction rolls back and the caller gets the refusal. */
export class RefusedError extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.reason);
    this.name = 'RefusedError';
  }
}

export type LockOptions = CanActOptions & { audit?: AuditActor; now?: Date; timeoutMs?: number };
export type Locked<T> = { ok: true; value: T; subject: GuardSubject; claimed: boolean } | Refusal;

/**
 * Run one write on one subject under its row lock (8.1): lock, load, `canAct`, claim on the first
 * work of an unclaimed contact (`where ownerId IS NULL`, or an owner who left), count the act as
 * activity, then `work`. `actor` null is Cadence itself (a job, Bellwether): only the status rules
 * apply. A refusal, or a RefusedError thrown by `work`, changes nothing.
 */
export async function withSubjectLock<T>(ref: SubjectRef, actor: GuardActor | null, act: Act, work: (tx: Prisma.TransactionClient, subject: GuardSubject) => Promise<T>, opts: LockOptions = {}): Promise<Locked<T>> {
  const now = opts.now ?? new Date();
  try {
    return await prisma.$transaction(async (tx) => {
      const locked = ref.kind === 'cold'
        ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "SandboxContact" WHERE id = ${ref.id} FOR UPDATE`
        : await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "PersonCache" WHERE id = ${ref.id} FOR UPDATE`;
      if (!locked.length) return refuse('not_found', ref.kind === 'cold' ? 'This contact is no longer in Cold outreach.' : 'This person is no longer in the CRM.');
      const subject = (await loadSubject(ref, tx))!;
      const verdict = actor ? canAct(actor, subject, act, opts) : subject.kind === 'cold' ? statusAllows(subject, act) ?? { ok: true as const } : { ok: true as const };
      if (!verdict.ok) return verdict;
      let claimed = false;
      if (actor && subject.kind === 'cold' && WORK_ACTS.has(act) && !effectiveOwner(subject) && needsPod(actor.role)) {
        // The first write claims (8.1), with the contact's work (8.8). Only one claim can win: the row is locked.
        const pod = podForOwner({ name: 'You', podIds: actor.podIds }, subject.podId);
        if (!pod.ok) return refuse('not_allowed', 'This contact has no pod yet, and you are in more than one. Claim it from the contacts list and choose its pod first.');
        await applyTransfer(tx, subject, { id: actor.id }, pod.podId, { actor: opts.audit ?? { type: 'USER', id: actor.id }, now, action: 'claimed', reason: act });
        Object.assign(subject, { ownerId: actor.id, ownerActive: true, podId: pod.podId });
        claimed = true;
      }
      if (actor && subject.kind === 'cold' && ACTIVITY_ACTS.has(act)) await tx.sandboxContact.update({ where: { id: subject.id }, data: { lastActivityAt: now } });
      const value = await work(tx, subject);
      return { ok: true as const, value, subject, claimed };
    }, { timeout: opts.timeoutMs ?? 20_000 });
  } catch (err) {
    if (err instanceof RefusedError) return err.refusal;
    throw err;
  }
}

/**
 * The guard's lock for Cadence itself when the caller already holds a transaction (the Bellwether
 * push writes to a contact it found inside its own): lock the row, load the contact, and judge the
 * act on its status, and refuse while a move is in flight. The caller writes after, in the same
 * transaction; nothing here talks to Twenty.
 */
export async function lockColdIn(tx: Prisma.TransactionClient, id: string, act: Act): Promise<{ ok: true; subject: ColdSubject } | Refusal> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "SandboxContact" WHERE id = ${id} FOR UPDATE`;
  if (!locked.length) return refuse('not_found', 'This contact is no longer in Cold outreach.');
  const subject = (await loadColdSubject(id, tx))!;
  const status = statusAllows(subject, act);
  if (status) return status;
  if (subject.moving && act !== 'opt_out' && act !== 'erase') return refuse('moving', 'This contact is being moved to the CRM. Try again in a minute.');
  return { ok: true, subject };
}
