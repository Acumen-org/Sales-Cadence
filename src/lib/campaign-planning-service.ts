import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma, type Tx } from './db';
import type { SessionUser } from './auth/current-user';
import { canManageCampaigns, canApproveCampaign, ROLES_NEEDING_POD } from './auth/rbac';
import { campaignAudienceIssues, type AudienceIssueKind } from './campaign-audience';
import { cachedPersonName } from './person-cache';
import { cleanRichText } from './rich-text';
import { CampaignDraftSaveSchema, CampaignDraftSchema, buildCampaignCalendar, calendarDays, shortDateLabel, suggestCampaignCalendar, type CalendarSuggestion, type CampaignDraft, type CampaignCalendar, type PlannerPerson } from './campaign-planner';
import { fitCampaign, type CampaignFit, type FitPace } from './campaign-fit';
import { logAudit, userActor } from './audit';
import { todayIn } from './dates';
import { workspaceTimezone } from './workspace';
import { lockAccounts } from './account-lock';
import { nonReplierCandidates } from './campaigns-query';
import { defaultTwentySchema } from './twenty/twenty-schema';

export type PublishedCalendar = CampaignCalendar & { sequenceIds: Record<string, string> };
/** Someone selected who is not in the plan: the audience check's reason, the follow-up rule, or a fit the planner could not make. */
export type LeftOut = { id: string; name: string; company: string | null; kind: AudienceIssueKind | 'followup' | 'dates' | 'fo'; reason: string; ownerId?: string };
export type CampaignPlan = {
  /** The draft the calendar was built from: planned people, fitted paces, pinned owners. */
  draft: CampaignDraft;
  calendar: CampaignCalendar;
  fingerprint: string;
  paces: FitPace[];
  leftOut: LeftOut[];
  /** Selected FOs the plan leaves off, and why. */
  droppedFos: { id: string; name: string; reason: string }[];
  limits: Record<string, number>;
  suggestions: CalendarSuggestion[];
};

const json = (data: unknown) => JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue;
export const calendarFingerprint = (draft: CampaignDraft, calendar: CampaignCalendar) => createHash('sha256').update(JSON.stringify({ draft, calendar })).digest('hex');

/**
 * Plans a campaign from what its owner asked for. People who cannot be reached are left out with
 * their reason instead of failing the whole plan; paces (and an unedited outreach) are fitted by
 * `fitCampaign`. Only a plan the planner cannot make at all comes back invalid, with its issues and
 * suggestions verified the same way.
 */
