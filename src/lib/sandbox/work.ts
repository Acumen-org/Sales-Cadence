import type { ActionType, NextActionKind, NextActionRepeat, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { coldRef, SANDBOX_TASK, workWhere } from '../subject';
import { dueCounts, WORKABLE } from '../tasks-query';
import { isUniqueViolation } from '../engine/tasks';
import { refuse, RefusedError, withSubjectLock, type GuardActor, type Refusal } from '../outreach/guard';
import { channelOfAction, contactability } from '../outreach/contactability';

/**
 * Sandbox > Work: the cold section's own steps and next actions. A cold contact's next action stays
 * in Cadence until the contact moves. Work lists only active contacts (B009).
 */

/** A meeting is its own kind of next step, with its time when known (B183). */
export type ColdNextStepInput = { label: string; action: ActionType; dueDate: string; repeat?: NextActionRepeat; foUserId: string; kind?: NextActionKind; meetingAt?: Date | null };
export type ColdNextStepOptions = {
  /** The signed-in user the guard judges; null is Cadence itself. */
  guard?: GuardActor | null;
  /** By hand, or the post-call form's next step (whose own pending form never blocks it). */
  act?: 'next_step' | 'form_next_step';
  /** The rep, for the pending-form block. */
  user?: { id: string; timezone: string } | null;
};

/**
 * Set a cold contact's one open next step, under its lock, only if the contact may be reached that
 * way (PLAN 8.2): active and not being moved (B009), not suppressed or Do not contact, not "Also in
 * CRM" (B053), with an email for an Email step and a LinkedIn profile for a LinkedIn one (N077).
 */
export async function setColdNextStep(contactId: string, input: ColdNextStepInput, actor: AuditActor & { id?: string | null }, opts: ColdNextStepOptions = {}): Promise<{ ok: true; id: string } | Refusal> {
  const act = opts.act ?? 'next_step';
  const data = { label: input.label, action: input.action, dueDate: input.dueDate, repeat: input.repeat ?? 'NONE', foUserId: input.foUserId, kind: input.kind ?? 'ACTION', meetingAt: input.meetingAt ?? null, crmPending: false, crmError: null };
  const attempt = () => withSubjectLock(coldRef(contactId), opts.guard ?? null, act === 'form_next_step' ? 'form_next_step' : 'next_action', async (tx) => {
    const row = (await tx.sandboxContact.findUnique({ where: { id: contactId } }))!;
    const check = await contactability({ kind: 'cold', row }, { act, channel: channelOfAction(input.action), user: opts.user ?? null, tx });
    if (!check.ok && check.effect === 'block') throw new RefusedError(refuse(check.code, check.reason, check.fix));
    const open = await tx.nextAction.findFirst({ where: { sandboxContactId: contactId, personId: null, state: 'OPEN' }, select: { id: true } });
    // One open next step per contact is a database rule (NextAction_one_open_per_sandbox_contact, B005).
    const saved = open ? await tx.nextAction.update({ where: { id: open.id }, data }) : await tx.nextAction.create({ data: { ...data, sandboxContactId: contactId, createdById: actor.id ?? null, audience: 'SANDBOX' } });
    // Setting a next step is activity (N032).
    await tx.sandboxContact.update({ where: { id: contactId }, data: { lastActivityAt: new Date() } });
    await logAudit({ entityType: 'sandbox_contact', entityId: contactId, action: 'next_action_set', actor, details: { label: saved.label, dueDate: saved.dueDate } }, tx);
    return saved.id;
  }, { audit: actor });
  const r = await attempt().catch((err) => { if (isUniqueViolation(err)) return attempt(); throw err; });
  return r.ok ? { ok: true, id: r.value } : r;
}

/** The same, for callers that only expect it to succeed: a refusal is thrown with its reason. */
export async function setSandboxNextAction(contactId: string, input: ColdNextStepInput, actor: AuditActor & { id?: string | null }, opts: ColdNextStepOptions = {}): Promise<string> {
  const r = await setColdNextStep(contactId, input, actor, opts);
  if (!r.ok) throw new Error(r.reason);
  return r.id;
}

const liveContact = { status: 'ACTIVE' } satisfies Prisma.SandboxContactWhereInput;

export const sandboxTaskInclude = {
  enrollment: { include: { sandboxContact: { select: { id: true, firstName: true, lastName: true, companyName: true, jobTitle: true, email: true, phone: true, linkedinUrl: true, status: true, state: true, companyState: true, country: true, ownerId: true, podId: true, badEmail: true, possibleBounceAt: true } }, campaign: { select: { id: true, name: true, status: true } }, sequence: { select: { name: true } } } },
  fo: { select: { id: true, name: true } },
} satisfies Prisma.TaskInclude;
export type SandboxTaskRow = Prisma.TaskGetPayload<{ include: typeof sandboxTaskInclude }>;

export const sandboxNextInclude = {
  sandboxContact: { select: { id: true, firstName: true, lastName: true, companyName: true, jobTitle: true, email: true, phone: true, linkedinUrl: true, status: true, state: true, companyState: true, country: true, ownerId: true, podId: true, badEmail: true, possibleBounceAt: true } },
  fo: { select: { id: true, name: true } },
} satisfies Prisma.NextActionInclude;
export type SandboxNextRow = Prisma.NextActionGetPayload<{ include: typeof sandboxNextInclude }>;

export type WorkTab = 'today' | 'overdue' | 'upcoming';

/** Open cold steps and next actions of active contacts for whoever the filter names (one FO, or everyone). */
export async function sandboxWork(filters: { foUserId: string | null; podId: string | null }, today: string): Promise<{ tasks: SandboxTaskRow[]; next: SandboxNextRow[]; counts: Record<WorkTab, number> }> {
  const who: Prisma.TaskWhereInput = { ...(filters.foUserId ? { foUserId: filters.foUserId } : {}), ...(filters.podId ? { enrollment: { podId: filters.podId } } : {}) };
  const [tasks, next] = await Promise.all([
    prisma.task.findMany({ where: { AND: [SANDBOX_TASK, { enrollment: { sandboxContact: liveContact } }, WORKABLE, who, { state: 'PENDING' }] }, include: sandboxTaskInclude, orderBy: [{ dueDate: 'asc' }, { stepIndex: 'asc' }, { actionIndex: 'asc' }], take: 500 }),
    prisma.nextAction.findMany({ where: { AND: [workWhere('cold'), { state: 'OPEN' }, filters.foUserId ? { foUserId: filters.foUserId } : {}, filters.podId ? { sandboxContact: { podId: filters.podId } } : {}] }, include: sandboxNextInclude, orderBy: [{ dueDate: 'asc' }], take: 500 }),
  ]);
  const counts: Record<WorkTab, number> = { today: 0, overdue: 0, upcoming: 0 };
  const tab = (due: string): WorkTab => (due < today ? 'overdue' : due === today ? 'today' : 'upcoming');
  for (const t of tasks) counts[tab(t.snoozedTo ?? t.dueDate)]++;
  for (const n of next) counts[tab(n.dueDate)]++;
  return { tasks, next, counts };
}

/** The Cold outreach entry's badge: the user's cold steps and next actions due today or earlier, on active contacts only, counted as its Tasks view counts them (B117). */
export async function sandboxDueCount(userId: string, today: string): Promise<number> {
  const due = await dueCounts(userId, 'cold', today);
  return due.today + due.overdue;
}
