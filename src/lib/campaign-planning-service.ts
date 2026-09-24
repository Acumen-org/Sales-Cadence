import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma, type Tx } from './db';
import type { SessionUser } from './auth/current-user';
import { canManageCampaigns, canApproveCampaign, ROLES_NEEDING_POD } from './auth/rbac';
import { campaignAudienceIssues, type AudienceIssueKind } from './campaign-audience';
import { cachedPersonName } from './person-cache';
import { cleanRichText } from './rich-text';
import { CampaignDraftSaveSchema, CampaignDraftSchema, calendarDays, dateRangeLabel, outreachIsAutomatic, shortDateLabel, suggestCampaignCalendar, type CalendarSuggestion, type CampaignDraft, type CampaignCalendar, type PlanIssue, type PlannerPerson } from './campaign-planner';
import { fitCampaign, isFit, type CampaignFit, type FitPace, type FitProblem } from './campaign-fit';
import { outreachRecipe } from './campaign-starter';
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
  /** For a plan that cannot be made: whether People (audience, dates) or Outreach has to change. */
  stage: 'people' | 'outreach' | null;
};

/** "Alyssa", "Alyssa and Avani", "Alyssa, Avani and Rahul". */
export const nameList = (names: string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How often steps go out, in words: "one each working day", "one a week", "one every 3 days". */
export const spacingInWords = (gap: number) => gap === 1 ? 'one each working day' : gap === 7 ? 'one a week' : gap % 7 === 0 ? `one every ${gap / 7} weeks` : `one every ${gap} days`;

/** What a built outreach sends, in words ("2 steps, one a week"), grouped by the FOs who send the same. */
export function outreachInWords(draft: Pick<CampaignDraft, 'flows' | 'fos'>, fos: { id: string; name: string }[]) {
  const words = (flow: CampaignDraft['flows'][number]) => {
    const n = flow.steps.length, gap = n > 1 ? flow.steps[1].day - flow.steps[0].day : 0;
    const even = flow.steps.every((s, i) => i === 0 || s.day - flow.steps[i - 1].day === gap);
    return { steps: n === 1 ? '1 step' : `${n} steps`, spacing: n > 1 && even ? spacingInWords(gap) : '' };
  };
  const byFo = draft.fos.map(f => ({ name: fos.find(x => x.id === f.id)?.name ?? 'FO', ...words(draft.flows.find(x => x.id === `fo-${f.id}`) ?? draft.flows[0]) }));
  const text = (f: { steps: string; spacing: string }) => f.spacing ? `${f.steps}, ${f.spacing}` : f.steps;
  return [...new Set(byFo.map(text))].map(t => { const same = byFo.filter(f => text(f) === t); return { names: same.map(f => f.name), text: t, steps: same[0].steps, spacing: same[0].spacing }; });
}

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

  const result = people.length ? fitCampaign(target, people, fos, { reshapeOutreach: options.reshapeOutreach }) : null;
  const fit = isFit(result) ? result : null;
  const endLabel = shortDateLabel(intent.endDate, true, intent.startDate.slice(0, 4) !== intent.endDate.slice(0, 4));
  const days = calendarDays(intent.startDate, intent.endDate);
  const keepsAll = (r: ReturnType<typeof fitCampaign>): r is CampaignFit => isFit(r) && r.overflow.length === 0 && r.droppedFos.every(d => d.personIds.length === 0);
  const fitted = (d: CampaignDraft, reshape: boolean) => { const r = fitCampaign({ ...d, personIds: target.personIds }, people, fos, { reshapeOutreach: reshape, allowTrim: false }); return keepsAll(r) ? r : null; };
  const verified = (d: CampaignDraft, reshape: boolean) => fitted(d, reshape)?.calendar ?? null;
  /** Verified ways to take everyone reachable, as the request Apply makes: the studio's own outreach, spacing, leaving an FO off, then dates. */
  const alternatives = (leaveOff: { foId: string; name: string }[] = []): CalendarSuggestion[] => {
    const out: CalendarSuggestion[] = [];
    if (!options.reshapeOutreach) {
      const auto: CampaignDraft = { ...team, flows: [{ id: 'default', name: 'Default', steps: outreachRecipe(1) }], assignments: {}, outreachEdited: false };
      const built = fitted(auto, true);
      if (built) {
        const groups = outreachInWords(built.draft, fos), fits = `${target.personIds.length === 1 ? 'The 1 person fits' : `All ${target.personIds.length} people fit`} by ${endLabel}.`;
        // One group: what it sends. Several on one spacing: say the spacing once, then who sends how many.
        const sends = (g: typeof groups[number], what: string) => `${nameList(g.names)} ${g.names.length > 1 ? 'send' : 'sends'} ${what}`;
        const oneSpacing = groups[0].spacing && groups.every(g => g.spacing === groups[0].spacing);
        const detail = groups.length === 1 ? `It sends ${groups[0].text}. ${fits}`
          : oneSpacing ? `${groups[0].spacing.replace(/^one /, 'One step ')}. ${fits} ${groups.map(g => sends(g, g.steps)).join('; ')}.`
          : `${fits} ${groups.map(g => sends(g, g.text)).join('; ')}.`;
        out.push({ label: 'Let the studio set the outreach', detail, draft: auto, calendar: built.calendar, studio: true });
      }
    }
    for (const fo of leaveOff) {
      const member = fos.find(f => f.id === fo.foId)?.twentyMemberId;
      const rest = people.filter(p => !member || p.ownerMemberId !== member);
      const without = { ...team, fos: team.fos.filter(f => f.id !== fo.foId) };
      const r = without.fos.length && rest.length ? fitCampaign({ ...without, personIds: rest.map(p => p.id) }, rest, fos, { reshapeOutreach: options.reshapeOutreach, allowTrim: false }) : null;
      const waiting = people.length - rest.length;
      if (isFit(r)) out.push({ label: `Take ${fo.name} off this campaign`, detail: waiting ? `${fo.name}'s ${plural(waiting, 'person', 'people')} ${waiting === 1 ? 'stays' : 'stay'} free for another campaign.` : 'Everyone stays in.', draft: without, calendar: r.calendar });
    }
    const rest = suggestCampaignCalendar(team, people, fos, { paces: false, outreach: !options.reshapeOutreach, verify: d => verified(d, options.reshapeOutreach) });
    return [...out, ...rest].slice(0, 3).map(x => ({ ...x, draft: { ...x.draft, personIds: intent.personIds, outreachEdited: x.draft.outreachEdited ?? intent.outreachEdited } }));
  };
  const droppedFos = gone.map(f => ({ id: f.id, name: goneNames.get(f.id) ?? 'Former FO', reason: 'no longer in this pod' }));
  if (fit) {
    // The same shape whichever way it was reached (a built outreach or the edited one it became),
    // so the fingerprint a review shows is the one publishing recomputes.
    fit.draft = CampaignDraftSchema.parse(fit.draft);
    for (const id of fit.overflow) leftOut.push(describe(id, 'dates', `No room by ${endLabel}, even at 500 new people a day`));
    for (const fo of fit.droppedFos) {
      droppedFos.push({ id: fo.id, name: fo.name, reason: fo.reason === 'few' ? 'too few people to fill every working day' : 'they own none of the people you picked' });
      for (const id of fo.personIds) leftOut.push(describe(id, 'fo', `Owned by ${fo.name}, who is not in this plan`));
    }
    const trimmed = fit.overflow.length > 0 || fit.droppedFos.some(f => f.personIds.length > 0);
    const suggestions = fit.overflow.length && !options.forPublish ? alternatives() : [];
    // Another step is offered while one more, at the tightest spacing, still takes everyone.
    const limits = options.forPublish ? {} : Object.fromEntries(fit.draft.flows.map((flow, i) => {
      const n = flow.steps.length;
      if (trimmed || n >= Math.min(60, days.length)) return [flow.id, n];
      if (i >= 5) return [flow.id, n + 1];
      const last = flow.steps.at(-1)!;
      const longer = fit.draft.flows.map(f => f.id === flow.id ? { ...f, steps: [...f.steps, { ...structuredClone(last), id: `${last.id}-next`, day: last.day + 1 }] } : f);
      return [flow.id, keepsAll(fitCampaign({ ...team, flows: longer, assignments: fit.draft.assignments, personIds: target.personIds }, people, fos, { reshapeOutreach: false, allowTrim: false })) ? n + 1 : n];
    }));
    return { draft: fit.draft, calendar: fit.calendar, fingerprint: calendarFingerprint(fit.draft, fit.calendar), paces: fit.paces, leftOut, droppedFos, limits, suggestions, stage: null };
  }
  // No plan: say exactly what stands in the way, each reason once with everyone it applies to.
  const problems: FitProblem[] = result && !isFit(result) ? result.problems : [];
  const by = (reason: FitProblem['reason']) => problems.filter(p => p.reason === reason);
  const planIssues: PlanIssue[] = [];
  let stage: CampaignPlan['stage'] = 'people';
  const range = dateRangeLabel(intent.startDate, intent.endDate);
  if (!people.length) planIssues.push({ title: 'None of the people you picked can be in this campaign.', detail: 'Each one is listed with the reason in People.', kind: 'people' });
  else if (!days.length) planIssues.push({ title: intent.startDate === intent.endDate ? `${range} is not a working day.` : `There are no working days from ${range}.`, detail: 'Outreach goes out Monday to Friday only.', kind: 'people' });
  else if (problems.length) {
    stage = 'outreach';
    const window = by('window'), few = by('few'), many = by('many'), search = by('search');
    const who = (list: FitProblem[]) => list.length < team.fos.length ? ` This affects ${nameList(list.map(p => p.name))}.` : '';
    if (window.length) planIssues.push({ title: `The steps run past ${endLabel}.`, detail: `Even starting on the first day, the last step would go out too late.${who(window)}`, kind: 'window' });
    if (few.length) planIssues.push({ title: `${nameList(few.map(p => p.name))} ${few.length > 1 ? "don't" : "doesn't"} have enough people to fill every working day.`, detail: 'Add steps, or pick more people.', kind: 'few' });
    if (many.length) planIssues.push({ title: `${nameList(many.map(p => p.name))} would need more than 500 new people a day.`, detail: 'Choose a later end date, or remove steps.', kind: 'many' });
    if (search.length) planIssues.push({ title: `${nameList(search.map(p => p.name))} would have working days with nothing to send.`, detail: 'The waits between steps leave gaps. Every FO needs something to send each working day.', kind: 'search' });
  } else planIssues.push({ title: `There aren't enough people to fill every working day from ${range}.`, detail: 'Pick more people, or choose a shorter date range.', kind: 'people' });
  const suggestions = stage === 'outreach' && !options.forPublish ? alternatives(by('few')) : [];
  const calendar: CampaignCalendar = { version: 1, days, batches: [], people, fos, issues: planIssues, valid: false, exhausted: false };
  return { draft: target, calendar, fingerprint: calendarFingerprint(target, calendar), paces: [], leftOut, droppedFos, limits: Object.fromEntries(intent.flows.map(f => [f.id, Math.min(60, days.length)])), suggestions, stage };
}

