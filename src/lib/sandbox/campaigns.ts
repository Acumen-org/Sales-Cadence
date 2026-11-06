import type { Prisma, SandboxContact } from '@prisma/client';
import { prisma, type Tx } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { addDays, formatLocalDate, todayIn, toLocalDate, type LocalDate } from '../dates';
import { needsPod, ROLE_LABELS, ROLES_NEEDING_POD } from '../auth/rbac';
import { OCCUPYING_STATUSES } from '../engine/enrollment';
import { advanceEnrollment, type EngineContext } from '../engine/tasks';
import { workspaceTimezone } from '../workspace';
import { calendarDays, workingDay, type CampaignDraft, type PlannerPerson } from '../campaign-planner';
import { campaignMembers, podLabel, whoAndWhy, type AudienceIssue, type AudienceIssueKind } from '../campaign-audience';
import type { PublishedCalendar } from '../campaign-planning-service';
import { clearColdLookups, contactability, channelOfAction, type ColdLookup, type ContactCheck, type ContactChannel } from '../outreach/contactability';
import { canAct, type ColdSubject, type GuardActor } from '../outreach/guard';
import { applyTransfer } from '../outreach/transfer';
import { notify, podLeaders } from '../notifications';
import { hasUsableEmail } from './ready';
import { readExtraPhones } from './normalize';

/**
 * Cold campaigns (cold outreach PLAN 4.4, 8.9, W7): the campaign studio and the calendar engine CRM
 * campaigns use, with the cold rules where cold outreach needs them. A cold campaign is a Campaign
 * whose audience is SANDBOX; its personIds are cold contact ids, and its audience never changes.
 * There is no approval: publishing schedules it, as for a CRM campaign, and the pod's leaders are
 * told. Launch locks every contact row (the lock opt-out takes), checks each one again, leaves out and
 * names whoever cannot be contacted now, and has the campaign's rep claim an unclaimed contact.
 */

/** A cold contact's planner key for its owner: the Cadence user who owns it (a CRM person's is the CRM member). */
export const coldOwnerKey = (userId: string) => `user:${userId}`;

const contactName = (c: Pick<SandboxContact, 'firstName' | 'lastName'>) => `${c.firstName} ${c.lastName}`.trim() || 'Removed contact';
const and = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** Campaigns that hold their people: scheduled or running (a draft holds nobody, as for CRM campaigns). */
export const HOLDING = ['SCHEDULED', 'ACTIVE', 'PAUSED'] as const;
/** Whether a cold campaign in this state holds the contacts in its list (S7: never a draft). */
export const campaignHolds = (status: string) => (HOLDING as readonly string[]).includes(status);

export type ColdAudienceContext = {
  podId: string;
  podName: string;
  /** The campaign's FOs. Once any is chosen, an owned contact must be one of theirs. */
  foIds: string[];
  campaignId?: string;
  /** Pod Managers and admins add contacts from any pod (canAddFromAnyPod). */
  anyPod?: boolean;
  /** Who is choosing: the guard's enroll rule applies to each contact (B132). */
  actor?: GuardActor | null;
};

/** A contactability block as a left-out reason: one short clause, the way the studio lists reasons. */
export function leftOutReason(check: Extract<ContactCheck, { ok: false }>, c: Pick<SandboxContact, 'status'>): string {
  switch (check.block) {
    case 'inactive': return c.status === 'OPTED_OUT' ? 'Opted out' : c.status === 'REMOVED' ? 'Removed' : c.status === 'MOVED' ? 'Moved to the CRM' : 'Being moved to the CRM';
    case 'suppressed': return 'On the suppression list';
    case 'do_not_contact': return 'Marked Do not contact in the CRM';
    case 'in_crm': return 'Already in the CRM';
    default: return check.reason.replace(/\.$/, '');
  }
}

const KIND: Record<string, AudienceIssueKind> = { inactive: 'deleted', suppressed: 'optedOut', do_not_contact: 'dnd', in_crm: 'inCrm' };

