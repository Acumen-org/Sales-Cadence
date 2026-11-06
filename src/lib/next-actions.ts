import type { ActionType, NextActionKind, NextActionRepeat } from '@prisma/client';
import { prisma } from './db';
import { logAudit, SYSTEM_ACTOR, type AuditActor } from './audit';
import { addDays, formatLocalDate, isLocalDate, safeTimezone, toLocalDate, todayIn, type LocalDate } from './dates';
import { workspaceTimezone } from './workspace';
import { nextWorkingDay } from './engine/clock';
import { getSettings } from './settings';
import { getTwentyClient } from './twenty';
import { logOwnPersonWrite } from './twenty/own-writes';
import { afterResponse } from './engine/sync-out';
import { CRM_SUBJECT } from './subject';

/** The audit row for a next action: on its person, or on its sandbox contact while it has none. */
const auditSubject = (na: { personId: string | null; sandboxContactId: string | null }) => (na.personId ? { entityType: 'person' as const, entityId: na.personId } : { entityType: 'sandbox_contact' as const, entityId: na.sandboxContactId ?? '' });

/**
 * A person's next action outside any campaign (owner, 25 September 2026): "add people who may or
 * may not be in a campaign for next action, which can be recurring (weekly, biweekly, monthly,
 * etc) or not ... tied into the next action due date in CRM". It has nothing to do with campaigns.
 *
 * - It is worked in Tasks, by the FO it is assigned to, on its due date.
 * - Done closes a one-off; a repeating one moves on to its next date.
 * - Twenty holds one Next Action and one Next Action Due Date per person, so a person has at most
 *   one open next action, and those two fields always carry it: Cadence writes them whenever it
 *   changes, and clears them when it is closed. When someone changes the date in Twenty, Cadence
 *   follows it; when they clear it there, the next action closes.
 */

export const REPEAT_LABELS: Record<NextActionRepeat, string> = {
  NONE: 'Does not repeat',
  WEEKLY: 'Every week',
  BIWEEKLY: 'Every 2 weeks',
  MONTHLY: 'Every month',
  QUARTERLY: 'Every 3 months',
};

export const NEXT_ACTION_CHANNELS: ActionType[] = ['EMAIL', 'CALL', 'LINKEDIN_MESSAGE', 'LINKEDIN_CONNECT'];

