import { Prisma, type LinkedInFollowUp, type LinkedInFollowUpKind, type LinkedInLink } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, SYSTEM_ACTOR, type AuditActor } from '../audit';
import { addDays, maxLocalDate, safeTimezone, toLocalDate, todayIn, type LocalDate } from '../dates';
import { followingWorkingDay, nextWorkingDay } from '../engine/clock';
import { audienceOf } from '../outreach/audience';
import { assignContact } from '../sandbox/contacts';
import { getSettings, type LinkedInSettings } from '../settings';
import { workspaceTimezone } from '../workspace';

/**
 * LinkedIn tasks Cadence makes from what the Console saw, outside any campaign (owner, 12 Nov 2026):
 *
 * - MESSAGE: they accepted our request ("we should msg them within 2 days"), or they wrote to us.
 * - WITHDRAW: our request has waited 14 days with no answer.
 * - RESEND: the request was withdrawn; LinkedIn lets it go again after its 3-week cool-off.
 *
 * Each goes to the contact's owner, never to whoever owns the LinkedIn account: several teammates work
 * one account, often a sales leader's. A cold contact nobody owns gets no owner until they respond, so
 * their MESSAGE waits in Cold outreach > Needs owner, and its clock starts when someone takes it.
 */

export type LinkedInSubject = { personId: string } | { sandboxContactId: string };

export const subjectWhere = (s: LinkedInSubject) => ('personId' in s ? { personId: s.personId } : { sandboxContactId: s.sandboxContactId, personId: null });

export const FOLLOW_UP_LABELS: Record<LinkedInFollowUpKind, string> = {
  MESSAGE: 'Message on LinkedIn',
  WITHDRAW: 'Withdraw the connection request',
  RESEND: 'Send the connection request again',
  EMAIL_REPLY: 'Reply to their email',
};

/** A reply, by email or on LinkedIn, is answered within this many working days (owner, 13 Nov 2026: "The deadline is 2 days"; LinkedIn too). */
export const EMAIL_REPLY_DAYS = 2;
/** A reply older than this when Cadence first sees it (a catch-up, a backfill) opens no task. */
const EMAIL_REPLY_FRESH_MS = 7 * 86_400_000;

/** What the task asks, with why. */
export function followUpLabel(f: Pick<LinkedInFollowUp, 'kind' | 'trigger'>): string {
  if (f.kind === 'MESSAGE') return f.trigger === 'replied' ? 'Reply on LinkedIn' : 'Message on LinkedIn: they accepted';
  if (f.kind === 'EMAIL_REPLY') return 'Reply to their email';
  return FOLLOW_UP_LABELS[f.kind];
}

/** `n` working days after `date` (0: `date` itself, or the next working day). */
export function workingDaysAfter(date: LocalDate, n: number, workingDays: number[]): LocalDate {
  let d = nextWorkingDay(date, workingDays);
  for (let i = 0; i < n; i++) d = followingWorkingDay(d, workingDays);
  return d;
}

/**
 * The day it is due, in the FO's own calendar. A MESSAGE after an acceptance is due 2 working days after
 * the acceptance, or after someone took the contact on if that was later; a reply is answered within 2
 * working days, as an email reply is. A withdrawal is due at once (the 14 days already passed). A resend is due when LinkedIn's
 * cool-off ends.
 */
export function dueDateFor(f: { kind: LinkedInFollowUpKind; trigger: string; triggeredAt: Date }, assignedAt: Date | null, timezone: string, linkedin: LinkedInSettings, workingDays: number[]): LocalDate {
  const tz = safeTimezone(timezone);
  const from = maxLocalDate(toLocalDate(f.triggeredAt, tz), assignedAt ? toLocalDate(assignedAt, tz) : toLocalDate(f.triggeredAt, tz));
  if (f.kind === 'MESSAGE') return workingDaysAfter(from, f.trigger === 'accepted' ? linkedin.messageAfterAcceptDays : EMAIL_REPLY_DAYS, workingDays);
  if (f.kind === 'EMAIL_REPLY') return workingDaysAfter(from, EMAIL_REPLY_DAYS, workingDays);
  if (f.kind === 'RESEND') return nextWorkingDay(maxLocalDate(addDays(toLocalDate(f.triggeredAt, tz), linkedin.resendAfterDays), from), workingDays);
  return nextWorkingDay(from, workingDays);
}