function guardSubject(c: SandboxContact & { owner: { name: string; active: boolean } | null; pod: { name: string } | null }): ColdSubject {
  return {
    kind: 'cold', id: c.id, status: c.status, name: contactName(c), ownerId: c.ownerId, ownerName: c.owner?.name ?? null, ownerActive: c.owner?.active ?? false,
    podId: c.podId, podName: c.pod?.name ?? null, twentyPersonId: c.twentyPersonId, movedById: c.movedById, optedOutAt: c.optedOutAt, optOutSource: c.optOutSource,
    crmMatchPersonId: c.crmMatchPersonId, crmAutoPersonId: c.crmAutoPersonId, moving: false,
  };
}

/**
 * Who cannot be in this cold campaign, and why, in one clause each: the studio's audience check, the
 * picker's, adding people, and the campaign page before launch (PLAN 4.4). In order: contactability
 * for a campaign (8.2: not active or being moved, suppressed on any key, Do not contact in the CRM,
 * already in the CRM), an owner who has left (N069), the guard's rule for who may add whom (B132),
 * another campaign, then the pod and the campaign's team, as for CRM people.
 */
export async function coldAudienceIssues(ids: string[], context?: ColdAudienceContext, db: Tx = prisma): Promise<AudienceIssue[]> {
  if (!ids.length) return [];
  const [contacts, campaigns, enrollments, kept] = await Promise.all([
    db.sandboxContact.findMany({ where: { id: { in: ids } }, include: { owner: { select: { name: true, active: true, role: true, pods: { select: { podId: true, pod: { select: { name: true } } } } } }, pod: { select: { name: true } } } }),
    db.campaign.findMany({ where: { audience: 'SANDBOX', status: { in: [...HOLDING] }, personIds: { hasSome: ids }, ...(context?.campaignId ? { id: { not: context.campaignId } } : {}) }, select: { name: true, personIds: true } }),
    db.enrollment.findMany({ where: { sandboxContactId: { in: ids }, personId: null, status: { in: OCCUPYING_STATUSES }, ...(context?.campaignId ? { OR: [{ campaignId: null }, { campaignId: { not: context.campaignId } }] } : {}) }, select: { sandboxContactId: true, campaign: { select: { name: true } }, sequence: { select: { name: true } } } }),
    context?.campaignId && !context.anyPod ? campaignMembers(context.campaignId, db) : Promise.resolve(new Set<string>()),
  ]);
  // The lookups each contact's check would make, read for all of them at once (W13 volume test).
  const clear = await clearColdLookups(contacts, db);
  const occupied = new Map<string, string>();
  for (const c of campaigns) for (const id of c.personIds) occupied.set(id, c.name);
  for (const e of enrollments) if (e.sandboxContactId) occupied.set(e.sandboxContactId, e.campaign?.name ?? `the ${e.sequence.name} sequence`);
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const out: AudienceIssue[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    const issue = (kind: AudienceIssueKind, reason: string, ownerId?: string) => { out.push({ id, name: c ? contactName(c) : 'Unknown contact', company: c?.companyName ?? null, kind, reason, ...(ownerId ? { ownerId } : {}) }); };
    if (!c) { issue('deleted', 'No longer in Cold outreach'); continue; }
    const check = await contactability({ kind: 'cold', row: c }, { act: 'enroll', tx: db, clear: clear.get(c.id) });
    if (!check.ok) { issue(KIND[check.block] ?? 'blocked', leftOutReason(check, c)); continue; }
    // N069: a removed rep's contact says so, and what to do, rather than "outside this pod".
    if (c.ownerId && c.owner && !c.owner.active) { issue('owner', `${c.owner.name} no longer has access: assign these contacts first`); continue; }
    if (context?.actor) {
      const verdict = canAct(context.actor, guardSubject(c), 'enroll');
      if (!verdict.ok) { issue('owner', verdict.reason.replace(/\.$/, '')); continue; }
    }
    if (occupied.has(id)) { issue('busy', `Already in ${occupied.get(id)}`); continue; }
    if (!context) continue;
    const owner = c.ownerId && c.owner?.active ? c.owner : null;
    if (owner) {
      if (context.foIds.includes(c.ownerId!)) continue;
      const fo = needsPod(owner.role);
      const runsHere = fo && owner.pods.some((p) => p.podId === context.podId);
      if (!fo) { issue('owner', `Owned by ${owner.name}, who does not run outreach`); continue; }
      if (!runsHere) { issue('outside', owner.pods.length ? `Owned by ${owner.name} in another pod (${and(owner.pods.map((p) => podLabel(p.pod.name)))})` : `Owned by ${owner.name}, who is not in any pod`); continue; }
      if (context.foIds.length) issue('owner', `Owned by ${owner.name}, who is not on this campaign`, c.ownerId!);
      continue;
    }
    if (c.podId && c.podId !== context.podId && !context.anyPod && !kept.has(id)) issue('outside', `In ${podLabel(c.pod?.name ?? 'another pod')}, so only a Pod Manager or admin can add them`);
  }
  return out;
}

