import { Prisma, type MeetingApproval } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, SYSTEM_ACTOR, type AuditActor } from '../audit';
import { notify } from '../notifications';
import { formatLocalDate, type LocalDate } from '../dates';
import { afterResponse } from '../engine/sync-out';
import { canAddBackMeeting, canApproveMeeting, decidesMeetings, isAdmin, isBizOps, isSalesLeader, whyNotApproveMeeting, type Actor } from '../auth/rbac';
import { meetingDay, meetingDayInstant } from './day';
import { renumberProspects } from './numbering';
import { pushMeetingToCrm, removeMeetingFromCrm } from './crm';

/*
 * Meetings with no recording link (owner, 20 November 2026). A meeting saved without a recording
 * link (ticked "Not recorded or in person") waits for the Sales Leader of the booked-by FO's pod, or
 * an admin, to approve or decline it. While it waits it counts and is in the CRM like any other.
 *
 *   - Approve: it stays as it is.
 *   - Decline (with a reason): it leaves every list, report and number, and the CRM (review becomes
 *     DISMISSED, as a removed calendar meeting always was). Biz Ops and the booked-by FO are told why.
 *     Nobody can save it again as a new meeting; only its Sales Leader, Biz Ops or an admin can add it
 *     back, from Meetings > Approval.
 *
 * Who is asked: the active Sales Leaders of the booked-by FO's pods, never the booker themselves.
 * When a pod has none, every active admin is asked. Whoever adds a meeting they may approve themselves
 * (an admin, or the pod's Sales Leader adding an FO's meeting) approves it by adding it.
 * Meetings saved without a link from 1 November on were sent for approval once, when this came in
 * (owner, 21 Nov 2026: askForMeetingsSince); older ones have no approval and are never asked about.
 *
 * Everyone in the booked-by FO's pods sees its waiting and declined meetings and only reads them
 * (owner, 21 Nov 2026). The FO named in Booked by may add its recording link, which settles it.
 */

type Tx = Prisma.TransactionClient | typeof prisma;
export type Decider = Actor & { name: string };
export type ApprovalResult = { ok: true; message: string } | { ok: false; error: string };

/** A meeting needs an approval when it has no recording link. */
export const lacksRecording = (sourceUrl: string | null | undefined) => !(sourceUrl ?? '').trim();

/** The pods of the FO who booked the meeting. */
export async function bookerPodIds(bookedById: string | null, tx: Tx = prisma): Promise<string[]> {
  if (!bookedById) return [];
  const rows = await tx.userPod.findMany({ where: { userId: bookedById, pod: { archived: false } }, select: { podId: true } });
  return rows.map((r) => r.podId);
}