export async function planCampaign(input: unknown, user: SessionUser, campaignId: string | undefined, options: { reshapeOutreach: boolean; forPublish?: boolean }, db: Tx = prisma): Promise<CampaignPlan> {
  const intent = CampaignDraftSchema.parse(input);
  if (intent.productInterest.some(p => !(defaultTwentySchema.personValues.productInterest as readonly string[]).includes(p))) throw new Error('Choose an available product.');
  if (!canManageCampaigns(user, intent.podId)) throw new Error('You cannot manage campaigns for this pod.');
  const pod = await db.pod.findUnique({ where: { id: intent.podId } });
  if (!pod || pod.archived) throw new Error('Choose an available pod.');
  const fos = await db.user.findMany({ where: { id: { in: intent.fos.map(f => f.id) }, active: true, role: { in: ROLES_NEEDING_POD }, pods: { some: { podId: pod.id } } }, select: { id: true, name: true, twentyMemberId: true }, orderBy: { id: 'asc' } });
  const gone = intent.fos.filter(f => !fos.some(x => x.id === f.id));
  const goneNames = gone.length ? new Map((await db.user.findMany({ where: { id: { in: gone.map(f => f.id) } }, select: { id: true, name: true } })).map(u => [u.id, u.name])) : new Map<string, string>();
  const team = { ...intent, fos: intent.fos.filter(f => fos.some(x => x.id === f.id)) };
  if (!team.fos.length) throw new Error('Select at least one FO who works in this pod.');

  const issues = await campaignAudienceIssues(intent.personIds, { podId: pod.id, podOwnerValue: pod.podOwnerValue, podName: pod.name, ownerMemberIds: fos.flatMap(f => f.twentyMemberId ? [f.twentyMemberId] : []), campaignId, checkOwners: true }, db);
  const leftOut: LeftOut[] = [...issues];
  const excluded = new Set(issues.map(i => i.id));
  const existing = campaignId ? await db.campaign.findUnique({ where: { id: campaignId }, select: { followupSourceId: true, followupWaitDays: true, followupSourceRun: true } }) : null;
  if (existing?.followupSourceId) {
    const eligible = new Set((await nonReplierCandidates(existing.followupSourceId, existing.followupWaitDays, new Date(), existing.followupSourceRun ?? undefined)).map(e => e.personId));
    for (const id of intent.personIds) if (!excluded.has(id) && !eligible.has(id)) { excluded.add(id); leftOut.push({ id, name: '', company: null, kind: 'followup', reason: 'No longer qualifies for this follow-up' }); }
  }
  const reachable = intent.personIds.filter(id => !excluded.has(id));
  const rows = await db.personCache.findMany({ where: { id: { in: [...reachable, ...leftOut.filter(l => !l.name).map(l => l.id)] } }, orderBy: { id: 'asc' } });
  const byId = new Map(rows.map(p => [p.id, p]));
  for (const l of leftOut) if (!l.name) { const r = byId.get(l.id); l.name = r ? cachedPersonName(r) : 'Unknown contact'; l.company = r?.companyName ?? null; }
  const target = { ...team, personIds: reachable.filter(id => byId.has(id)) };
  const people: PlannerPerson[] = target.personIds.map(id => { const p = byId.get(id)!; return { id: p.id, name: cachedPersonName(p), ownerMemberId: p.ownerMemberId, tags: p.tags, contactType: p.contactType, tier: p.tier }; });
  const describe = (id: string, kind: LeftOut['kind'], reason: string): LeftOut => { const p = byId.get(id); return { id, name: p ? cachedPersonName(p) : 'Unknown contact', company: p?.companyName ?? null, kind, reason }; };

  const fitOptions = { reshapeOutreach: options.reshapeOutreach };
  const fit = people.length ? fitCampaign(target, people, fos, fitOptions) : null;
  // A suggestion for an outreach nobody has edited reshapes it too; say how long it would be.
  const withSteps = (s: CalendarSuggestion): CalendarSuggestion => {
    const n = s.calendar.batches[0]?.dates.length;
    return options.reshapeOutreach && !s.draft.outreachEdited && n ? { ...s, detail: s.detail ? `${s.detail.replace(/\.$/, '')}, with ${n} step${n === 1 ? '' : 's'}.` : `${n} step${n === 1 ? '' : 's'}` } : s;
  };
  const asRequest = (s: CalendarSuggestion) => withSteps({ ...s, draft: { ...s.draft, personIds: intent.personIds, outreachEdited: intent.outreachEdited || s.draft.flows !== team.flows } });
  /** Changes that would keep every reachable person, each verified: a faster pace first (the owner's to give), then spacing, then dates. */
  const keepEveryone = (): CalendarSuggestion[] => {
    const keepsAll = (f: CampaignFit | null) => !!f && f.droppedFos.every(d => d.personIds.length === 0);
    const paceText = (f: CampaignFit) => f.paces.filter(p => p.to !== p.from).map(p => `${p.name} ${p.from} → ${p.to} new a day`).join(' · ');
    // The pace an FO would need, found with no ceiling, then checked as the request Apply will make.
    const faster = fitCampaign(target, people, fos, { ...fitOptions, allowTrim: false, ceiling: () => 500 });
    const offer = faster && { ...team, fos: team.fos.map(f => ({ ...f, batchSize: faster.paces.find(p => p.foId === f.id)?.to ?? f.batchSize })) };
    const checked = offer ? fitCampaign({ ...offer, personIds: target.personIds }, people, fos, { ...fitOptions, allowTrim: false }) : null;
    // Labelled from the checked plan, against the paces asked for: what Apply will actually run.
    const offerText = checked ? paceText({ ...checked, paces: checked.paces.map(p => ({ ...p, from: team.fos.find(f => f.id === p.foId)?.batchSize ?? p.from })) }) : '';
    const pace = offer && checked && keepsAll(checked) && offerText ? [asRequest({ label: offerText, detail: '', draft: offer, calendar: checked.calendar })] : [];
    const fits = new Map<CampaignDraft, CampaignFit>();
    const rest = suggestCampaignCalendar(team, people, fos, { paces: false, outreach: !options.reshapeOutreach, verify: d => { const f = fitCampaign({ ...d, personIds: target.personIds }, people, fos, { ...fitOptions, allowTrim: false }); if (f && keepsAll(f)) { fits.set(d, f); return f.calendar; } return null; } })
      .map(s => { const f = fits.get(s.draft); return asRequest({ ...s, detail: [s.detail, f ? paceText(f) : ''].filter(Boolean).join(' · ') }); });
    return [...pace, ...rest].slice(0, 3);
  };
  const droppedFos = gone.map(f => ({ id: f.id, name: goneNames.get(f.id) ?? 'An FO', reason: 'no longer in this pod' }));
  if (fit) {
    // The same shape whichever way it was reached (a reshaped starter or the edited outreach it
    // became), so the fingerprint a review shows is the one publishing recomputes.
    fit.draft = CampaignDraftSchema.parse(fit.draft);
    for (const id of fit.overflow) leftOut.push(describe(id, 'dates', `Did not fit by ${shortDateLabel(intent.endDate)}`));
    for (const fo of fit.droppedFos) {
      droppedFos.push({ id: fo.id, name: fo.name, reason: fo.reason === 'few' ? 'too few contacts to fill every working day' : 'no contacts in this audience' });
      for (const id of fo.personIds) leftOut.push(describe(id, 'fo', `${fo.name} has too few contacts to fill every working day`));
    }
    const days = calendarDays(fit.draft.startDate, fit.draft.endDate).length;
    const trimmed = fit.overflow.length > 0 || fit.droppedFos.some(f => f.personIds.length > 0);
    const suggestions = trimmed && !options.forPublish ? keepEveryone() : [];
    // Another step is offered only while one more, at the tightest spacing, still keeps everyone.
    const limits = options.forPublish ? {} : Object.fromEntries(fit.draft.flows.map((flow, i) => {
      const n = flow.steps.length;
      if (trimmed || n >= Math.min(60, days)) return [flow.id, n];
      if (i >= 5) return [flow.id, n + 1];
      const last = flow.steps.at(-1)!;
      const longer = fit.draft.flows.map(f => f.id === flow.id ? { ...f, steps: [...f.steps, { ...structuredClone(last), id: `${last.id}-next`, day: last.day + 1 }] } : f);
      return [flow.id, fitCampaign({ ...team, flows: longer, assignments: fit.draft.assignments, personIds: target.personIds }, people, fos, { reshapeOutreach: false, allowTrim: false }) ? n + 1 : n];
    }));
    return { draft: fit.draft, calendar: fit.calendar, fingerprint: calendarFingerprint(fit.draft, fit.calendar), paces: fit.paces, leftOut, droppedFos, limits, suggestions };
  }
  // Nothing fits even after pacing, reshaping and trimming: explain with the planner's own issues.
  const calendar = buildCampaignCalendar(target, people, fos, 20000);
  if (!people.length) calendar.issues = [{ title: 'None of the selected people can be reached.', detail: 'Each one is listed with the reason.' }];
  const suggestions = people.length && !options.forPublish ? suggestCampaignCalendar(team, people, fos, { paces: false, verify: d => fitCampaign({ ...d, personIds: target.personIds }, people, fos, fitOptions)?.calendar ?? null }).map(asRequest) : [];
  const days = calendarDays(intent.startDate, intent.endDate).length;
  return { draft: target, calendar, fingerprint: calendarFingerprint(target, calendar), paces: [], leftOut, droppedFos, limits: Object.fromEntries(intent.flows.map(f => [f.id, Math.min(60, days)])), suggestions };
}

