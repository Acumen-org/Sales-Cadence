import type { ActionType, NextActionRepeat, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { SANDBOX_SUBJECT, SANDBOX_TASK } from '../subject';
import { WORKABLE } from '../tasks-query';

/**
 * Sandbox > Work: the sandbox's own steps and next actions. They never reach Tasks, Home or Twenty
 * (decision 2): a sandbox contact's next action stays in Cadence until the contact moves.
 */

export async function setSandboxNextAction(contactId: string, input: { label: string; action: ActionType; dueDate: string; repeat?: NextActionRepeat; foUserId: string }, actor: AuditActor & { id?: string | null }): Promise<string> {
  const data = { label: input.label, action: input.action, dueDate: input.dueDate, repeat: input.repeat ?? 'NONE', foUserId: input.foUserId, crmPending: false, crmError: null };
  const row = await prisma.$transaction(async (tx) => {
    const open = await tx.nextAction.findFirst({ where: { sandboxContactId: contactId, personId: null, state: 'OPEN' }, select: { id: true } });
    return open ? tx.nextAction.update({ where: { id: open.id }, data }) : tx.nextAction.create({ data: { ...data, sandboxContactId: contactId, createdById: actor.id ?? null } });
  });
  await logAudit({ entityType: 'sandbox_contact', entityId: contactId, action: 'next_action_set', actor, details: { label: row.label, dueDate: row.dueDate } });
  return row.id;
}

export const sandboxTaskInclude = {
  enrollment: { include: { sandboxContact: { select: { id: true, firstName: true, lastName: true, companyName: true, jobTitle: true, email: true, phone: true, linkedinUrl: true, status: true, state: true, companyState: true, country: true, ownerId: true, podId: true } }, campaign: { select: { id: true, name: true, status: true } }, sequence: { select: { name: true } } } },
  fo: { select: { id: true, name: true } },
} satisfies Prisma.TaskInclude;
export type SandboxTaskRow = Prisma.TaskGetPayload<{ include: typeof sandboxTaskInclude }>;

export const sandboxNextInclude = {
  sandboxContact: { select: { id: true, firstName: true, lastName: true, companyName: true, jobTitle: true, email: true, phone: true, linkedinUrl: true, status: true, state: true, companyState: true, country: true, ownerId: true, podId: true } },
  fo: { select: { id: true, name: true } },
} satisfies Prisma.NextActionInclude;
export type SandboxNextRow = Prisma.NextActionGetPayload<{ include: typeof sandboxNextInclude }>;

export type WorkTab = 'today' | 'overdue' | 'upcoming';

/** Open sandbox steps and next actions for whoever the filter names (one FO, or everyone). */
export async function sandboxWork(filters: { foUserId: string | null; podId: string | null }, today: string): Promise<{ tasks: SandboxTaskRow[]; next: SandboxNextRow[]; counts: Record<WorkTab, number> }> {
  const who: Prisma.TaskWhereInput = { ...(filters.foUserId ? { foUserId: filters.foUserId } : {}), ...(filters.podId ? { enrollment: { ...SANDBOX_SUBJECT, podId: filters.podId } } : {}) };
  const [tasks, next] = await Promise.all([
    prisma.task.findMany({ where: { AND: [SANDBOX_TASK, WORKABLE, who, { state: 'PENDING' }] }, include: sandboxTaskInclude, orderBy: [{ dueDate: 'asc' }, { stepIndex: 'asc' }, { actionIndex: 'asc' }], take: 500 }),
    prisma.nextAction.findMany({ where: { ...SANDBOX_SUBJECT, state: 'OPEN', ...(filters.foUserId ? { foUserId: filters.foUserId } : {}), ...(filters.podId ? { sandboxContact: { podId: filters.podId } } : {}) }, include: sandboxNextInclude, orderBy: [{ dueDate: 'asc' }], take: 500 }),
  ]);
  const counts: Record<WorkTab, number> = { today: 0, overdue: 0, upcoming: 0 };
  const tab = (due: string): WorkTab => (due < today ? 'overdue' : due === today ? 'today' : 'upcoming');
  for (const t of tasks) counts[tab(t.snoozedTo ?? t.dueDate)]++;
  for (const n of next) counts[tab(n.dueDate)]++;
  return { tasks, next, counts };
}

/** The Sandbox entry's badge: the signed-in user's sandbox steps and next actions due today or earlier. */
export async function sandboxDueCount(userId: string, today: string): Promise<number> {
  const [tasks, next] = await Promise.all([
    prisma.task.findMany({ where: { AND: [SANDBOX_TASK, WORKABLE, { foUserId: userId, state: 'PENDING' }] }, select: { enrollmentId: true, stepId: true, dueDate: true, snoozedTo: true } }),
    prisma.nextAction.count({ where: { ...SANDBOX_SUBJECT, foUserId: userId, state: 'OPEN', dueDate: { lte: today } } }),
  ]);
  const steps = new Set(tasks.filter((t) => (t.snoozedTo ?? t.dueDate) <= today).map((t) => `${t.enrollmentId}:${t.stepId}`));
  return steps.size + next;
}
