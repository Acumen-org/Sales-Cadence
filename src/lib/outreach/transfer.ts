import type { Prisma, PrismaClient, Role } from '@prisma/client';
import { isAdmin, isPodLeader, needsPod } from '../auth/rbac';
import { logAudit, type AuditActor } from '../audit';
import { localDateToInstant } from '../dates';
import { workspaceTimezone } from '../workspace';

/**
 * Who owns a cold contact, and what moves with it (cold outreach PLAN 8.8, W3). These are the rules
 * every path that sets a contact's owner or pod runs inside its own transaction: claim, the first
 * write's claim, assign, release, a campaign's claim at launch, access removal and a pod change. The
 * row lock and the guard are the caller's (guard.ts, ownership.ts); nothing here talks to Twenty.
 *
 * - The pod is never empty for an owned contact (B050; the database CHECK SandboxContact_owner_has_pod
 *   holds it): kept when the new owner is in it, else the owner's only pod, else the one the caller
 *   chose among the owner's pods. A release keeps the pod.
 * - Only an active sales rep owns a contact, never an admin or Biz Ops; a leader gives contacts only
 *   to the reps of the contact's pod (B119, B208).
 * - The contact's work moves with it, in the same transaction (B049, B147, N035): its open next step,
 *   and its running enrollments with their pending steps.
 */

type Tx = Prisma.TransactionClient;

/** A user who might own a cold contact, with their live pods. */
export type OwnerCandidate = { id: string; name: string; role: Role; active: boolean; podIds: string[] };
/** The acting user, as the rules read them. */
type Actor = { id: string; role: Role; podIds: string[] };

const RUNNING = ['ACTIVE', 'PAUSED'] as const;

export async function loadOwnerCandidate(tx: Tx | PrismaClient, userId: string): Promise<OwnerCandidate | null> {
  const u = await tx.user.findUnique({ where: { id: userId }, include: { pods: { where: { pod: { archived: false } }, select: { podId: true } } } });
  return u ? { id: u.id, name: u.name, role: u.role, active: u.active, podIds: u.pods.map((p) => p.podId) } : null;
}

export type PodChoice = { ok: true; podId: string } | { ok: false; reason: string; choices: string[] };

/**
 * The pod a contact takes with this owner (B050): the current one when the owner is in it, else the
 * owner's only pod, else the one the caller chose among the owner's pods. Otherwise the caller must
 * choose, and is told among which.
 */
export function podForOwner(owner: Pick<OwnerCandidate, 'name' | 'podIds'>, current: string | null, chosen?: string | null, podNames: Map<string, string> = new Map()): PodChoice {
  if (chosen && owner.podIds.includes(chosen)) return { ok: true, podId: chosen };
  if (current && owner.podIds.includes(current)) return { ok: true, podId: current };
  if (owner.podIds.length === 1) return { ok: true, podId: owner.podIds[0] };
  if (!owner.podIds.length) return { ok: false, reason: `${owner.name} is in no pod, so cannot own a cold contact. Ask an admin to add them to one.`, choices: [] };
  const names = owner.podIds.map((id) => podNames.get(id) ?? 'one of their pods').sort((a, b) => a.localeCompare(b));
  return { ok: false, reason: `${owner.name} is in ${names.join(' and ')}. Choose which pod this contact belongs to.`, choices: owner.podIds };
}

/**
 * Why this person may not own this contact for this actor, or null (B119, B208): active, a sales
 * role, and for anyone but an admin, a rep of the contact's pod (or of one of the actor's pods when
 * the contact has none yet). Taking a contact yourself is judged by the guard's claim rules.
 */
export function ownerRefusal(actor: Actor | null, to: OwnerCandidate, contactPodId: string | null, contactPodName: string | null = null): string | null {
  if (!to.active) return `${to.name} no longer has access to Cadence.`;
  if (!needsPod(to.role)) return `Only sales reps own cold contacts, and ${to.name} is ${to.role === 'ADMIN' ? 'an admin' : to.role === 'BIZ_OPS' ? 'in Biz Ops' : 'not a sales rep'}.`;
  if (!actor || isAdmin(actor) || actor.id === to.id) return null;
  if (contactPodId) {
    if (!to.podIds.includes(contactPodId)) return `${to.name} is not in ${contactPodName ?? 'this contact\'s pod'}. Give it to someone in ${contactPodName ?? 'that pod'}, or ask an admin.`;
    return null;
  }
  if (isPodLeader(actor) && !to.podIds.some((p) => actor.podIds.includes(p))) return `${to.name} is not in one of your pods.`;
  return null;
}