export async function previewCampaignCalendar(input: unknown, user: SessionUser, campaignId?: string) {
  return planCampaign(input, user, campaignId, { reshapeOutreach: false });
}

export async function prepareCampaignStudio(input: unknown, user: SessionUser, campaignId?: string, fit = false) {
  const draft = CampaignDraftSchema.parse(input);
  if (draft.startDate < todayIn(workspaceTimezone())) throw new Error('Choose a current or future start date.');
  if (!draft.personIds.length) throw new Error('Select the people for this campaign.');
  return planCampaign(draft, user, campaignId, { reshapeOutreach: fit });
}

async function saveDraft(input: unknown, user: SessionUser, options: { id?: string; revision?: string; auto?: boolean }) {
  const d = CampaignDraftSaveSchema.parse(input);
  if (!canManageCampaigns(user, d.podId)) throw new Error('You cannot manage campaigns for this pod.');
  const pod = await prisma.pod.findUnique({ where: { id: d.podId } });
  if (!pod || pod.archived) throw new Error('Choose an available pod.');
  const id = options.id ?? randomUUID();
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${id}`}))`;
    const existing = await tx.campaign.findUnique({ where: { id } });
    if (options.id && !existing) throw new Error('Campaign no longer exists.');
    if (existing) {
      if (!canManageCampaigns(user, existing.podId)) throw new Error('You cannot edit this campaign.');
      if (!['DRAFT', 'SCHEDULED', 'PENDING_APPROVAL'].includes(existing.status) || await tx.enrollment.count({ where: { campaignId: id } })) throw new Error('This campaign has already started. Its plan is locked.');
      if (existing.updatedAt.toISOString() !== options.revision) throw new Error('Someone changed this campaign. Reload before saving to protect their changes.');
    }
    const sequenceIds = await saveFlows(tx, d.flows, existing?.plannerDraft);
    // A follow-up waiting for review already reserves its people, so it holds only those who can be in it.
    let personIds = d.personIds;
    if (existing?.followupSourceId) {
      const qualifying = new Set((await nonReplierCandidates(existing.followupSourceId, existing.followupWaitDays, new Date(), existing.followupSourceRun ?? undefined)).map(e => e.personId));
      const fos = await tx.user.findMany({ where: { id: { in: d.fos.map(f => f.id) }, active: true, pods: { some: { podId: pod.id } } }, select: { twentyMemberId: true } });
      const ownerMemberIds = fos.flatMap(f => f.twentyMemberId ? [f.twentyMemberId] : []);
      const blocked = new Set((await campaignAudienceIssues(d.personIds, { podId: pod.id, podOwnerValue: pod.podOwnerValue, podName: pod.name, ownerMemberIds, campaignId: id, checkOwners: ownerMemberIds.length > 0 }, tx)).map(i => i.id));
      personIds = d.personIds.filter(p => !blocked.has(p) && qualifying.has(p));
    }
    const data = {
      name: d.name, podId: d.podId, startDate: d.startDate, endDate: d.endDate, personIds,
      productInterest: d.productInterest, startsPerFoPerDay: d.defaultBatchSize || null, sequenceId: sequenceIds.default,
      plannerDraft: json({ ...d, sequenceIds }), publishedPlan: Prisma.DbNull,
      status: existing?.followupSourceId ? 'PENDING_APPROVAL' as const : 'DRAFT' as const, hardStopAtEnd: true, approvedAt: null, approvedById: null,
    };
    const campaign = existing ? await tx.campaign.update({ where: { id }, data }) : await tx.campaign.create({ data: { id, ...data, createdById: user.id } });
    await dropStaleFlows(tx, existing?.plannerDraft, sequenceIds);
    if (!options.auto || !existing) await logAudit({ entityType: 'campaign', entityId: id, action: 'draft_saved', actor: userActor(user), details: { people: d.personIds.length } }, tx);
    return campaign;
  }, { timeout: 60000 });
}