/** Contacts the planner places: name, firm and the owner key campaignQueues matches to an FO. */
export async function coldPlannerRows(ids: string[], db: Tx = prisma): Promise<Array<PlannerPerson & { company: string | null }>> {
  const rows = await db.sandboxContact.findMany({ where: { id: { in: ids } }, include: { owner: { select: { active: true } } }, orderBy: { id: 'asc' } });
  return rows.map((c) => ({ id: c.id, name: contactName(c), company: c.companyName, ownerMemberId: c.ownerId && c.owner?.active ? coldOwnerKey(c.ownerId) : null, tags: [], contactType: [], tier: null }));
}

/** What publishing a cold plan will do beyond the calendar: who is claimed by whom, and what to know before it runs. */
export type ColdPlanNotes = {
  /** Unclaimed contacts each FO claims at launch (B135). */
  claims: { foId: string; name: string; count: number }[];
  /** Warnings, each with who it is about: no email or phone for the steps (B136), calls with no outcome yet (N070). */
  warnings: { reason: string; people: { id: string; name: string }[] }[];
};

const NO_CHANNEL: Record<ContactChannel, string> = { EMAIL: 'No email: email steps will be skipped', CALL: 'No phone: call steps will be skipped', LINKEDIN: 'No LinkedIn profile: LinkedIn steps will be skipped' };

/**
 * Warnings for a cold audience (never a reason to leave anyone out): a contact with no usable detail
 * for a channel the outreach uses (B136), and contacts whose calls still wait for their form (N070).
 */
export async function coldAudienceWarnings(ids: string[], channels: Set<ContactChannel>, db: Tx = prisma): Promise<ColdPlanNotes['warnings']> {
  if (!ids.length) return [];
  const [contacts, calls] = await Promise.all([
    db.sandboxContact.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, email: true, badEmail: true, emailVerification: true, phone: true, badPhone: true, additionalPhones: true, linkedinUrl: true }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }] }),
    db.callLog.findMany({ where: { sandboxContactId: { in: ids }, formDueAt: { not: null }, formDoneAt: null, discardedAt: null }, select: { sandboxContactId: true }, distinct: ['sandboxContactId'] }),
  ]);
  const waiting = new Set(calls.map((c) => c.sandboxContactId));
  const groups = new Map<string, { id: string; name: string }[]>();
  const add = (reason: string, c: (typeof contacts)[number]) => groups.set(reason, [...(groups.get(reason) ?? []), { id: c.id, name: contactName(c) }]);
  for (const c of contacts) {
    if (channels.has('EMAIL') && !hasUsableEmail(c)) add(NO_CHANNEL.EMAIL, c);
    if (channels.has('CALL') && (c.badPhone || !(c.phone ?? readExtraPhones(c.additionalPhones)[0]?.number))) add(NO_CHANNEL.CALL, c);
    if (channels.has('LINKEDIN') && !c.linkedinUrl) add(NO_CHANNEL.LINKEDIN, c);
  }
  for (const c of contacts) if (waiting.has(c.id)) add(`${waiting.size === 1 ? 'A call has' : 'Calls have'} no outcome yet: fill in the form first`, c);
  return [...groups].map(([reason, people]) => ({ reason, people }));
}