/** A running enrollment of this contact in a pod the new owner is not in: it cannot follow them (B049). */
export async function enrollmentPodClash(tx: Tx, contactId: string, to: OwnerCandidate): Promise<string | null> {
  const running = await tx.enrollment.findMany({ where: { sandboxContactId: contactId, personId: null, status: { in: [...RUNNING] }, foUserId: { not: to.id } }, select: { podId: true, pod: { select: { name: true } }, campaign: { select: { name: true } }, sequence: { select: { name: true } } } });
  const clash = running.find((e) => e.podId && !to.podIds.includes(e.podId));
  if (!clash) return null;
  return `${to.name} is not in ${clash.pod?.name ?? 'the pod'}, which runs ${clash.campaign?.name ?? clash.sequence.name} for this contact. Give it to someone in ${clash.pod?.name ?? 'that pod'}, or end the campaign for this contact first.`;
}

export type TransferAction = 'claimed' | 'assigned' | 'released' | 'reassigned';
export type TransferDone = { nextSteps: number; enrollments: number; tasks: number };

/**
 * Hand the contact and its work to `to` (or let it go when null), inside the caller's transaction
 * under the contact's row lock. The caller has already judged who may do it and settled the pod with
 * podForOwner; enrollmentPodClash must have returned null.
 */
export async function applyTransfer(tx: Tx, c: { id: string; ownerId: string | null }, to: Pick<OwnerCandidate, 'id'> | null, podId: string | null, opts: { actor: AuditActor; now: Date; action: TransferAction; reason?: string | null }): Promise<TransferDone> {
  const done: TransferDone = { nextSteps: 0, enrollments: 0, tasks: 0 };
  const [{ now: stamp }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  await tx.sandboxContact.update({ where: { id: c.id }, data: { ownerId: to?.id ?? null, podId, claimedAt: to ? opts.now : null, statusChangedAt: stamp } });
  if (to) {
    await tx.sandboxContact.updateMany({ where: { id: c.id, firstClaimedAt: null }, data: { firstClaimedAt: opts.now } });
    done.nextSteps = (await tx.nextAction.updateMany({ where: { sandboxContactId: c.id, personId: null, state: 'OPEN', foUserId: { not: to.id } }, data: { foUserId: to.id } })).count;
    const running = await tx.enrollment.findMany({ where: { sandboxContactId: c.id, personId: null, status: { in: [...RUNNING] }, foUserId: { not: to.id } }, select: { id: true, foUserId: true } });
    for (const e of running) {
      // As reassignEnrollment does, inside this transaction: the steps follow the enrollment (B049).
      const pending = await tx.task.findMany({ where: { enrollmentId: e.id, state: 'PENDING' }, select: { id: true, dueDate: true, snoozedTo: true } });
      for (const t of pending) await tx.task.update({ where: { id: t.id }, data: { foUserId: to.id, dueAt: localDateToInstant(t.snoozedTo ?? t.dueDate, workspaceTimezone(), 9), twentyTaskId: null } });
      await tx.enrollment.update({ where: { id: e.id }, data: { foUserId: to.id } });
      await logAudit({ entityType: 'enrollment', entityId: e.id, action: 'reassigned', actor: opts.actor, details: { from: e.foUserId, to: to.id, tasks: pending.length, reason: `contact_${opts.action}` } }, tx);
      done.enrollments++;
      done.tasks += pending.length;
    }
  }
  await logAudit({ entityType: 'sandbox_contact', entityId: c.id, action: opts.action, actor: opts.actor, details: { from: c.ownerId, to: to?.id ?? null, podId, nextSteps: done.nextSteps, enrollments: done.enrollments, tasks: done.tasks, ...(opts.reason ? { reason: opts.reason } : {}) } }, tx);
  return done;
}

/** "1 next step, 2 campaign steps": what a transfer moves, for confirms and results. */
export function workWords(w: { nextSteps: number; enrollments: number; tasks: number }): string {
  const parts = [
    ...(w.nextSteps ? [`${w.nextSteps} next step${w.nextSteps === 1 ? '' : 's'}`] : []),
    ...(w.enrollments ? [`${w.enrollments} campaign${w.enrollments === 1 ? '' : 's'}${w.tasks ? ` (${w.tasks} step${w.tasks === 1 ? '' : 's'})` : ''}`] : []),
  ];
  return parts.join(' and ');
}