type SavedDraft = { sequenceIds?: Record<string, string> } | null;
async function saveFlows(tx: Tx, flows: CampaignDraft['flows'], previous: Prisma.JsonValue | null | undefined) {
  const oldIds = (previous as SavedDraft)?.sequenceIds ?? {};
  const sequenceIds: Record<string, string> = {};
  for (const flow of flows) {
    const steps = flow.steps.map(s => ({ ...s, actions: s.actions.map(a => ({ ...a, ...(a.bodyHtml ? { bodyHtml: cleanRichText(a.bodyHtml) } : {}) })) }));
    const data = { name: flow.id === 'default' ? 'Default' : flow.name || 'Custom outreach', campaignOwned: true, steps: json(steps) };
    const owned = oldIds[flow.id] ? await tx.sequence.findFirst({ where: { id: oldIds[flow.id], campaignOwned: true } }) : null;
    const sequence = owned ? await tx.sequence.update({ where: { id: owned.id }, data }) : await tx.sequence.create({ data });
    sequenceIds[flow.id] = sequence.id;
  }
  return sequenceIds;
}
async function dropStaleFlows(tx: Tx, previous: Prisma.JsonValue | null | undefined, sequenceIds: Record<string, string>) {
  const oldIds = (previous as SavedDraft)?.sequenceIds ?? {};
  await tx.sequence.deleteMany({ where: { id: { in: Object.values(oldIds).filter(id => !Object.values(sequenceIds).includes(id)) }, campaignOwned: true, campaigns: { none: {} }, enrollments: { none: {} } } });
}

