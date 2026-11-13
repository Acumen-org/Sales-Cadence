import type { CampaignAudience, Prisma } from '@prisma/client';
import { prisma } from '../db';

type Tx = Prisma.TransactionClient | typeof prisma;

/**
 * Audience stamping (PLAN 8.4, B037). Every Touch, CallLog, NextAction, Enrollment and CallForm
 * records once, when it is written, whether the work was CRM or cold outreach (SANDBOX). Nothing
 * ever updates it, Move and Undo included, so a move never rewrites a past report. A Task takes its
 * enrollment's. An unmatched call stays null and is stamped once, when it is matched.
 */

/** A row's subject as the insert knows it: the person, the cold contact, or both once it moved. */
export type AudienceSubject = { personId?: string | null; sandboxContactId?: string | null };

/**
 * SANDBOX for a cold contact that has not moved, CRM otherwise; null when the row is about nobody
 * yet (an unmatched call). `contactStatus` is the cold contact's status when the caller has it.
 */
export function audienceOf(subject: AudienceSubject, contactStatus?: string | null): CampaignAudience | null {
  if (subject.personId) return 'CRM';
  if (!subject.sandboxContactId) return null;
  return contactStatus === 'MOVED' ? 'CRM' : 'SANDBOX';
}

/** The same, reading the cold contact's status when only its id is known. */
export async function audienceFor(subject: AudienceSubject, tx: Tx = prisma): Promise<CampaignAudience | null> {
  if (subject.personId || !subject.sandboxContactId) return audienceOf(subject);
  const c = await tx.sandboxContact.findUnique({ where: { id: subject.sandboxContactId }, select: { status: true } });
  return audienceOf(subject, c?.status ?? null);
}

/**
 * The pod a call counts for, at the time of the call (B040): its enrollment's, else the cold
 * contact's, else the rep's only pod. Null when none of them says.
 */
export async function callPodFor(call: { enrollmentId?: string | null; sandboxContactId?: string | null; userId?: string | null; personId?: string | null }, tx: Tx = prisma): Promise<string | null> {
  if (call.enrollmentId) {
    const e = await tx.enrollment.findUnique({ where: { id: call.enrollmentId }, select: { podId: true } });
    if (e?.podId) return e.podId;
  }
  if (call.sandboxContactId) {
    const c = await tx.sandboxContact.findUnique({ where: { id: call.sandboxContactId }, select: { podId: true } });
    if (c?.podId) return c.podId;
  }
  if (call.userId) {
    const pods = await tx.userPod.findMany({ where: { userId: call.userId, pod: { archived: false } }, select: { podId: true }, take: 2 });
    if (pods.length === 1) return pods[0].podId;
  }
  // M40: a rep in several pods calling a CRM person in no campaign: the person's own pod in the CRM.
  if (call.personId) {
    const p = await tx.personCache.findUnique({ where: { id: call.personId }, select: { podOwner: true } });
    const pod = p?.podOwner ? await tx.pod.findFirst({ where: { podOwnerValue: p.podOwner, archived: false }, select: { id: true } }) : null;
    if (pod) return pod.id;
  }
  return null;
}