/** The same day of the month `months` later, or the month's last day when it has fewer days. */
function addMonths(date: LocalDate, months: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

function step(date: LocalDate, repeat: NextActionRepeat): LocalDate {
  switch (repeat) {
    case 'WEEKLY': return addDays(date, 7);
    case 'BIWEEKLY': return addDays(date, 14);
    case 'MONTHLY': return addMonths(date, 1);
    case 'QUARTERLY': return addMonths(date, 3);
    default: return date;
  }
}

/**
 * The next date of a repeating next action after it was done: its rhythm from the date it was
 * due, never today or earlier, so one done late keeps its day of the week (or month), and on a
 * working day.
 */
export function nextOccurrence(due: LocalDate, repeat: NextActionRepeat, today: LocalDate, workingDays: number[]): LocalDate | null {
  if (repeat === 'NONE') return null;
  let next = step(due, repeat);
  for (let i = 0; next <= today && i < 520; i++) next = step(next, repeat);
  return nextWorkingDay(next, workingDays);
}

export type NextActionInput = { label: string; action: ActionType; dueDate: LocalDate; repeat: NextActionRepeat; /** Null: each person's own FO. */ foUserId: string | null; /** A meeting, with its time when known (B183). */ kind?: NextActionKind; meetingAt?: Date | null };

export function validateNextAction(raw: { label?: unknown; action?: unknown; dueDate?: unknown; repeat?: unknown; foUserId?: unknown }, today: LocalDate): { ok: true; value: NextActionInput } | { ok: false; error: string } {
  const label = String(raw.label ?? '').trim().replace(/\s+/g, ' ');
  if (!label) return { ok: false, error: 'Say what the task is.' };
  if (label.length > 200) return { ok: false, error: 'Keep the task under 200 characters.' };
  const action = String(raw.action ?? 'EMAIL') as ActionType;
  if (!NEXT_ACTION_CHANNELS.includes(action)) return { ok: false, error: 'Pick how it is done.' };
  const dueDate = String(raw.dueDate ?? '');
  if (!isLocalDate(dueDate)) return { ok: false, error: 'Pick the day it is due.' };
  if (dueDate < today) return { ok: false, error: 'Pick today or a later day.' };
  const repeat = String(raw.repeat ?? 'NONE') as NextActionRepeat;
  if (!(repeat in REPEAT_LABELS)) return { ok: false, error: 'Pick how often it repeats.' };
  const foUserId = raw.foUserId ? String(raw.foUserId) : null;
  return { ok: true, value: { label, action, dueDate, repeat, foUserId } };
}

/**
 * Give each person this next action. A person who already has an open one gets it replaced, as
 * Twenty's two fields can only hold one. Returns how many were set and who was left out.
 */
export async function setNextActions(personIds: string[], input: NextActionInput, actor: AuditActor & { id?: string | null }, fallbackFoUserId: string): Promise<{ set: string[]; skipped: { personId: string; reason: string }[] }> {
  const people = await prisma.personCache.findMany({ where: { id: { in: [...new Set(personIds)] } }, select: { id: true, deletedAt: true, dnd: true, optedOut: true, ownerMemberId: true } });
  const owners = await prisma.user.findMany({ where: { active: true, twentyMemberId: { in: people.flatMap((p) => (p.ownerMemberId ? [p.ownerMemberId] : [])) } }, select: { id: true, twentyMemberId: true } });
  const ownerOf = new Map(owners.map((u) => [u.twentyMemberId, u.id]));
  const set: string[] = [];
  const skipped: { personId: string; reason: string }[] = [];
  for (const id of personIds) {
    const p = people.find((x) => x.id === id);
    if (!p || p.deletedAt) { skipped.push({ personId: id, reason: 'Not in the CRM any more' }); continue; }
    if (p.dnd) { skipped.push({ personId: id, reason: 'Marked do not contact' }); continue; }
    // B007: an opted-out person gets no new next action either.
    if (p.optedOut) { skipped.push({ personId: id, reason: 'Asked not to be contacted' }); continue; }
    const foUserId = input.foUserId ?? (p.ownerMemberId ? ownerOf.get(p.ownerMemberId) : undefined) ?? fallbackFoUserId;
    const data = { label: input.label, action: input.action, dueDate: input.dueDate, repeat: input.repeat, foUserId, kind: input.kind ?? 'ACTION', meetingAt: input.meetingAt ?? null, crmPending: true, crmError: null };
    const row = await prisma.$transaction(async (tx) => {
      const open = await tx.nextAction.findFirst({ where: { personId: id, state: 'OPEN' }, select: { id: true } });
      const saved = open
        ? await tx.nextAction.update({ where: { id: open.id }, data })
        : await tx.nextAction.create({ data: { ...data, personId: id, createdById: actor.id ?? null, audience: 'CRM' } });
      // What Twenty will hold once the write lands, shown at once rather than after it.
      await tx.personCache.update({ where: { id }, data: { nextAction: saved.label, nextActionDueDate: saved.dueDate } });
      return saved;
    });
    await logAudit({ entityType: 'person', entityId: id, action: 'next_action_set', actor, details: { label: row.label, dueDate: row.dueDate, repeat: row.repeat, foUserId } });
    set.push(row.id);
  }
  await afterResponse(async () => { for (const id of set) await pushNextAction(id); });
  return { set, skipped };
}

/** Done: a one-off closes; a repeating one moves on to its next date. */
export async function completeNextAction(id: string, actor: AuditActor & { id?: string | null }, now = new Date(), expectedDue: string | null = null): Promise<{ ok: true; next: LocalDate | null } | { ok: false; error: string }> {
  const { rules } = await getSettings();
  const na = await prisma.nextAction.findUnique({ where: { id } });
  if (!na || na.state !== 'OPEN') return { ok: false, error: 'This task is already closed.' };
  // Done on a screen showing an earlier date: that occurrence is already done.
  if (expectedDue && expectedDue !== na.dueDate) return { ok: false, error: `This one is already done. The next is due ${formatLocalDate(na.dueDate, 'long')}.` };
  const today = todayIn((await prisma.user.findUnique({ where: { id: na.foUserId }, select: { timezone: true } }))?.timezone ?? 'America/Chicago', now);
  const next = nextOccurrence(na.dueDate, na.repeat, today, rules.workingDays);
  const claimed = await prisma.nextAction.updateMany({
    where: { id, state: 'OPEN', dueDate: na.dueDate },
    data: next
      ? { dueDate: next, doneCount: { increment: 1 }, lastDoneAt: now, completedById: actor.id ?? null, crmPending: true }
      : { state: 'DONE', doneCount: { increment: 1 }, lastDoneAt: now, closedAt: now, completedById: actor.id ?? null, crmPending: true },
  });
  if (!claimed.count) return { ok: false, error: 'Someone else just changed this task.' };
  if (na.personId) await mirrorToPerson(na.personId, next ? { label: na.label, dueDate: next } : null);
  // A cold contact's next step done is activity, which keeps retention away (N032).
  else if (na.sandboxContactId) await prisma.sandboxContact.updateMany({ where: { id: na.sandboxContactId }, data: { lastActivityAt: now } });
  await logAudit({ ...auditSubject(na), action: 'next_action_done', actor, details: { label: na.label, dueDate: na.dueDate, next } });
  await afterResponse(async () => { await pushNextAction(id); });
  return { ok: true, next };
}

/**
 * An email Cadence saw go to the person closes their open Email next step when it is due that day
 * or earlier: the day of the step's rep, never UTC's, so an email sent at 7 pm in Chicago does not
 * close tomorrow's step (N098). CRM people and cold contacts follow this one rule, whether Outlook
 * tracking or the CRM's mail sync saw the email, and each close is logged with the email behind it.
 * A repeating one moves on, as Done would. Returns the next action closed, if any.
 */
export async function closeEmailNextAction(subject: { personId: string } | { sandboxContactId: string }, at: Date, evidence: string): Promise<string | null> {
  const where = 'personId' in subject ? { personId: subject.personId } : { sandboxContactId: subject.sandboxContactId, personId: null };
  const open = await prisma.nextAction.findMany({ where: { ...where, state: 'OPEN', action: 'EMAIL', kind: 'ACTION' }, include: { fo: { select: { timezone: true } } }, orderBy: { dueDate: 'asc' } });
  for (const na of open) {
    const day = toLocalDate(at, safeTimezone(na.fo?.timezone ?? workspaceTimezone()));
    // An email sent before the step was set is not the one it asks for (a few minutes' grace).
    if (na.dueDate > day || at.getTime() < na.createdAt.getTime() - 30 * 60_000) continue;
    const r = await completeNextAction(na.id, SYSTEM_ACTOR, at, na.dueDate);
    if (!r.ok) continue;
    await logAudit({ ...auditSubject(na), action: 'next_action_auto_closed', actor: SYSTEM_ACTOR, details: { nextActionId: na.id, label: na.label, dueDate: na.dueDate, emailDay: day, evidence, next: r.next } });
    return na.id;
  }
  return null;
}

/** Move it to another day. A repeating one keeps its rhythm from the new day. */
export async function moveNextAction(id: string, dueDate: LocalDate, actor: AuditActor, today: LocalDate): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isLocalDate(dueDate) || dueDate <= today) return { ok: false, error: 'Pick a later day.' };
  const na = await prisma.nextAction.findUnique({ where: { id } });
  if (!na || na.state !== 'OPEN') return { ok: false, error: 'This task is already closed.' };
  await prisma.nextAction.update({ where: { id }, data: { dueDate, crmPending: Boolean(na.personId) } });
  await logAudit({ ...auditSubject(na), action: 'next_action_moved', actor, details: { label: na.label, from: na.dueDate, to: dueDate } });
  await afterResponse(async () => { await pushNextAction(id); });
  return { ok: true };
}