/** Who a subject belongs to in Cadence: the CRM owner (Twenty's assignedTo) or the cold contact's owner. */
export async function ownerOf(subject: LinkedInSubject): Promise<string | null> {
  if ('personId' in subject) {
    const p = await prisma.personCache.findUnique({ where: { id: subject.personId }, select: { ownerMemberId: true } });
    if (!p?.ownerMemberId) return null;
    const u = await prisma.user.findFirst({ where: { twentyMemberId: p.ownerMemberId, active: true }, select: { id: true } });
    return u?.id ?? null;
  }
  const c = await prisma.sandboxContact.findUnique({ where: { id: subject.sandboxContactId }, select: { ownerId: true, owner: { select: { active: true } } } });
  return c?.ownerId && c.owner?.active ? c.ownerId : null;
}

/**
 * Who works it. The owner always. Without one: a cold contact's message or reply waits in Cold outreach >
 * Needs an owner (the owner's rule: no owner until they respond, and then someone must own them); a CRM
 * person's goes to the rep of their latest campaign, else the teammate who sent the request, else a leader
 * of their pod, so it lands in the normal Tasks list (owner, 13 Nov 2026); a withdrawal or resend goes to
 * the sender.
 */
async function foFor(kind: LinkedInFollowUpKind, subject: LinkedInSubject, link: Pick<LinkedInLink, 'invitedByUserId'> | null): Promise<string | null> {
  const owner = await ownerOf(subject);
  if (owner) return owner;
  const answer = kind === 'MESSAGE' || kind === 'EMAIL_REPLY';
  if (answer && 'sandboxContactId' in subject) return null;
  if ('personId' in subject) {
    const e = await prisma.enrollment.findFirst({ where: { personId: subject.personId, fo: { active: true } }, orderBy: { createdAt: 'desc' }, select: { foUserId: true } });
    if (e) return e.foUserId;
  }
  if (link?.invitedByUserId) {
    const sender = await prisma.user.findFirst({ where: { id: link.invitedByUserId, active: true }, select: { id: true } });
    if (sender) return sender.id;
  }
  if ('personId' in subject) {
    // Nobody else: a leader of the person's pod, so it is still in someone's Tasks.
    const p = await prisma.personCache.findUnique({ where: { id: subject.personId }, select: { podOwner: true } });
    const leader = p?.podOwner ? await prisma.user.findFirst({ where: { active: true, role: { in: ['SALES_LEADER', 'POD_MANAGER'] }, pods: { some: { pod: { podOwnerValue: p.podOwner } } } }, orderBy: { createdAt: 'asc' }, select: { id: true } }) : null;
    return leader?.id ?? null;
  }
  return null;
}

/** Someone who must not be contacted gets no LinkedIn task. */
export async function mayContact(subject: LinkedInSubject): Promise<boolean> {
  if ('personId' in subject) {
    const p = await prisma.personCache.findUnique({ where: { id: subject.personId }, select: { dnd: true, optedOut: true, deletedAt: true } });
    return Boolean(p && !p.dnd && !p.optedOut && !p.deletedAt);
  }
  const c = await prisma.sandboxContact.findUnique({ where: { id: subject.sandboxContactId }, select: { status: true } });
  return c?.status === 'ACTIVE';
}

async function timezoneOf(userId: string | null): Promise<string> {
  if (!userId) return workspaceTimezone();
  return (await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } }))?.timezone ?? workspaceTimezone();
}

/**
 * Open a follow-up, unless one of its kind is already open for this account and person (one open per
 * link and kind, held by a partial unique index). Returns its id, or null when nothing was opened.
 */
