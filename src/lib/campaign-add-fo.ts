import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from './db';
import type { SessionUser } from './auth/current-user';
import { canManageCampaigns, ROLES_NEEDING_POD } from './auth/rbac';
import { campaignAudienceIssues } from './campaign-audience';
import { CampaignDraftSchema, shortDateLabel, type CampaignDraft, type PlannedBatch, type PlannerPerson } from './campaign-planner';
import { fitCampaign, isFit } from './campaign-fit';
import { cachedPersonName } from './person-cache';
import { lockAccounts } from './account-lock';
import { logAudit, userActor } from './audit';
import { todayIn } from './dates';
import { workspaceTimezone } from './workspace';
import { cleanRichText } from './rich-text';
import type { LeftOut, PublishedCalendar } from './campaign-planning-service';
import { advanceEnrollment } from './engine/tasks';

/**
 * A new FO joining a running campaign on its start day (owner, 24 September 2026): "I cannot alter
 * anything to existing FOs but I can add new people and the system accommodates them. This can
 * only be done on the start day."
 *
 * The new FO's part is planned on its own, over the same working days, under the same rules as
 * every FO's: each working day one or two of their batches, whole journeys by the end date. It uses
 * the campaign's own outreach; only when that cannot fill the FO's days, and the campaign's outreach
 * was built by the studio, does the FO get an outreach group of their own. Existing FOs' batches,
 * outreach and enrollments are never touched: the plan is appended to, and only the new people are
 * put into outreach.
 */

type Stored = CampaignDraft & { sequenceIds?: Record<string, string>; request?: CampaignDraft };
export type AddFoInput = { foId: string; personIds: string[]; batchSize: number };
export type AddFoPreview = {
  fingerprint: string;
  fo: { id: string; name: string };
  pace: number;
  requested: number;
  /** The campaign's outreach group the new people follow, or the one made for this FO. */
  flow: { id: string; name: string; steps: CampaignDraft['flows'][number]['steps']; created: boolean };
  batches: PlannedBatch[];
  people: PlannerPerson[];
  leftOut: LeftOut[];
};
export type AddFoResult = { ok: true; preview: AddFoPreview } | { ok: false; error: string; leftOut?: LeftOut[] };

/** Whether a new FO can join now: a running studio campaign, on its start day. */
export function addFoWindow(c: { status: string; startDate: string; plannerDraft: unknown; publishedPlan: unknown; followupSourceId?: string | null }, now = new Date()): { open: true } | { open: false; reason: string } {
  if (!c.plannerDraft || !c.publishedPlan) return { open: false, reason: 'Only a campaign planned in the studio can take a new FO.' };
  if (c.followupSourceId) return { open: false, reason: 'A follow-up holds only the people who did not reply to the campaign before it.' };
  if (c.status !== 'ACTIVE') return { open: false, reason: 'A new FO can join only while the campaign is running.' };
  const today = todayIn(workspaceTimezone(), now);
  const firstWorkingDay = (c.publishedPlan as { days?: string[] }).days?.[0] ?? c.startDate;
  if (today < c.startDate || today > (firstWorkingDay > c.startDate ? firstWorkingDay : c.startDate)) return { open: false, reason: 'A new FO can join only on the campaign’s start day.' };
  return { open: true };
}

/** FOs of the campaign's pod who are not on it yet. */
export async function addFoCandidates(campaignId: string, db: Tx = prisma) {
  const c = await db.campaign.findUniqueOrThrow({ where: { id: campaignId }, select: { podId: true, publishedPlan: true } });
  const onIt = new Set([...((c.publishedPlan as unknown as PublishedCalendar | null)?.fos ?? []).map((f) => f.id), ...(await db.enrollment.findMany({ where: { campaignId }, distinct: ['foUserId'], select: { foUserId: true } })).map((e) => e.foUserId)]);
  const fos = await db.user.findMany({ where: { active: true, role: { in: ROLES_NEEDING_POD }, pods: { some: { podId: c.podId } } }, select: { id: true, name: true, twentyMemberId: true }, orderBy: { name: 'asc' } });
  return fos.filter((f) => !onIt.has(f.id));
}