/** Stop it: closed, and Twenty's two fields cleared. */
export async function stopNextAction(id: string, actor: AuditActor, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  const na = await prisma.nextAction.findUnique({ where: { id } });
  if (!na || na.state !== 'OPEN') return { ok: false, error: 'This task is already closed.' };
  await prisma.nextAction.update({ where: { id }, data: { state: 'CANCELLED', closedAt: now, crmPending: Boolean(na.personId) } });
  if (na.personId) await mirrorToPerson(na.personId, null);
  await logAudit({ ...auditSubject(na), action: 'next_action_stopped', actor, details: { label: na.label, dueDate: na.dueDate } });
  await afterResponse(async () => { await pushNextAction(id); });
  return { ok: true };
}

/**
 * What Twenty will hold once the write lands, on the person at once: the open task, or nothing
 * when none is left open. A newer open task for the same person keeps the fields.
 */
async function mirrorToPerson(personId: string, open: { label: string; dueDate: string } | null) {
  if (!open && (await prisma.nextAction.count({ where: { personId, state: 'OPEN' } }))) return;
  await prisma.personCache.updateMany({ where: { id: personId }, data: open ? { nextAction: open.label, nextActionDueDate: open.dueDate } : { nextAction: null, nextActionDueDate: null } });
}

/**
 * Put a next action on the person in Twenty: its label and date while open, nothing once closed.
 * A failure is kept on the row and the worker tries again; it never undoes the change in Cadence.
 */
