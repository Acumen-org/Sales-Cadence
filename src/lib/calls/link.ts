import type { CallLog, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { formatLocalDate, todayIn, type LocalDate } from '../dates';
import { workspaceTimezone } from '../workspace';
import { OCCUPYING_STATUSES } from '../engine/enrollment';

/**
 * Which step a call closes (cold outreach PLAN 8.7). A call step is a PENDING Call task of a running
 * campaign, or an open Call next action (not a meeting). Two ways a call finds its step:
 *   - an explicit intent wins: the rep pressed Call on that step. It counts only when that step is a
 *     call step (N013): an Email or LinkedIn step never takes a call's result;
 *   - with no intent (the dialpad, a mobile, Log a call) the call takes a step only when it was
 *     completed and outbound, made by the step's rep or the contact's owner, and exactly one call step
 *     is due on the day of the call or before (B023). Steps planned ahead are never closed early, and
 *     an incoming call never closes a step (B093).
 * Otherwise the form asks, offering the call steps due by then.
 */

export type CallItem = {
  kind: 'task' | 'next';
  id: string;
  /** "Call 2 of Q4 Harbor", "Call on Thu 5 Nov". */
  words: string;
  dueDate: LocalDate;
  foUserId: string;
  /** A next action that repeats rolls on when the call closes it (N054). */
  repeats: boolean;
  enrollmentId: string | null;
  campaignId: string | null;
};

export type CallSubject = { personId: string | null; sandboxContactId: string | null };

const subjectOf = (s: CallSubject) => (s.personId ? { personId: s.personId } : s.sandboxContactId ? { sandboxContactId: s.sandboxContactId, personId: null } : null);

/** The subject's open call steps due on `upTo` or before (every one, when `upTo` is null), oldest first. */
export async function openCallItems(subject: CallSubject, upTo: LocalDate | null): Promise<CallItem[]> {
  const who = subjectOf(subject);
  if (!who) return [];
  const [tasks, next] = await Promise.all([
    prisma.task.findMany({
      where: { state: 'PENDING', action: 'CALL', enrollment: { ...who, status: { in: ['ACTIVE'] } } },
      select: { id: true, label: true, dueDate: true, snoozedTo: true, foUserId: true, enrollmentId: true, enrollment: { select: { campaignId: true, campaign: { select: { name: true } }, sequence: { select: { name: true } } } } },
      orderBy: [{ dueDate: 'asc' }, { stepIndex: 'asc' }],
    }),
    prisma.nextAction.findMany({ where: { ...who, state: 'OPEN', action: 'CALL', kind: 'ACTION' }, select: { id: true, label: true, dueDate: true, foUserId: true, repeat: true } }),
  ]);
  const items: CallItem[] = [
    ...tasks.map((t) => ({ kind: 'task' as const, id: t.id, words: `${t.label} of ${t.enrollment.campaign?.name ?? t.enrollment.sequence.name}`, dueDate: t.snoozedTo ?? t.dueDate, foUserId: t.foUserId, repeats: false, enrollmentId: t.enrollmentId, campaignId: t.enrollment.campaignId })),
    ...next.map((n) => ({ kind: 'next' as const, id: n.id, words: `${n.label === 'Call' || n.label === 'Call again' ? 'Call' : n.label} on ${formatLocalDate(n.dueDate)}`, dueDate: n.dueDate, foUserId: n.foUserId, repeats: n.repeat !== 'NONE', enrollmentId: null, campaignId: null })),
  ];
  return items.filter((i) => !upTo || i.dueDate <= upTo).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

/** The day a call happened on, for its rep. */
export async function callDay(call: Pick<CallLog, 'startedAt' | 'createdAt' | 'userId'>): Promise<LocalDate> {
  const tz = call.userId ? (await prisma.user.findUnique({ where: { id: call.userId }, select: { timezone: true } }))?.timezone : null;
  return todayIn(tz || workspaceTimezone(), call.startedAt ?? call.createdAt);
}

/** Who owns the subject: a cold contact's active owner, or the Cadence user behind a CRM person's owner. */
export async function ownerOfSubject(subject: CallSubject): Promise<string | null> {
  if (subject.sandboxContactId && !subject.personId) {
    const c = await prisma.sandboxContact.findUnique({ where: { id: subject.sandboxContactId }, select: { ownerId: true, owner: { select: { active: true } } } });
    return c?.ownerId && c.owner?.active ? c.ownerId : null;
  }
  if (!subject.personId) return null;
  const p = await prisma.personCache.findUnique({ where: { id: subject.personId }, select: { ownerMemberId: true } });
  if (!p?.ownerMemberId) return null;
  return (await prisma.user.findFirst({ where: { twentyMemberId: p.ownerMemberId, active: true }, select: { id: true } }))?.id ?? null;
}

/** An intent's step counts only when it is a call step still open (N013). */
export async function intentStep(intent: { taskId: string | null; nextActionId: string | null; personId?: string | null; sandboxContactId?: string | null }): Promise<{ taskId: string | null; nextActionId: string | null }> {
  const [task, next] = await Promise.all([
    intent.taskId ? prisma.task.findUnique({ where: { id: intent.taskId }, select: { action: true, state: true, enrollment: { select: { personId: true, sandboxContactId: true } } } }) : null,
    intent.nextActionId ? prisma.nextAction.findUnique({ where: { id: intent.nextActionId }, select: { action: true, kind: true, state: true, personId: true, sandboxContactId: true } }) : null,
  ]);
  // M44: when the press names who is called, the step must be theirs, not another person's.
  const named = intent.personId !== undefined || intent.sandboxContactId !== undefined;
  const theirs = (s: { personId: string | null; sandboxContactId: string | null } | null | undefined) => !named || Boolean(s && ((intent.personId && s.personId === intent.personId) || (intent.sandboxContactId && s.sandboxContactId === intent.sandboxContactId)));
  return {
    taskId: task?.action === 'CALL' && task.state === 'PENDING' && theirs(task.enrollment) ? intent.taskId : null,
    nextActionId: next?.action === 'CALL' && next.kind === 'ACTION' && next.state === 'OPEN' && theirs(next) ? intent.nextActionId : null,
  };
}

/** PLAN 8.7, with no intent: the one call step this call closes, or null when the form must ask. */
export async function stepByRule(call: Pick<CallLog, 'direction' | 'status' | 'userId' | 'startedAt' | 'createdAt' | 'personId' | 'sandboxContactId'>): Promise<CallItem | null> {
  if (call.direction !== 'OUTBOUND' || call.status !== 'COMPLETED' || !call.userId) return null;
  const subject = { personId: call.personId, sandboxContactId: call.personId ? null : call.sandboxContactId };
  const due = await openCallItems(subject, await callDay(call));
  if (due.length !== 1) return null;
  const [item] = due;
  if (item.foUserId === call.userId) return item;
  return (await ownerOfSubject(subject)) === call.userId ? item : null;
}

/** The link columns a call takes for a step. */
export const linkData = (item: CallItem | null): Prisma.CallLogUncheckedUpdateInput => ({ taskId: item?.kind === 'task' ? item.id : null, nextActionId: item?.kind === 'next' ? item.id : null, ...(item?.kind === 'task' ? { enrollmentId: item.enrollmentId, campaignId: item.campaignId } : {}) });

/** The steps the form offers for a call: the one it is linked to, and every call step due by its day. */
export async function callStepChoices(call: CallLog): Promise<{ linked: CallItem | null; choices: CallItem[] }> {
  const subject = { personId: call.personId, sandboxContactId: call.personId ? null : call.sandboxContactId };
  if (call.direction === 'INBOUND') return { linked: null, choices: [] };
  const all = await openCallItems(subject, null);
  const linked = all.find((i) => (i.kind === 'task' && i.id === call.taskId) || (i.kind === 'next' && i.id === call.nextActionId)) ?? null;
  const day = await callDay(call);
  const choices = all.filter((i) => i.dueDate <= day || i === linked);
  return { linked, choices };
}

/** Whether a running campaign holds the subject now: the form then offers "The campaign continues". */
export async function runningEnrollment(subject: CallSubject) {
  const who = subjectOf(subject);
  if (!who) return null;
  return prisma.enrollment.findFirst({ where: { ...who, status: { in: OCCUPYING_STATUSES } }, select: { id: true, status: true, campaignId: true, campaign: { select: { name: true } }, sequence: { select: { name: true } }, tasks: { where: { state: 'PENDING' }, orderBy: [{ dueDate: 'asc' }, { stepIndex: 'asc' }], take: 1, select: { label: true, dueDate: true, snoozedTo: true } } }, orderBy: { createdAt: 'desc' } });
}