/** Plan the new FO's part without writing anything. The same function runs again inside apply. */
export async function planAddFo(user: SessionUser, campaignId: string, input: AddFoInput, options: { now?: Date } = {}, db: Tx = prisma): Promise<AddFoResult> {
  const c = await db.campaign.findUnique({ where: { id: campaignId }, include: { pod: true } });
  if (!c) return { ok: false, error: 'Campaign not found.' };
  if (!canManageCampaigns(user, c.podId)) return { ok: false, error: 'Only the pod’s leaders and admins can add an FO to a running campaign.' };
  const window = addFoWindow(c, options.now);
  if (!window.open) return { ok: false, error: window.reason };
  const stored = c.plannerDraft as unknown as Stored;
  const plan = c.publishedPlan as unknown as PublishedCalendar;
  if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 500) return { ok: false, error: 'New people a day must be a whole number from 1 to 500.' };
  const fo = (await addFoCandidates(campaignId, db)).find((f) => f.id === input.foId);
  if (!fo) return { ok: false, error: 'Choose an FO of this pod who is not on the campaign yet.' };

  // Only people nobody holds: not in this campaign or any other, reachable, and the new FO's own or unowned.
  const ids = [...new Set(input.personIds)];
  if (!ids.length) return { ok: false, error: `Choose the people ${fo.name} will reach.` };
  const members = new Set([...c.personIds, ...(await db.enrollment.findMany({ where: { campaignId, personId: { in: ids } }, select: { personId: true } })).map((e) => e.personId)]);
  const issues = await campaignAudienceIssues(ids.filter((id) => !members.has(id)), { podId: c.podId, podOwnerValue: c.pod.podOwnerValue, podName: c.pod.name, ownerMemberIds: fo.twentyMemberId ? [fo.twentyMemberId] : [], checkOwners: true }, db);
  const rows = await db.personCache.findMany({ where: { id: { in: ids } } });
  const byId = new Map(rows.map((p) => [p.id, p]));
  const describe = (id: string, reason: string): LeftOut => { const p = byId.get(id); return { id, name: p ? cachedPersonName(p) : 'Unknown contact', company: p?.companyName ?? null, kind: 'busy', reason }; };
  const leftOut: LeftOut[] = [...ids.filter((id) => members.has(id)).map((id) => describe(id, `Already in ${c.name}`)), ...issues];
  const out = new Set(leftOut.map((l) => l.id));
  const accepted = ids.filter((id) => !out.has(id) && byId.has(id));
  if (!accepted.length) return { ok: false, error: `None of the people chosen can join ${c.name} with ${fo.name}.`, leftOut };
  const people: PlannerPerson[] = accepted.map((id) => { const p = byId.get(id)!; return { id, name: cachedPersonName(p), ownerMemberId: p.ownerMemberId, tags: p.tags, contactType: p.contactType, tier: p.tier }; });

  // The new FO alone, over the campaign's own working days.
  const base: CampaignDraft = CampaignDraftSchema.parse({ ...stored, fos: [{ id: fo.id, batchSize: input.batchSize }], personIds: accepted, assignments: {}, foAssignments: undefined });
  const team = [{ id: fo.id, name: fo.name, twentyMemberId: fo.twentyMemberId }];
  let fit = fitCampaign(base, people, team, { reshapeOutreach: false });
  let flow: AddFoPreview['flow'] = { ...stored.flows[0], created: false };
  if (!isFit(fit) || fit.droppedFos.some((d) => d.id === fo.id)) {
    // The campaign's outreach cannot fill this FO's days. An outreach the studio built may be built again for them.
    const automatic = stored.outreachEdited === false || (stored.request?.outreachEdited === false);
    if (!automatic) return { ok: false, error: `With this campaign’s outreach, ${fo.name}’s ${accepted.length} ${accepted.length === 1 ? 'person' : 'people'} cannot fill every working day to ${shortDateLabel(c.endDate ?? c.startDate)}. Try more people, or another pace.`, leftOut };
    const own = fitCampaign({ ...base, flows: [{ id: 'default', name: 'Default', steps: stored.flows[0].steps.slice(0, 1) }] }, people, team, { reshapeOutreach: true });
    if (!isFit(own) || own.droppedFos.some((d) => d.id === fo.id)) return { ok: false, error: `${fo.name}’s ${accepted.length} ${accepted.length === 1 ? 'person' : 'people'} cannot fill every working day to ${shortDateLabel(c.endDate ?? c.startDate)}. Choose more people.`, leftOut };
    fit = own;
    const id = uniqueFlowId(stored, `fo-${fo.id}`);
    flow = { id, name: `For ${fo.name}`.slice(0, 80), steps: own.draft.flows[0].steps, created: true };
  }
  if (!fit.calendar.valid) return { ok: false, error: 'No calendar fits this FO’s people. Try another pace or more people.', leftOut };
  const trimmed = new Set(fit.overflow);
  for (const id of trimmed) leftOut.push(describe(id, 'No room by the end date, even at 500 new people a day'));
  const batches = fit.calendar.batches.map((b) => ({ ...b, flowId: flow.id }));
  const planned = people.filter((p) => !trimmed.has(p.id));
  const pace = fit.paces.find((p) => p.foId === fo.id)?.to ?? input.batchSize;
  const fingerprint = createHash('sha256').update(JSON.stringify({ c: c.id, fo: fo.id, flow, batches, pace, days: plan.days })).digest('hex');
  return { ok: true, preview: { fingerprint, fo: { id: fo.id, name: fo.name }, pace, requested: input.batchSize, flow, batches, people: planned, leftOut } };
}