/** Who is asked: the booker's pods' active Sales Leaders (never the booker), else every active admin. */
export async function meetingApprovers(bookedById: string | null, tx: Tx = prisma): Promise<{ ids: string[]; names: string[]; admins: boolean }> {
  const pods = await bookerPodIds(bookedById, tx);
  const leaders = pods.length ? await tx.user.findMany({ where: { active: true, role: 'SALES_LEADER', pods: { some: { podId: { in: pods } } }, ...(bookedById ? { id: { not: bookedById } } : {}) }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) : [];
  if (leaders.length) return { ids: leaders.map((l) => l.id), names: leaders.map((l) => l.name), admins: false };
  const admins = await tx.user.findMany({ where: { active: true, role: 'ADMIN' }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  return { ids: admins.map((a) => a.id), names: admins.map((a) => a.name), admins: true };
}

/** "Alisa Kolodizner", "Alisa Kolodizner or Andrew Rosenthal", or "an admin". */
export function approverWords(a: { names: string[]; admins: boolean }): string {
  if (a.admins || !a.names.length) return 'an admin';
  if (a.names.length === 1) return a.names[0];
  return `${a.names.slice(0, -1).join(', ')} or ${a.names[a.names.length - 1]}`;
}

/**
 * The meetings this reader decides on: everything for admins; for a Sales Leader, those booked by
 * someone else in their pods. Null: none. The nav badge uses it.
 */
export function approvalScope(a: Actor): Prisma.MeetingWhereInput | null {
  if (isAdmin(a)) return {};
  if (isSalesLeader(a) && a.podIds.length) return { bookedById: { not: a.id }, bookedBy: { pods: { some: { podId: { in: a.podIds }, pod: { archived: false } } } } };
  return null;
}

/**
 * The waiting and declined meetings this reader sees (owner, 21 Nov 2026: everyone in the pod sees
 * them, and only reads): everything for admins and Biz Ops; for anyone else, the meetings they booked
 * and those booked by anyone in their pods.
 */
export function approvalViewScope(a: Actor): Prisma.MeetingWhereInput {
  if (isAdmin(a) || isBizOps(a)) return {};
  return { OR: [{ bookedById: a.id }, ...(a.podIds.length ? [{ bookedBy: { pods: { some: { podId: { in: a.podIds }, pod: { archived: false } } } } }] : [])] };
}

export const WAITING_WHERE: Prisma.MeetingWhereInput = { approval: 'WAITING', review: 'APPROVED' };
export const DECLINED_WHERE: Prisma.MeetingWhereInput = { approval: 'DECLINED', review: 'DISMISSED' };

/** Meetings waiting for this reader's decision, for the badge. Biz Ops and FOs decide none. */
export async function waitingForMe(a: Actor): Promise<number> {
  const scope = decidesMeetings(a) ? approvalScope(a) : null;
  return scope ? prisma.meeting.count({ where: { AND: [WAITING_WHERE, scope] } }) : 0;
}

/** Meetings' tab counts for this reader: what the Waiting and Declined lists hold for them. */
export async function meetingsTabCounts(a: Actor): Promise<{ decides: boolean; waiting: number; declined: number }> {
  const scope = approvalViewScope(a);
  const [waiting, declined] = await Promise.all([
    prisma.meeting.count({ where: { AND: [WAITING_WHERE, scope] } }),
    prisma.meeting.count({ where: { AND: [DECLINED_WHERE, scope] } }),
  ]);
  return { decides: decidesMeetings(a), waiting, declined };
}

const rowSelect = {
  id: true, title: true, occurredAt: true, createdAt: true, companyId: true, companyName: true, notes: true, products: true,
  approval: true, approvalAt: true, declinedAt: true, declineReason: true, bookedById: true,
  bookedBy: { select: { name: true, pods: { select: { podId: true, pod: { select: { name: true, archived: true } } } } } },
  createdBy: { select: { name: true } },
  approvalBy: { select: { name: true } },
  declinedBy: { select: { name: true } },
  attendees: { where: { prospect: true }, select: { personId: true, name: true, email: true, person: { select: { firstName: true, lastName: true } } }, orderBy: { name: 'asc' } },
} satisfies Prisma.MeetingSelect;

export type ApprovalRow = {
  id: string; title: string; day: string; createdAt: Date; companyId: string | null; companyName: string | null; products: string[];
  bookedBy: string | null; pods: string[]; addedBy: string | null; prospects: { id: string | null; name: string }[];
  declinedBy: string | null; declinedAt: Date | null; declineReason: string | null;
  /** Who decides a waiting one: "Sam Leader", "an admin". */
  deciders: string | null;
  mayDecide: boolean; mayAddBack: boolean;
  /** Only the FO named in Booked by may add the recording link here (owner, 21 Nov 2026). */
  mayAddLink: boolean;
};

/** One page of the Waiting or Declined list, oldest meeting first while waiting and newest declined first. */
export async function approvalList(a: Actor, view: 'waiting' | 'declined', take = 1000): Promise<ApprovalRow[]> {
  const rows = await prisma.meeting.findMany({
    where: { AND: [view === 'waiting' ? WAITING_WHERE : DECLINED_WHERE, approvalViewScope(a)] },
    orderBy: view === 'waiting' ? [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] : [{ declinedAt: 'desc' }, { id: 'desc' }],
    take,
    select: rowSelect,
  });
  // Who decides, once per booker.
  const deciders = new Map<string, string>();
  if (view === 'waiting') {
    for (const booker of new Set(rows.map((m) => m.bookedById ?? ''))) deciders.set(booker, approverWords(await meetingApprovers(booker || null)));
  }
  return rows.map((m) => {
    const ref = { bookedById: m.bookedById, bookerPodIds: (m.bookedBy?.pods ?? []).filter((p) => !p.pod.archived).map((p) => p.podId) };
    return {
      id: m.id, title: m.title, day: meetingDay(m.occurredAt), createdAt: m.createdAt, companyId: m.companyId, companyName: m.companyName, products: m.products,
      bookedBy: m.bookedBy?.name ?? null, pods: (m.bookedBy?.pods ?? []).filter((p) => !p.pod.archived).map((p) => p.pod.name), addedBy: m.createdBy?.name ?? null,
      prospects: m.attendees.map((p) => ({ id: p.personId, name: (p.person ? `${p.person.firstName} ${p.person.lastName}`.trim() : '') || p.name || p.email || 'Unnamed prospect' })),
      declinedBy: m.declinedBy?.name ?? null, declinedAt: m.declinedAt, declineReason: m.declineReason,
      deciders: deciders.get(m.bookedById ?? '') ?? null,
      mayDecide: m.approval === 'WAITING' && canApproveMeeting(a, ref), mayAddBack: m.approval === 'DECLINED' && canAddBackMeeting(a, ref),
      mayAddLink: mayAddRecordingLink(a, m),
    };
  });
}

/** The FO named in Booked by may add the recording link to their waiting meeting, and nobody else here. */
export const mayAddRecordingLink = (a: Actor, m: { approval: MeetingApproval | null; bookedById: string | null }) => m.approval === 'WAITING' && !!m.bookedById && m.bookedById === a.id;

/** What the meeting page shows about the approval, and what this reader may do there. */
export async function approvalPanel(a: Actor, m: { id: string; approval: MeetingApproval | null; bookedById: string | null; createdById: string | null }) {
  if (!m.approval) return null;
  const pods = await bookerPodIds(m.bookedById);
  const ref = { bookedById: m.bookedById, bookerPodIds: pods };
  const row = await prisma.meeting.findUnique({ where: { id: m.id }, select: { approvalAt: true, declinedAt: true, declineReason: true, approvalBy: { select: { name: true } }, declinedBy: { select: { name: true } } } });
  const approvers = m.approval === 'WAITING' ? await meetingApprovers(m.bookedById) : null;
  return {
    state: m.approval,
    approvers: approvers ? approverWords(approvers) : null,
    approvedBy: row?.approvalBy?.name ?? null, approvedAt: row?.approvalAt ?? null,
    declinedBy: row?.declinedBy?.name ?? null, declinedAt: row?.declinedAt ?? null, declineReason: row?.declineReason ?? null,
    mayDecide: m.approval === 'WAITING' && canApproveMeeting(a, ref),
    mayAddBack: m.approval === 'DECLINED' && canAddBackMeeting(a, ref),
    mayAddLink: mayAddRecordingLink(a, m),
  };
}

/**
 * Whether this reader may open a declined meeting: whoever may add it back, its booker, whoever added
 * it, and everyone in the booker's pods (they read it, as on Meetings > Declined).
 */
export async function mayOpenDeclined(a: Actor, m: { bookedById: string | null; createdById: string | null }): Promise<boolean> {
  if (m.bookedById === a.id || m.createdById === a.id) return true;
  const pods = await bookerPodIds(m.bookedById);
  return pods.some((p) => a.podIds.includes(p)) || canAddBackMeeting(a, { bookedById: m.bookedById, bookerPodIds: pods });
}

/**
 * What a save sets on the meeting's approval, worked out before it is written. A meeting asks when it
 * is saved without a link for the first time (new, or its link taken off); a meeting already without
 * a link keeps its approval, so one saved before approvals began is never asked about.
 */
export async function approvalForSave(
  next: { sourceUrl: string; bookedById: string },
  before: { sourceUrl: string; approval: MeetingApproval | null; bookedById: string | null } | null,
  user: Actor,
  now = new Date(),
): Promise<{ data: { approval?: MeetingApproval | null; approvalById?: string | null; approvalAt?: Date | null }; ask: boolean; cleared: boolean }> {
  if (!lacksRecording(next.sourceUrl)) {
    // A link added to a waiting meeting settles it: there is nothing to approve any more.
    return before?.approval === 'WAITING' ? { data: { approval: null, approvalById: null, approvalAt: null }, ask: false, cleared: true } : { data: {}, ask: false, cleared: false };
  }
  if (before && lacksRecording(before.sourceUrl)) {
    // Still waiting, but booked by someone else now: their Sales Leader is asked.
    return { data: {}, ask: before.approval === 'WAITING' && before.bookedById !== next.bookedById, cleared: false };
  }
  if (canApproveMeeting(user, { bookedById: next.bookedById, bookerPodIds: await bookerPodIds(next.bookedById) })) {
    return { data: { approval: 'APPROVED', approvalById: user.id, approvalAt: now }, ask: false, cleared: false };
  }
  return { data: { approval: 'WAITING', approvalById: null, approvalAt: null }, ask: true, cleared: false };
}

/** Ask the approvers, after the save. Returns the words for the one who saved it. */
export async function askForApproval(meetingId: string, from: { id: string }): Promise<string> {
  const m = await prisma.meeting.findUnique({ where: { id: meetingId }, select: { title: true, occurredAt: true, bookedById: true, bookedBy: { select: { name: true } } } });
  if (!m) return '';
  const approvers = await meetingApprovers(m.bookedById);
  await notify(approvers.ids.filter((id) => id !== from.id), { kind: 'meeting_approval', fromUserId: from.id, payload: { meetingId, title: m.title, day: meetingDay(m.occurredAt), bookedBy: m.bookedBy?.name ?? null, admins: approvers.admins } });
  return `It has no recording, so ${approverWords(approvers)} will approve it.`;
}

export const APPROVAL_BACKFILL = 'meetingApprovalBackfill20261121';
export const APPROVAL_BACKFILL_FROM: LocalDate = '2026-11-01';

/**
 * Owner, 21 Nov 2026: every meeting on or after 1 November with no recording link waits for approval,
 * those saved before approvals began on 20 November too. The worker runs it once. Idempotent: only a
 * meeting with no approval yet moves, so one already approved, declined or asked about is left alone,
 * and its approvers are asked once.
 */
export async function askForMeetingsSince(from: LocalDate = APPROVAL_BACKFILL_FROM, actor: AuditActor = SYSTEM_ACTOR): Promise<{ waiting: number; asked: number }> {
  const candidates = await prisma.meeting.findMany({
    where: { approval: null, review: 'APPROVED', occurredAt: { gte: new Date(meetingDayInstant(from).getTime() - 86_400_000) } },
    select: { id: true, title: true, occurredAt: true, sourceUrl: true, bookedById: true, createdById: true, bookedBy: { select: { name: true } } },
    orderBy: { occurredAt: 'asc' },
  });
  let waiting = 0;
  let asked = 0;
  const approversOf = new Map<string, Awaited<ReturnType<typeof meetingApprovers>>>();
  for (const m of candidates) {
    if (meetingDay(m.occurredAt) < from || !lacksRecording(m.sourceUrl)) continue;
    const key = m.bookedById ?? '';
    if (!approversOf.has(key)) approversOf.set(key, await meetingApprovers(m.bookedById));
    const approvers = approversOf.get(key)!;
    const bells = await prisma.$transaction(async (tx) => {
      const r = await tx.meeting.updateMany({ where: { id: m.id, approval: null, review: 'APPROVED' }, data: { approval: 'WAITING', approvalById: null, approvalAt: null } });
      if (!r.count) return null;
      await logAudit({ entityType: 'meeting', entityId: m.id, action: 'approval_asked', actor, details: { title: m.title, from } }, tx);
      return notify(approvers.ids.filter((id) => id !== m.createdById), { kind: 'meeting_approval', fromUserId: m.createdById, payload: { meetingId: m.id, title: m.title, day: meetingDay(m.occurredAt), bookedBy: m.bookedBy?.name ?? null, admins: approvers.admins } }, tx);
    });
    if (bells === null) continue;
    waiting++;
    asked += bells;
  }
  return { waiting, asked };
}

/** The approvers' bell lines for this meeting say how it was settled. */
async function settleAsks(meetingId: string, resolution: 'approved' | 'declined' | 'link_added' | 'deleted', now: Date, tx: Tx = prisma) {
  await tx.notification.updateMany({ where: { kind: 'meeting_approval', resolution: null, payload: { path: ['meetingId'], equals: meetingId } }, data: { resolution, resolvedAt: now } });
}
export async function settleApprovalAsks(meetingId: string, resolution: 'link_added' | 'deleted' = 'link_added', now = new Date()) {
  await settleAsks(meetingId, resolution, now);
}

/**
 * Before a meeting is saved: one declined with the same prospect on the same day may not come back as
 * a new meeting (owner: only its Sales Leader, Biz Ops or an admin add it back).
 */
export async function declinedTwin(prospectIds: string[], occurredAt: Date, exceptId: string | null): Promise<string | null> {
  if (!prospectIds.length) return null;
  const twin = await prisma.meeting.findFirst({
    where: { ...DECLINED_WHERE, occurredAt, ...(exceptId ? { id: { not: exceptId } } : {}), attendees: { some: { prospect: true, personId: { in: prospectIds } } } },
    select: { title: true, declinedAt: true, declineReason: true, declinedBy: { select: { name: true } }, bookedBy: { select: { name: true } } },
  });
  if (!twin) return null;
  const when = twin.declinedAt ? ` on ${formatLocalDate(meetingDay(twin.declinedAt), 'long')}` : '';
  return `"${twin.title}" on this day with this prospect was declined${when} by ${twin.declinedBy?.name ?? 'their Sales Leader'}${twin.declineReason ? `: "${twin.declineReason}"` : ''}. Only the Sales Leader of ${twin.bookedBy?.name ? `${twin.bookedBy.name}'s` : 'the booking FO\'s'} pod, Biz Ops or an admin can add it back, from Meetings > Approval.`;
}

const decisionSelect = { id: true, title: true, occurredAt: true, approval: true, review: true, bookedById: true, createdById: true, twentyMeetingId: true, twentyNoteId: true, bookedBy: { select: { name: true } }, attendees: { where: { prospect: true }, select: { personId: true } } } as const;

function stateWords(m: { approval: MeetingApproval | null; review: string }): string {
  if (m.approval === 'DECLINED') return 'This meeting was declined already.';
  if (m.approval === 'APPROVED') return 'This meeting was approved already.';
  if (!m.approval) return 'This meeting does not need an approval: it has a recording link.';
  return 'This meeting is not waiting for a decision.';
}

const prospectIdsOf = (m: { attendees: { personId: string | null }[] }) => m.attendees.flatMap((a) => (a.personId ? [a.personId] : []));

/** Its prospects are numbered again, and the meetings whose numbers moved are written to the CRM. */
async function renumberAround(meetingId: string | null, prospects: string[]) {
  const changed = await renumberProspects(prospects);
  await afterResponse(async () => {
    for (const id of new Set([...(meetingId ? [meetingId] : []), ...changed])) await pushMeetingToCrm(id);
  });
}

export async function approveMeeting(id: string, user: Decider, actor: AuditActor, now = new Date()): Promise<ApprovalResult> {
  const m = await prisma.meeting.findUnique({ where: { id }, select: decisionSelect });
  if (!m) return { ok: false, error: 'Meeting not found.' };
  if (m.approval !== 'WAITING' || m.review !== 'APPROVED') return { ok: false, error: stateWords(m) };
  const why = whyNotApproveMeeting(user, { bookedById: m.bookedById, bookerPodIds: await bookerPodIds(m.bookedById) }, m.bookedBy?.name ?? null);
  if (why) return { ok: false, error: why };
  const done = await prisma.$transaction(async (tx) => {
    const r = await tx.meeting.updateMany({ where: { id, ...WAITING_WHERE }, data: { approval: 'APPROVED', approvalById: user.id, approvalAt: now } });
    if (!r.count) return false;
    await settleAsks(id, 'approved', now, tx);
    await logAudit({ entityType: 'meeting', entityId: id, action: 'approved', actor, details: { title: m.title } }, tx);
    return true;
  });
  if (!done) return { ok: false, error: 'Someone decided on this meeting a moment ago. Reload to see what they chose.' };
  return { ok: true, message: `Approved "${m.title}".` };
}

export async function declineMeeting(id: string, reason: string, user: Decider, actor: AuditActor, now = new Date()): Promise<ApprovalResult> {
  const why = reason.trim();
  if (!why) return { ok: false, error: 'Say why it is declined: Biz Ops and the FO who booked it read it.' };
  if (why.length > 1000) return { ok: false, error: 'Keep the reason under 1,000 characters.' };
  const m = await prisma.meeting.findUnique({ where: { id }, select: decisionSelect });
  if (!m) return { ok: false, error: 'Meeting not found.' };
  if (m.approval !== 'WAITING' || m.review !== 'APPROVED') return { ok: false, error: stateWords(m) };
  const refusal = whyNotApproveMeeting(user, { bookedById: m.bookedById, bookerPodIds: await bookerPodIds(m.bookedById) }, m.bookedBy?.name ?? null);
  if (refusal) return { ok: false, error: refusal };
  const bizOps = await prisma.user.findMany({ where: { active: true, role: 'BIZ_OPS' }, select: { id: true } });
  const done = await prisma.$transaction(async (tx) => {
    // Only while it still waits: two leaders deciding at once settle it once.
    const r = await tx.meeting.updateMany({
      where: { id, ...WAITING_WHERE },
      data: { review: 'DISMISSED', approval: 'DECLINED', declinedById: user.id, declinedAt: now, declineReason: why, twentyMeetingId: null, twentyNoteId: null, twentySnapshot: Prisma.DbNull, twentySyncedAt: null },
    });
    if (!r.count) return false;
    await settleAsks(id, 'declined', now, tx);
    await notify([...bizOps.map((u) => u.id), m.bookedById, m.createdById].filter((u) => u !== user.id), { kind: 'meeting_declined', fromUserId: user.id, payload: { meetingId: id, title: m.title, day: meetingDay(m.occurredAt), reason: why, bookedBy: m.bookedBy?.name ?? null } }, tx);
    await logAudit({ entityType: 'meeting', entityId: id, action: 'declined', actor, details: { title: m.title, reason: why, twentyMeetingId: m.twentyMeetingId, twentyNoteId: m.twentyNoteId } }, tx);
    return true;
  });
  if (!done) return { ok: false, error: 'Someone decided on this meeting a moment ago. Reload to see what they chose.' };
  // Out of the CRM (from the ids read before), and its prospects' later meetings each move down one.
  await afterResponse(() => removeMeetingFromCrm({ twentyMeetingId: m.twentyMeetingId, twentyNoteId: m.twentyNoteId }));
  await renumberAround(null, prospectIdsOf(m));
  return { ok: true, message: `Declined "${m.title}". It is out of Cadence and the CRM; Biz Ops and ${m.bookedBy?.name ?? 'the FO who booked it'} are told why.` };
}

export async function addMeetingBack(id: string, user: Decider, actor: AuditActor, now = new Date()): Promise<ApprovalResult> {
  const m = await prisma.meeting.findUnique({ where: { id }, select: decisionSelect });
  if (!m) return { ok: false, error: 'Meeting not found.' };
  if (m.approval !== 'DECLINED' || m.review !== 'DISMISSED') return { ok: false, error: m.approval === 'WAITING' || m.approval === 'APPROVED' ? 'This meeting is in Cadence already.' : 'Only a declined meeting can be added back.' };
  if (!canAddBackMeeting(user, { bookedById: m.bookedById, bookerPodIds: await bookerPodIds(m.bookedById) })) return { ok: false, error: `Only the Sales Leader of ${m.bookedBy?.name ? `${m.bookedBy.name}'s` : 'the booking FO\'s'} pod, Biz Ops and admins can add a declined meeting back.` };
  const done = await prisma.$transaction(async (tx) => {
    const r = await tx.meeting.updateMany({ where: { id, ...DECLINED_WHERE }, data: { review: 'APPROVED', approval: 'APPROVED', approvalById: user.id, approvalAt: now } });
    if (!r.count) return false;
    await notify([m.bookedById, m.createdById].filter((u) => u !== user.id), { kind: 'meeting_added_back', fromUserId: user.id, payload: { meetingId: id, title: m.title, day: meetingDay(m.occurredAt) } }, tx);
    await logAudit({ entityType: 'meeting', entityId: id, action: 'added_back', actor, details: { title: m.title } }, tx);
    return true;
  });
  if (!done) return { ok: false, error: 'Someone added this meeting back a moment ago.' };
  // Numbered again with its prospects, and written to the CRM again.
  await renumberAround(id, prospectIdsOf(m));
  return { ok: true, message: `Added "${m.title}" back. It counts again and is back in the CRM.` };
}