export async function saveCampaignCalendar(input: unknown, user: SessionUser, options: { id?: string; revision?: string; publish?: boolean; fingerprint?: string; auto?: boolean }) {
  if (!options.publish) return saveDraft(input, user, options);
  const checked = await planCampaign(input, user, options.id, { reshapeOutreach: false, forPublish: true });
  const request = CampaignDraftSchema.parse(input);
  if (checked.draft.startDate < todayIn(workspaceTimezone())) throw new Error('The start date has passed. Choose a current or future start date and review the calendar.');
  const id = options.id ?? randomUUID();
  return prisma.$transaction(async tx => {
    const companies = await tx.personCache.findMany({ where: { id: { in: checked.draft.personIds } }, select: { companyId: true } });
    await lockAccounts(tx, companies.map(p => p.companyId));
    // All planner publications reserve membership atomically, even across different campaigns.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('campaign-planner-publication'))`;
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${id}`}))`;
    const existing = await tx.campaign.findUnique({ where: { id } });
    if (options.id && !existing) throw new Error('Campaign no longer exists.');
    if (existing) {
      if (!canManageCampaigns(user, existing.podId)) throw new Error('You cannot edit this campaign.');
      if (existing.followupSourceId && !canApproveCampaign(user, checked.draft.podId)) throw new Error('A Sales Leader, Pod Manager or admin must review and publish this follow-up campaign.');
      if (!['DRAFT', 'SCHEDULED', 'PENDING_APPROVAL'].includes(existing.status) || await tx.enrollment.count({ where: { campaignId: id } })) throw new Error('This campaign has already started. Its plan is locked.');
      if (existing.updatedAt.toISOString() !== options.revision) throw new Error('Someone changed this campaign. Reload before saving to protect their changes.');
    }
    const fresh = await planCampaign(input, user, options.id, { reshapeOutreach: false, forPublish: true }, tx);
    const d = fresh.draft;
    if (!fresh.calendar.valid || fresh.fingerprint !== options.fingerprint) throw new Error('The plan changed after your last review: a CRM detail or another campaign moved. Check the updated plan, then publish again.');
    const sequenceIds = await saveFlows(tx, d.flows, existing?.plannerDraft);
    const data = {
      name: d.name, podId: d.podId, startDate: d.startDate, endDate: d.endDate, personIds: d.personIds,
      productInterest: d.productInterest, startsPerFoPerDay: d.defaultBatchSize, sequenceId: sequenceIds.default,
      // The plan is what runs and what every page counts; the request is what the editor reopens,
      // so a later change of dates or team can bring back anyone this plan left out.
      plannerDraft: json({ ...d, sequenceIds, request }), publishedPlan: json({ ...fresh.calendar, sequenceIds }),
      status: 'SCHEDULED' as const, hardStopAtEnd: true, approvedAt: new Date(), approvedById: user.id,
    };
    const campaign = existing ? await tx.campaign.update({ where: { id }, data }) : await tx.campaign.create({ data: { id, ...data, createdById: user.id } });
    await dropStaleFlows(tx, existing?.plannerDraft, sequenceIds);
    await logAudit({ entityType: 'campaign', entityId: id, action: 'calendar_published', actor: userActor(user), details: { people: d.personIds.length, batches: fresh.calendar.batches.length, leftOut: fresh.leftOut.length } }, tx);
    return campaign;
  }, { timeout: 60000 });
}