export async function previewCampaignCalendar(input: unknown, user: SessionUser, campaignId?: string) {
  return planCampaign(input, user, campaignId, { reshapeOutreach: outreachIsAutomatic(CampaignDraftSchema.parse(input), campaignId) });
}

export async function prepareCampaignStudio(input: unknown, user: SessionUser, campaignId?: string, fit = false) {
  const draft = CampaignDraftSchema.parse(input);
  if (draft.startDate < todayIn(workspaceTimezone())) throw new Error(`The start date, ${shortDateLabel(draft.startDate)}, is in the past. Choose today or a later date.`);
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
  const automatic = outreachIsAutomatic(CampaignDraftSchema.parse(input), options.id);
  const checked = await planCampaign(input, user, options.id, { reshapeOutreach: automatic, forPublish: true });
  const request = CampaignDraftSchema.parse(input);
  if (checked.draft.startDate < todayIn(workspaceTimezone())) throw new Error('The start date is in the past. Choose today or a later date.');
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
    const fresh = await planCampaign(input, user, options.id, { reshapeOutreach: automatic, forPublish: true }, tx);
    const d = fresh.draft;
    if (!fresh.calendar.valid || fresh.fingerprint !== options.fingerprint) throw new Error('The plan changed since you last looked, for example a contact was updated in Twenty or another campaign took someone. Check the new plan, then publish again.');
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