export async function pushNextAction(id: string): Promise<boolean> {
  const na = await prisma.nextAction.findUnique({ where: { id } });
  if (!na || !na.crmPending) return true;
  // A sandbox contact's next action stays in Cadence until the contact moves to the CRM.
  if (!na.personId) {
    await prisma.nextAction.update({ where: { id }, data: { crmPending: false, crmError: null } });
    return true;
  }
  const personId = na.personId;
  // A newer open next action for the same person owns the fields; a closed one must not clear them.
  if (na.state !== 'OPEN' && (await prisma.nextAction.count({ where: { personId, state: 'OPEN' } }))) {
    await prisma.nextAction.update({ where: { id }, data: { crmPending: false, crmSyncedAt: new Date(), crmError: null } });
    return true;
  }
  const patch = na.state === 'OPEN' ? { nextAction: na.label, nextActionDueDate: na.dueDate } : { nextAction: null, nextActionDueDate: null };
  try {
    const client = await getTwentyClient();
    await client.setPersonNextAction(personId, patch);
    // B033: a moved person's updatedAt after Cadence's own write, so Undo does not mistake it for an edit.
    await logOwnPersonWrite(client, personId, 'setPersonNextAction', { id: personId, ...patch });
    // Only if nothing changed meanwhile: a newer change is still pending and goes on the next pass.
    await prisma.nextAction.updateMany({ where: { id, updatedAt: na.updatedAt }, data: { crmPending: false, crmSyncedAt: new Date(), crmError: null } });
    await prisma.personCache.updateMany({ where: { id: personId }, data: patch });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[next-action] could not update Twenty for ${personId}: ${message}`);
    await prisma.nextAction.updateMany({ where: { id, updatedAt: na.updatedAt }, data: { crmError: message.slice(0, 500) } });
    return false;
  }
}

/**
 * The worker's pass, every minute: send what has not reached Twenty yet, then follow what people
 * changed in Twenty - a new date moves the next action, a cleared date closes it.
 */
export async function syncNextActions(now = new Date()): Promise<{ pushed: number; failed: number; followed: number; closed: number }> {
  const stats = { pushed: 0, failed: 0, followed: 0, closed: 0 };
  const pending = await prisma.nextAction.findMany({ where: { crmPending: true }, orderBy: { updatedAt: 'asc' }, take: 25, select: { id: true } });
  for (const p of pending) { if (await pushNextAction(p.id)) stats.pushed++; else stats.failed++; }

  const open = await prisma.nextAction.findMany({
    where: { state: 'OPEN', crmPending: false, ...CRM_SUBJECT },
    select: { id: true, label: true, dueDate: true, crmSyncedAt: true, personId: true, person: { select: { nextAction: true, nextActionDueDate: true, twentyUpdatedAt: true } } },
  });
  for (const na of open) {
    const crm = na.person;
    if (!crm || !na.personId) continue;
    // Only a change made in Twenty after Cadence last matched it.
    if (!crm.twentyUpdatedAt || (na.crmSyncedAt && crm.twentyUpdatedAt <= na.crmSyncedAt)) continue;
    const date = crm.nextActionDueDate && isLocalDate(crm.nextActionDueDate.slice(0, 10)) ? crm.nextActionDueDate.slice(0, 10) : null;
    const label = crm.nextAction?.trim() || na.label;
    if (date === na.dueDate && label === na.label) { await prisma.nextAction.update({ where: { id: na.id }, data: { crmSyncedAt: crm.twentyUpdatedAt } }); continue; }
    if (!date) {
      await prisma.nextAction.update({ where: { id: na.id }, data: { state: 'CANCELLED', closedAt: now, crmSyncedAt: crm.twentyUpdatedAt } });
      await logAudit({ entityType: 'person', entityId: na.personId, action: 'next_action_stopped', actor: SYSTEM_ACTOR, details: { label: na.label, dueDate: na.dueDate, reason: 'Cleared in the CRM' } });
      stats.closed++;
      continue;
    }
    await prisma.nextAction.update({ where: { id: na.id }, data: { dueDate: date, label, crmSyncedAt: crm.twentyUpdatedAt } });
    await logAudit({ entityType: 'person', entityId: na.personId, action: 'next_action_moved', actor: SYSTEM_ACTOR, details: { label, from: na.dueDate, to: date, reason: 'Changed in the CRM' } });
    stats.followed++;
  }
  return stats;
}

/**
 * Who this reader can give a next action to: an admin every FO, a pod leader the FOs of their
 * pods. A junior FO's are their own (no choice), and Biz Ops sets none.
 */
export async function nextActionAccess(user: { id: string; role: string; podIds: string[] }): Promise<{ canSet: boolean; canAssign: boolean; fos: { id: string; name: string }[] }> {
  if (user.role === 'BIZ_OPS') return { canSet: false, canAssign: false, fos: [] };
  if (user.role === 'JUNIOR_FO') return { canSet: true, canAssign: false, fos: [] };
  const leads = user.role !== 'ADMIN';
  if (leads && !user.podIds.length && !['SENIOR_FO', 'SALES_LEADER', 'POD_MANAGER'].includes(user.role)) return { canSet: true, canAssign: false, fos: [] };
  const fos = await prisma.user.findMany({
    where: { active: true, role: { in: ['JUNIOR_FO', 'SENIOR_FO', 'SALES_LEADER', 'POD_MANAGER'] }, ...(leads ? { pods: { some: { podId: { in: user.podIds } } } } : {}) },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  return { canSet: true, canAssign: true, fos };
}