export async function openFollowUp(input: { kind: LinkedInFollowUpKind; trigger: string; triggeredAt: Date; link: LinkedInLink; subject: LinkedInSubject }, now = new Date()): Promise<string | null> {
  const { kind, trigger, triggeredAt, link, subject } = input;
  if (!(await mayContact(subject))) return null;
  if (await prisma.linkedInFollowUp.count({ where: { linkId: link.id, kind, state: 'OPEN' } })) return null;
  const { linkedin, rules } = await getSettings();
  const foUserId = await foFor(kind, subject, link);
  // Owned from the start: counted from what happened, however late the Console reported it.
  const dueDate = foUserId ? dueDateFor({ kind, trigger, triggeredAt }, null, await timezoneOf(foUserId), linkedin, rules.workingDays) : null;
  const status = 'sandboxContactId' in subject ? (await prisma.sandboxContact.findUnique({ where: { id: subject.sandboxContactId }, select: { status: true } }))?.status : null;
  try {
    const row = await prisma.linkedInFollowUp.create({
      data: {
        kind, trigger, triggeredAt, linkId: link.id, accountId: link.accountId, foUserId, dueDate, assignedAt: foUserId ? now : null,
        ...('personId' in subject ? { personId: subject.personId, sandboxContactId: link.sandboxContactId } : { sandboxContactId: subject.sandboxContactId }),
        audience: audienceOf('personId' in subject ? { personId: subject.personId } : { sandboxContactId: subject.sandboxContactId }, status),
      },
    });
    await logAudit({ ...auditOf(subject), action: 'linkedin_follow_up_opened', actor: SYSTEM_ACTOR, details: { followUpId: row.id, kind, trigger, accountId: link.accountId, foUserId, dueDate } });
    return row.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
}

/**
 * They answered an email, in a campaign or not (owner, 13 Nov 2026): "Reply to their email", due 2 working
 * days later, for a CRM person or a live cold contact. An auto-reply is not an answer and never gets here.
 * One task per reply (`sourceId`, the reply's touch); none for a reply already answered, or one first seen
 * long after it came (a catch-up). Returns its id, or null.
 */
export async function openEmailReplyTask(subject: LinkedInSubject, at: Date, sourceId: string, now = new Date()): Promise<string | null> {
  if (now.getTime() - at.getTime() > EMAIL_REPLY_FRESH_MS) return null;
  if (!(await mayContact(subject))) return null;
  if (await prisma.linkedInFollowUp.count({ where: { sourceId } })) return null;
  // Answered already (we wrote after it), or a task for an earlier reply is still open: that one stands.
  if (await prisma.touch.count({ where: { ...subjectWhere(subject), channel: 'EMAIL', direction: 'OUTBOUND', occurredAt: { gt: at } } })) return null;
  if (await prisma.linkedInFollowUp.count({ where: { ...subjectWhere(subject), kind: 'EMAIL_REPLY', state: 'OPEN' } })) return null;
  const { linkedin, rules } = await getSettings();
  const foUserId = await foFor('EMAIL_REPLY', subject, null);
  const dueDate = foUserId ? dueDateFor({ kind: 'EMAIL_REPLY', trigger: 'email_reply', triggeredAt: at }, null, await timezoneOf(foUserId), linkedin, rules.workingDays) : null;
  const status = 'sandboxContactId' in subject ? (await prisma.sandboxContact.findUnique({ where: { id: subject.sandboxContactId }, select: { status: true } }))?.status : null;
  try {
    const row = await prisma.linkedInFollowUp.create({
      data: {
        kind: 'EMAIL_REPLY', trigger: 'email_reply', triggeredAt: at, sourceId, foUserId, dueDate, assignedAt: foUserId ? now : null,
        ...('personId' in subject ? { personId: subject.personId } : { sandboxContactId: subject.sandboxContactId }),
        audience: audienceOf('personId' in subject ? { personId: subject.personId } : { sandboxContactId: subject.sandboxContactId }, status),
      },
    });
    await logAudit({ ...auditOf(subject), action: 'linkedin_follow_up_opened', actor: SYSTEM_ACTOR, details: { followUpId: row.id, kind: 'EMAIL_REPLY', foUserId, dueDate } });
    return row.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
}

/** An email seen going to them closes their open "Reply to their email". Returns how many closed. */
export function closeEmailReplyTasks(subject: LinkedInSubject, at: Date, evidence: string): Promise<number> {
  return closeFollowUps({ ...subjectWhere(subject), kind: 'EMAIL_REPLY', triggeredAt: { lte: at } }, { state: 'DONE', at, evidenceId: evidence });
}

export const auditOf = (s: LinkedInSubject) => ('personId' in s ? { entityType: 'person' as const, entityId: s.personId } : { entityType: 'sandbox_contact' as const, entityId: s.sandboxContactId });
const auditOfRow = (f: Pick<LinkedInFollowUp, 'personId' | 'sandboxContactId'>) => auditOf(f.personId ? { personId: f.personId } : { sandboxContactId: f.sandboxContactId ?? '' });

/**
 * Close the open follow-ups that match: done when the Console saw the thing it asked for, cancelled when it
 * is no longer needed (they accepted while a withdrawal was waiting). Returns how many closed.
 */
export async function closeFollowUps(where: Prisma.LinkedInFollowUpWhereInput, close: { state: 'DONE' | 'CANCELLED'; at: Date; evidenceId?: string | null; reason?: string | null; actor?: AuditActor }): Promise<number> {
  const open = await prisma.linkedInFollowUp.findMany({ where: { ...where, state: 'OPEN' } });
  let n = 0;
  for (const f of open) {
    const done = await prisma.linkedInFollowUp.updateMany({
      where: { id: f.id, state: 'OPEN' },
      data: { state: close.state, completedAt: close.at, completionSource: close.state === 'DONE' ? (close.actor?.type === 'USER' ? 'MANUAL' : 'OBSERVED_MESSAGE') : null, completedById: close.actor?.type === 'USER' ? close.actor.id ?? null : null, evidenceId: close.evidenceId ?? null, closeReason: close.reason ?? null },
    });
    if (!done.count) continue;
    n++;
    await logAudit({ ...auditOfRow(f), action: close.state === 'DONE' ? 'linkedin_follow_up_done' : 'linkedin_follow_up_cancelled', actor: close.actor ?? SYSTEM_ACTOR, details: { followUpId: f.id, kind: f.kind, evidenceId: close.evidenceId ?? null, reason: close.reason ?? null } });
  }
  return n;
}

/** Done by hand: the teammate did it and the Console has not shown it (a phone, or not yet). */
export async function completeFollowUp(id: string, actor: AuditActor, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  const n = await closeFollowUps({ id }, { state: 'DONE', at: now, actor });
  return n ? { ok: true } : { ok: false, error: 'This task is already closed.' };
}

/** Not needed (they asked us not to, it was done some other way). */
export async function dismissFollowUp(id: string, reason: string, actor: AuditActor, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  const n = await closeFollowUps({ id }, { state: 'CANCELLED', at: now, actor, reason: reason.trim() || 'Not needed' });
  return n ? { ok: true } : { ok: false, error: 'This task is already closed.' };
}

/** Move it to another day. */
export async function moveFollowUp(id: string, dueDate: LocalDate, actor: AuditActor, today: LocalDate): Promise<{ ok: true } | { ok: false; error: string }> {
  if (dueDate < today) return { ok: false, error: 'Pick today or a later day.' };
  const f = await prisma.linkedInFollowUp.findUnique({ where: { id } });
  if (!f || f.state !== 'OPEN') return { ok: false, error: 'This task is already closed.' };
  if (!f.foUserId) return { ok: false, error: 'Give it an owner first.' };
  await prisma.linkedInFollowUp.update({ where: { id }, data: { dueDate } });
  await logAudit({ ...auditOfRow(f), action: 'linkedin_follow_up_moved', actor, details: { followUpId: id, from: f.dueDate, to: dueDate } });
  return { ok: true };
}

/**
 * Give it (and the person's other open LinkedIn tasks nobody works) to a teammate. A cold contact with no
 * owner gets this teammate as its owner, through the usual assignment, so its campaigns and next step follow.
 * The clock starts now: due 2 working days from today for a MESSAGE after an acceptance.
 */
export async function assignFollowUp(id: string, toUserId: string, actor: AuditActor, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  const f = await prisma.linkedInFollowUp.findUnique({ where: { id }, include: { sandboxContact: { select: { id: true, ownerId: true, status: true } } } });
  if (!f || f.state !== 'OPEN') return { ok: false, error: 'This task is already closed.' };
  const to = await prisma.user.findFirst({ where: { id: toUserId, active: true }, select: { id: true, timezone: true, pods: { select: { podId: true } } } });
  if (!to) return { ok: false, error: 'Pick someone on the team.' };
  if (!f.personId && f.sandboxContact && f.sandboxContact.status === 'ACTIVE' && !f.sandboxContact.ownerId) {
    const r = await assignContact(f.sandboxContact.id, to.id, actor, to.pods[0]?.podId ?? null);
    if (!r.ok) return { ok: false, error: r.error };
  }
  const { linkedin, rules } = await getSettings();
  const subject = f.personId ? { personId: f.personId } : { sandboxContactId: f.sandboxContactId ?? '' };
  const unowned = await prisma.linkedInFollowUp.findMany({ where: { ...subjectWhere(subject), state: 'OPEN', OR: [{ id }, { foUserId: null }] } });
  for (const u of unowned) {
    const dueDate = dueDateFor(u, now, to.timezone, linkedin, rules.workingDays);
    await prisma.linkedInFollowUp.update({ where: { id: u.id }, data: { foUserId: to.id, assignedAt: now, dueDate } });
    await logAudit({ ...auditOfRow(u), action: 'linkedin_follow_up_assigned', actor, details: { followUpId: u.id, kind: u.kind, from: u.foUserId, to: to.id, dueDate } });
  }
  return { ok: true };
}

/**
 * Keep each open follow-up with the person's owner: one waiting for an owner gets the owner someone gave the
 * contact elsewhere (a claim, an assignment, the CRM), and one whose contact changed hands follows the new
 * owner. Returns how many changed.
 */
export async function followOwners(now = new Date()): Promise<number> {
  const open = await prisma.linkedInFollowUp.findMany({ where: { state: 'OPEN' }, select: { id: true, kind: true, trigger: true, triggeredAt: true, foUserId: true, dueDate: true, personId: true, sandboxContactId: true } });
  if (!open.length) return 0;
  const { linkedin, rules } = await getSettings();
  let changed = 0;
  for (const f of open) {
    const subject: LinkedInSubject = f.personId ? { personId: f.personId } : { sandboxContactId: f.sandboxContactId ?? '' };
    const owner = await ownerOf(subject);
    if (!owner || owner === f.foUserId) continue;
    const tz = await timezoneOf(owner);
    // The clock starts when someone takes it; a task that already had someone keeps its day.
    const dueDate = f.dueDate ?? dueDateFor(f, now, tz, linkedin, rules.workingDays);
    await prisma.linkedInFollowUp.update({ where: { id: f.id }, data: { foUserId: owner, dueDate, ...(f.foUserId ? {} : { assignedAt: now }) } });
    await logAudit({ ...auditOf(subject), action: 'linkedin_follow_up_assigned', actor: SYSTEM_ACTOR, details: { followUpId: f.id, kind: f.kind, from: f.foUserId, to: owner, dueDate, reason: 'owner' } });
    changed++;
  }
  return changed;
}

/** Someone who must not be contacted any more: their open LinkedIn tasks close. */
export async function closeForDoNotContact(now = new Date()): Promise<number> {
  const open = await prisma.linkedInFollowUp.findMany({ where: { state: 'OPEN' }, select: { id: true, personId: true, sandboxContactId: true } });
  let n = 0;
  for (const f of open) {
    const subject: LinkedInSubject = f.personId ? { personId: f.personId } : { sandboxContactId: f.sandboxContactId ?? '' };
    if (await mayContact(subject)) continue;
    n += await closeFollowUps({ id: f.id }, { state: 'CANCELLED', at: now, reason: 'Not to be contacted' });
  }
  return n;
}

/** Today in the FO's calendar, for the Tasks screen. */
export const todayFor = (timezone: string | null | undefined, now = new Date()) => todayIn(safeTimezone(timezone ?? workspaceTimezone()), now);