/** The channels an outreach plan uses, for the warnings. */
export function draftChannels(flows: CampaignDraft['flows']): Set<ContactChannel> {
  const out = new Set<ContactChannel>();
  for (const f of flows) for (const s of f.steps) for (const a of s.actions) { const ch = channelOfAction(a.type); if (ch) out.add(ch); }
  return out;
}

/** Who claims whom at launch: each batch's unowned contacts go to its FO (B135). */
export function coldClaims(calendar: Pick<PublishedCalendar, 'batches' | 'people' | 'fos'>): ColdPlanNotes['claims'] {
  const unowned = new Set(calendar.people.filter((p) => !p.ownerMemberId).map((p) => p.id));
  const counts = new Map<string, number>();
  for (const b of calendar.batches) { const n = b.personIds.filter((id) => unowned.has(id)).length; if (n) counts.set(b.foId, (counts.get(b.foId) ?? 0) + n); }
  return [...counts].map(([foId, count]) => ({ foId, count, name: calendar.fos.find((f) => f.id === foId)?.name ?? 'An FO' })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** B046: a cold campaign was published, so its pod's leaders know it will run and can pause or stop it. */
export async function notifyColdPublished(campaign: { id: string; name: string; podId: string; startDate: string; personIds: string[] }, by: { id: string; name: string }) {
  const leaders = (await podLeaders([campaign.podId])).filter((id) => id !== by.id);
  await notify(leaders, { kind: 'campaign_published', fromUserId: by.id, payload: { campaignId: campaign.id, name: campaign.name, startDate: campaign.startDate, people: campaign.personIds.length, from: by.name } });
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export type LeftAtLaunch = { id: string; name: string; reason: string };
type LoadedContact = SandboxContact & { owner: { name: string; active: boolean } | null };

/**
 * Everything launch reads about the contacts besides their own rows, read once inside the launch
 * transaction after the rows are locked.
 */
async function launchContext(tx: Tx, ids: string[], campaignId: string) {
  const [contacts, meetings, busy] = await Promise.all([
    tx.sandboxContact.findMany({ where: { id: { in: ids } }, include: { owner: { select: { name: true, active: true } } } }),
    tx.nextAction.findMany({ where: { sandboxContactId: { in: ids }, personId: null, state: 'OPEN', kind: 'MEETING' }, select: { sandboxContactId: true } }),
    tx.enrollment.findMany({ where: { sandboxContactId: { in: ids }, personId: null, status: { in: OCCUPYING_STATUSES }, OR: [{ campaignId: null }, { campaignId: { not: campaignId } }] }, select: { sandboxContactId: true, campaign: { select: { name: true } }, sequence: { select: { name: true } } } }),
  ]);
  return {
    contacts: new Map(contacts.map((c) => [c.id, c as LoadedContact])),
    clear: await clearColdLookups(contacts, tx) as Map<string, ReadonlySet<ColdLookup>>,
    meetings: new Set(meetings.map((m) => m.sandboxContactId)),
    busy: new Map(busy.map((e) => [e.sandboxContactId!, e.campaign?.name ?? `the ${e.sequence.name} sequence`])),
  };
}

/**
 * Why this contact cannot start now, or null: contactability again under the lock (N002), a Not
 * interested or a booked meeting since the campaign was planned (N021), another running campaign, and
 * an owner who is not the rep the plan gives it to.
 */
async function launchRefusal(tx: Tx, c: LoadedContact, ctx: Awaited<ReturnType<typeof launchContext>>, opts: { since: Date; foId: string; foName: string; now: Date }): Promise<string | null> {
  const check = await contactability({ kind: 'cold', row: c }, { act: 'enroll', tx, now: opts.now, clear: ctx.clear.get(c.id) });
  if (!check.ok && check.effect === 'leave_out') return leftOutReason(check, c);
  if (c.lastOutcomeAt && c.lastOutcomeAt >= opts.since && (c.lastOutcome === 'not_interested' || c.lastOutcome === 'meeting_booked')) {
    const day = formatLocalDate(toLocalDate(c.lastOutcomeAt, workspaceTimezone()));
    return c.lastOutcome === 'not_interested' ? `Said Not interested on ${day}` : `Booked a meeting on ${day}`;
  }
  if (ctx.meetings.has(c.id)) return 'Has a meeting booked';
  if (ctx.busy.has(c.id)) return `Already in ${ctx.busy.get(c.id)}`;
  const owner = c.ownerId && c.owner?.active ? c.ownerId : null;
  if (owner && owner !== opts.foId) return `Owned by ${c.owner!.name} now, not ${opts.foName}`;
  return null;
}

/**
 * Start one contact inside the launch transaction: the rep who runs it claims it when nobody does
 * (8.8, through the one transfer path), and the start counts as activity.
 */
async function startContact(tx: Tx, c: LoadedContact, foId: string, podId: string, actor: AuditActor, now: Date) {
  if (!(c.ownerId && c.owner?.active)) await applyTransfer(tx, c, { id: foId }, podId, { actor, now, action: 'claimed', reason: 'campaign_launch' });
  await tx.sandboxContact.update({ where: { id: c.id }, data: { lastActivityAt: now } });
}

/** Lock the contact rows in id order: the lock opt-out, Remove and every guarded write take (N002, B129). */
async function lockContacts(tx: Tx, ids: string[]) {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length) await tx.$queryRaw`SELECT id FROM "SandboxContact" WHERE id = ANY(${sorted}) ORDER BY id FOR UPDATE`;
}

/** Working day `n` after `day` on the planner's calendar (Monday to Friday). */
function workingDaysAfter(day: LocalDate, n: number): LocalDate {
  let d = day;
  for (let i = 0; i < n; i++) { d = addDays(d, 1); while (!workingDay(d)) d = addDays(d, 1); }
  return d;
}

/**
 * N019: a launch after the start date never backdates the plan. Every date moves on by the working
 * days missed, so the first starts today (or the next working day) and the spacing is kept; the end
 * date moves with them when it has to.
 */
export function shiftCalendar(plan: Pick<PublishedCalendar, 'batches' | 'days'>, startDate: LocalDate, endDate: LocalDate | null, today: LocalDate) {
  if (startDate >= today) return null;
  let launch = today;
  while (!workingDay(launch)) launch = addDays(launch, 1);
  const missed = Math.max(0, calendarDays(startDate, launch).length - 1);
  if (!missed) return null;
  const batches = plan.batches.map((b) => ({ ...b, dates: b.dates.map((d) => workingDaysAfter(d, missed)) }));
  const last = batches.flatMap((b) => b.dates).sort().at(-1) ?? launch;
  const end = endDate && endDate >= last ? endDate : last;
  return { batches, startDate: launch, endDate: end, days: calendarDays(launch, end) };
}

/**
 * Launch a cold campaign from its published calendar (8.9). The locks are publication's, the
 * campaign's, then every contact row in id order. Inside them each contact is checked again; whoever
 * cannot start is left out and named on the campaign page, never contacted, and the rest start on the
 * plan's dates (moved on, never back, N019). A campaign nobody can start does not go active (B129).
 */
export async function activateColdCalendar(id: string, ctx: EngineContext) {
  const now = ctx.now ?? new Date();
  const today = todayIn(workspaceTimezone(), now);
  let left: LeftAtLaunch[] = [];
  const created = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('campaign-planner-publication'))`;
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${id}`}))`;
    const c = await tx.campaign.findUniqueOrThrow({ where: { id }, include: { pod: true } });
    if (c.status !== 'SCHEDULED' || c.startDate > today) return null;
    const plan = c.publishedPlan as unknown as PublishedCalendar | null;
    if (c.pod.archived) throw new Error(`Not started: ${c.pod.name} has been archived. Edit the campaign, choose another pod and publish it again.`);
    if (!plan?.valid || plan.version !== 1) throw new Error('Not started: this campaign has no finished calendar. Edit it and publish it again.');
    const ids = plan.batches.flatMap((b) => b.personIds);
    if (new Set(ids).size !== ids.length) throw new Error('Not started: its calendar lists someone twice. Edit the campaign and publish it again.');
    const fos = await tx.user.findMany({ where: { id: { in: plan.fos.map((f) => f.id) }, active: true, role: { in: ROLES_NEEDING_POD }, pods: { some: { podId: c.podId } } } });
    if (fos.length !== plan.fos.length) {
      const gone = await tx.user.findMany({ where: { id: { in: plan.fos.filter((f) => !fos.some((x) => x.id === f.id)).map((f) => f.id) } }, select: { name: true, active: true, role: true } });
      throw new Error(`Not started, because things changed after it was published: ${gone.map((f) => !f.active ? `${f.name} no longer has access to Cadence` : !ROLES_NEEDING_POD.includes(f.role) ? `${f.name} is now ${ROLE_LABELS[f.role]} and does not run outreach` : `${f.name} is no longer in ${c.pod.name}`).join('; ')}. Nobody has been contacted. Edit the campaign and publish it again.`);
    }
    const shifted = shiftCalendar(plan, c.startDate, c.endDate, today);
    const batches = shifted?.batches ?? plan.batches;
    await lockContacts(tx, ids);
    const loaded = await launchContext(tx, ids, id);
    const since = c.approvedAt ?? c.updatedAt;
    const nameOf = new Map(plan.people.map((p) => [p.id, p.name]));
    const foName = new Map(plan.fos.map((f) => [f.id, f.name]));
    const rows = [];
    left = [];
    for (const b of batches) {
      if (!plan.sequenceIds[b.flowId] || !b.dates.length) throw new Error('Not started: its calendar is incomplete. Edit the campaign and publish it again.');
      for (const contactId of b.personIds) {
        const contact = loaded.contacts.get(contactId);
        if (!contact) { left.push({ id: contactId, name: nameOf.get(contactId) ?? 'Someone', reason: 'No longer in Cold outreach' }); continue; }
        const refusal = await launchRefusal(tx, contact, loaded, { since, foId: b.foId, foName: foName.get(b.foId) ?? 'its FO', now });
        if (refusal) { left.push({ id: contactId, name: contactName(contact), reason: refusal }); continue; }
        await startContact(tx, contact, b.foId, c.podId, ctx.actor, now);
        rows.push({ sandboxContactId: contactId, campaignId: id, campaignRun: c.runNumber, foUserId: b.foId, podId: c.podId, sequenceId: plan.sequenceIds[b.flowId], startDate: b.dates[0], scheduleDates: b.dates, createdById: c.createdById, status: 'ACTIVE' as const, audience: 'SANDBOX' as const, createdAt: now });
      }
    }
    if (!rows.length) throw new Error(`Not started: nobody in it can be contacted now: ${whoAndWhy(left)}. Nobody has been contacted.`);
    await tx.enrollment.createMany({ data: rows });
    await tx.campaign.update({ where: { id }, data: { status: 'ACTIVE', ...(shifted ? { startDate: shifted.startDate, endDate: shifted.endDate, publishedPlan: JSON.parse(JSON.stringify({ ...plan, batches: shifted.batches, days: shifted.days })) as Prisma.InputJsonValue } : {}) } });
    await logAudit({ entityType: 'campaign', entityId: id, action: 'started', actor: ctx.actor, details: { people: rows.length, batches: batches.length, calendar: true, audience: 'SANDBOX', leftOut: left, ...(shifted ? { startMoved: { from: c.startDate, to: shifted.startDate, endDate: shifted.endDate } } : {}) } }, tx);
    return tx.enrollment.findMany({ where: { campaignId: id, campaignRun: c.runNumber }, select: { id: true } });
  }, { timeout: 60_000 });
  if (!created) return { enrolled: 0, skipped: 0 };
  for (const e of created) await advanceEnrollment(e.id, ctx);
  return { enrolled: created.length, skipped: left.length };
}

/** Who a launch left out, from its audit row, for the campaign page (N021, B047). */
export async function leftAtLaunch(campaignId: string): Promise<{ at: Date; people: LeftAtLaunch[] } | null> {
  const row = await prisma.auditLog.findFirst({ where: { entityType: 'campaign', entityId: campaignId, action: 'started' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, details: true } });
  const people = (row?.details as { leftOut?: LeftAtLaunch[] } | null)?.leftOut;
  return row && Array.isArray(people) && people.length ? { at: row.createdAt, people } : null;
}