function uniqueFlowId(stored: Stored, wanted: string) {
  const taken = new Set(stored.flows.map((f) => f.id));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) if (!taken.has(`${wanted}-${n}`)) return `${wanted}-${n}`;
}

const json = (data: unknown) => JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue;

/**
 * Add the reviewed FO: planned again inside one transaction, under the locks publishing and launch
 * use, and refused if anything moved since the review. Then only the new people are put into
 * outreach; the first steps due today are made at once.
 */
export async function applyAddFo(user: SessionUser, campaignId: string, input: AddFoInput, fingerprint: string, options: { now?: Date; skipSync?: boolean } = {}) {
  const initial = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, select: { id: true } });
  const companies = await prisma.personCache.findMany({ where: { id: { in: input.personIds } }, select: { companyId: true } });
  const created = await prisma.$transaction(async (tx) => {
    await lockAccounts(tx, companies.map((p) => p.companyId));
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('campaign-planner-publication'))`;
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${initial.id}`}))`;
    const r = await planAddFo(user, campaignId, input, options, tx);
    if (!r.ok) throw new Error(r.error);
    if (r.preview.fingerprint !== fingerprint) throw new Error('The plan changed since you reviewed it, for example someone joined another campaign. Review it again.');
    const { preview } = r;
    const c = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const stored = c.plannerDraft as unknown as Stored;
    const plan = c.publishedPlan as unknown as PublishedCalendar;
    const fo = await tx.user.findUniqueOrThrow({ where: { id: preview.fo.id }, select: { id: true, name: true, twentyMemberId: true } });
    const sequenceIds = { ...plan.sequenceIds };
    const flows = [...stored.flows];
    if (preview.flow.created) {
      const steps = preview.flow.steps.map((s) => ({ ...s, actions: s.actions.map((a) => ({ ...a, ...(a.bodyHtml ? { bodyHtml: cleanRichText(a.bodyHtml) } : {}) })) }));
      const sequence = await tx.sequence.create({ data: { name: preview.flow.name, campaignOwned: true, steps: json(steps) } });
      sequenceIds[preview.flow.id] = sequence.id;
      flows.push({ id: preview.flow.id, name: preview.flow.name, steps: preview.flow.steps });
    }
    const newIds = preview.people.map((p) => p.id);
    const assignments = preview.flow.created ? Object.fromEntries(newIds.map((id) => [id, preview.flow.id])) : {};
    const pins = Object.fromEntries(preview.people.filter((p) => !p.ownerMemberId).map((p) => [p.id, fo.id]));
    // An FO left off at publish may still be in the request, with some of these people: each appears once.
    const grow = (d: CampaignDraft, batchSize: number): CampaignDraft => ({ ...d, fos: [...d.fos.filter((f) => f.id !== fo.id), { id: fo.id, batchSize }], personIds: [...new Set([...d.personIds, ...newIds])], assignments: { ...d.assignments, ...assignments }, foAssignments: { ...(d.foAssignments ?? {}), ...pins } });
    const draft = { ...grow(stored, preview.pace), flows, sequenceIds, ...(stored.request ? { request: grow(stored.request, preview.requested) } : {}) };
    const published = { ...plan, fos: [...plan.fos, { id: fo.id, name: fo.name, twentyMemberId: fo.twentyMemberId }], people: [...plan.people, ...preview.people], batches: [...plan.batches, ...preview.batches], sequenceIds };
    await tx.campaign.update({ where: { id: c.id }, data: { personIds: [...new Set([...c.personIds, ...newIds])], plannerDraft: json(draft), publishedPlan: json(published) } });
    const people = await tx.personCache.findMany({ where: { id: { in: newIds } }, select: { id: true, companyId: true } });
    const company = new Map(people.map((p) => [p.id, p.companyId]));
    const rows = preview.batches.flatMap((b) => b.personIds.map((personId) => ({ personId, companyId: company.get(personId) ?? null, campaignId: c.id, campaignRun: c.runNumber, foUserId: fo.id, podId: c.podId, sequenceId: sequenceIds[b.flowId], startDate: b.dates[0], scheduleDates: b.dates, createdById: user.id, status: 'ACTIVE' as const })));
    await tx.enrollment.createMany({ data: rows });
    await logAudit({ entityType: 'campaign', entityId: c.id, action: 'fo_added', actor: userActor(user), details: { foUserId: fo.id, people: newIds.length, batches: preview.batches.length, pace: preview.pace, ownOutreach: preview.flow.created } }, tx);
    return tx.enrollment.findMany({ where: { campaignId: c.id, foUserId: fo.id, personId: { in: newIds } }, select: { id: true } });
  }, { timeout: 60000 });
  for (const e of created) await advanceEnrollment(e.id, { actor: userActor(user), now: options.now, skipSync: options.skipSync });
  return { enrolled: created.length };
}
