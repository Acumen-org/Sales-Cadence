import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { campaignAudienceIssues } from '@/lib/campaign-audience';
import { outreachInWords, planCampaign, previewCampaignCalendar, saveCampaignCalendar } from '@/lib/campaign-planning-service';
import type { CampaignDraft } from '@/lib/campaign-planner';
import { outreachRecipe } from '@/lib/campaign-starter';
import { pickAllIdsAction, pickPeopleAction } from '@/lib/actions/people-picker';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.user, requireAdmin: auth.user, toActor: (user: SessionUser) => user }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

let b: Basics, admin: SessionUser;
const ids = ['aud-1', 'aud-2', 'aud-3', 'aud-4'];
const draft = (over: Partial<CampaignDraft> = {}): CampaignDraft => ({ name: 'Audience', podId: b.pods.Alisa.id, startDate: '2027-01-04', endDate: '2027-01-08', productInterest: ['PHH'], defaultBatchSize: 1, fos: [{ id: b.users.alisa.id, batchSize: 1 }], personIds: ids, assignments: {}, flows: [{ id: 'default', name: 'Default', steps: outreachRecipe(1) }], outreachEdited: false, ...over });
beforeEach(async () => {
  await resetDb(); b = await seedBasics(); admin = { ...b.users.ria, podIds: [], pods: [] }; auth.user.mockResolvedValue(admin);
  await prisma.personCache.createMany({ data: ids.map((id, i) => ({ id, firstName: 'Aud', lastName: String(i + 1), sortName: `aud ${i + 1}`, email: `${id}@prospect.example`, podOwner: 'ALISA', ownerMemberId: b.users.alisa.twentyMemberId })) });
});

describe('who a campaign can reach', () => {
  it('names each contact that cannot be reached with one short reason', async () => {
    await prisma.personCache.createMany({ data: [
      { id: 'dnd', firstName: 'Do', lastName: 'Not', podOwner: 'ALISA', dnd: true },
      { id: 'optout', firstName: 'Opted', lastName: 'Out', podOwner: 'ALISA', optedOut: true },
      { id: 'deleted', firstName: 'Gone', podOwner: 'ALISA', deletedAt: new Date() },
      { id: 'outside', firstName: 'Other', lastName: 'Pod', podOwner: 'ANDREW' },
      { id: 'karsons', firstName: 'Karson', lastName: 'Contact', podOwner: 'ALISA', ownerMemberId: b.users.karson.twentyMemberId },
      { id: 'andrews', firstName: 'Andrew', lastName: 'Contact', podOwner: 'ALISA', ownerMemberId: b.users.andrew.twentyMemberId },
      { id: 'seatless', firstName: 'No', lastName: 'Seat', podOwner: 'ALISA', ownerMemberId: 'wm-nobody' },
    ] });
    const context = { podId: b.pods.Alisa.id, podOwnerValue: 'ALISA', podName: 'Alisa', ownerMemberIds: [b.users.alisa.twentyMemberId!], checkOwners: true };
    const issues = await campaignAudienceIssues(['aud-1', 'dnd', 'optout', 'deleted', 'outside', 'karsons', 'andrews', 'seatless', 'missing'], context);
    const reason = Object.fromEntries(issues.map(i => [i.id, i.reason]));
    expect(reason).toEqual({ dnd: 'Do not contact', optout: 'Opted out', deleted: 'No longer in Twenty', outside: 'Not in the Alisa pod', karsons: `Owned by ${b.users.karson.name}`, andrews: `Owned by ${b.users.andrew.name}`, seatless: 'Owner is not a Cadence user', missing: 'No longer in Twenty' });
    // Karson works this pod and could be added; Andrew does not.
    expect(issues.find(i => i.id === 'karsons')?.ownerId).toBe(b.users.karson.id);
    expect(issues.find(i => i.id === 'andrews')?.ownerId).toBeUndefined();
    // A pod named the way Twenty labels it is not called a pod twice.
    expect((await campaignAudienceIssues(['outside'], { ...context, podName: "Alisa's pod" }))[0].reason).toBe("Not in Alisa's pod");
    // Before the team is chosen, ownership is not a reason yet.
    expect((await campaignAudienceIssues(['karsons'], { ...context, checkOwners: false }))).toEqual([]);
  });

  it('leaves out the unreachable and plans everyone else, then publishes only the planned people', async () => {
    await prisma.personCache.createMany({ data: [
      { id: 'aud-dnd', firstName: 'Aud', lastName: 'Dnd', podOwner: 'ALISA', ownerMemberId: b.users.alisa.twentyMemberId, dnd: true },
      ...['aud-k1', 'aud-k2', 'aud-k3', 'aud-k4'].map(id => ({ id, firstName: 'Aud', lastName: id, podOwner: 'ALISA', ownerMemberId: b.users.karson.twentyMemberId })),
    ] });
    const karsons = ['aud-k1', 'aud-k2', 'aud-k3', 'aud-k4'];
    const intent = draft({ personIds: [...ids, 'aud-dnd', ...karsons] });
    const plan = await planCampaign(intent, admin, undefined, { reshapeOutreach: true });
    expect(plan.calendar.valid).toBe(true);
    expect(plan.draft.personIds).toEqual(ids);
    expect(plan.leftOut.map(l => [l.id, l.kind])).toEqual([['aud-dnd', 'dnd'], ...karsons.map(id => [id, 'owner'])]);
    expect(plan.leftOut.find(l => l.kind === 'owner')?.ownerId).toBe(b.users.karson.id);
    // Adding the owner brings their contact into the plan.
    const withKarson = await planCampaign({ ...intent, fos: [...intent.fos, { id: b.users.karson.id, batchSize: 1 }] }, admin, undefined, { reshapeOutreach: true });
    expect(withKarson.leftOut.map(l => l.id)).toEqual(['aud-dnd']);
    const reviewed = { ...intent, flows: plan.draft.flows };
    const preview = await previewCampaignCalendar(reviewed, admin);
    // The plan from Next and the preview of the outreach it produced are one plan: publishing
    // straight after either must not report that it changed.
    expect(preview.fingerprint).toBe(plan.fingerprint);
    const c = await saveCampaignCalendar(reviewed, admin, { publish: true, fingerprint: plan.fingerprint });
    expect(c.status).toBe('SCHEDULED'); expect(c.personIds).toEqual(ids);
    // What runs is the plan; what the editor reopens is the request, left-out people included.
    const stored = c.plannerDraft as unknown as CampaignDraft & { request: CampaignDraft };
    expect(stored.personIds).toEqual(ids); expect(stored.request.personIds).toEqual(intent.personIds);
    // Once published they are held: another new campaign leaves them out as busy.
    expect((await planCampaign(intent, admin, undefined, { reshapeOutreach: true })).leftOut.find(l => l.id === 'aud-1')?.reason).toBe('Already in Audience');
  });

  it('fits the pace instead of refusing, and never moves the dates', async () => {
    const extra = Array.from({ length: 6 }, (_, i) => `aud-x${i}`);
    await prisma.personCache.createMany({ data: extra.map(id => ({ id, firstName: 'Aud', lastName: id, podOwner: 'ALISA', ownerMemberId: b.users.alisa.twentyMemberId })) });
    const plan = await planCampaign(draft({ personIds: [...ids, ...extra] }), admin, undefined, { reshapeOutreach: true });
    expect(plan.calendar.valid).toBe(true);
    expect(plan.paces).toEqual([{ foId: b.users.alisa.id, name: b.users.alisa.name, from: 1, to: 2 }]);
    expect([plan.draft.startDate, plan.draft.endDate]).toEqual(['2027-01-04', '2027-01-08']);
  });

  it('says why a selected FO is left off, and raises the pace instead of leaving anyone out', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `aud-m${i}`);
    await prisma.personCache.createMany({ data: many.map(id => ({ id, firstName: 'Aud', lastName: id, podOwner: 'ALISA', ownerMemberId: b.users.alisa.twentyMemberId })) });
    const plan = await planCampaign(draft({ personIds: [...ids, ...many], fos: [{ id: b.users.alisa.id, batchSize: 1 }, { id: b.users.karson.id, batchSize: 1 }] }), admin, undefined, { reshapeOutreach: true });
    expect(plan.calendar.valid).toBe(true);
    expect(plan.droppedFos).toEqual([{ id: b.users.karson.id, name: b.users.karson.name, reason: 'they own none of the people you picked' }]);
    expect(plan.leftOut).toEqual([]); expect(plan.draft.personIds).toHaveLength(16);
    expect(plan.paces).toEqual([{ foId: b.users.alisa.id, name: b.users.alisa.name, from: 1, to: 4 }]);
  });

  it('says once, in plain words, why an edited outreach cannot take everyone, and offers the studio’s own outreach first', async () => {
    const karsons = Array.from({ length: 4 }, (_, i) => `aud-k${i}`);
    await prisma.personCache.createMany({ data: karsons.map(id => ({ id, firstName: 'Aud', lastName: id, podOwner: 'ALISA', ownerMemberId: b.users.karson.twentyMemberId })) });
    const spaced = [outreachRecipe(2)[0], { ...outreachRecipe(2)[1], day: 3 }];
    const plan = await planCampaign(draft({ personIds: [...ids, ...karsons], fos: [{ id: b.users.alisa.id, batchSize: 1 }, { id: b.users.karson.id, batchSize: 1 }], flows: [{ id: 'default', name: 'Default', steps: spaced }], outreachEdited: true }), admin, undefined, { reshapeOutreach: false });
    expect(plan.calendar.valid).toBe(false); expect(plan.stage).toBe('outreach');
    const names = [b.users.alisa.name, b.users.karson.name].sort((x, y) => plan.calendar.issues[0].title.indexOf(x) - plan.calendar.issues[0].title.indexOf(y));
    expect(plan.calendar.issues).toEqual([{ title: `${names[0]} and ${names[1]} would have working days with nothing to send.`, detail: 'The waits between steps leave gaps. Every FO needs something to send each working day.', kind: 'search' }]);
    expect(plan.suggestions[0]).toMatchObject({ label: 'Let the studio set the outreach', studio: true });
    expect(plan.suggestions[0].detail).toMatch(/^(It sends \d+ steps?[^.]*\. All 8 people fit by Fri, Jan 8\.|(One step [^.]+\. )?All 8 people fit by Fri, Jan 8\. .+ sends? .+\.)$/);
    expect(plan.suggestions[0].draft.outreachEdited).toBe(false);
  });

  it('offers the studio outreach for a single person in the singular', async () => {
    const spaced = [outreachRecipe(2)[0], { ...outreachRecipe(2)[1], day: 3 }];
    const plan = await planCampaign(draft({ personIds: ['aud-1'], flows: [{ id: 'default', name: 'Default', steps: spaced }], outreachEdited: true }), admin, undefined, { reshapeOutreach: false });
    expect(plan.calendar.valid).toBe(false);
    expect(plan.calendar.issues[0]).toMatchObject({ kind: 'few', title: `${b.users.alisa.name} doesn't have enough people to fill every working day.` });
    expect(plan.suggestions[0]).toMatchObject({ studio: true, detail: 'It sends 5 steps, one each working day. The 1 person fits by Fri, Jan 8.' });
  });

  it('describes a built outreach in words, per FO only when their outreach differs', () => {
    const team = [{ id: 'a', name: 'Alyssa' }, { id: 'v', name: 'Avani' }], fos = team.map(f => ({ id: f.id, batchSize: 1 }));
    expect(outreachInWords({ fos, flows: [{ id: 'default', name: 'Default', steps: outreachRecipe(2, 1) }] }, team)).toEqual([{ names: ['Alyssa', 'Avani'], text: '2 steps, one each working day', steps: '2 steps', spacing: 'one each working day' }]);
    expect(outreachInWords({ fos, flows: [{ id: 'default', name: 'Default', steps: outreachRecipe(3, 2) }, { id: 'fo-v', name: 'For Avani', steps: outreachRecipe(1) }] }, team)).toEqual([{ names: ['Alyssa'], text: '3 steps, one every 2 days', steps: '3 steps', spacing: 'one every 2 days' }, { names: ['Avani'], text: '1 step', steps: '1 step', spacing: '' }]);
    expect(outreachInWords({ fos, flows: [{ id: 'default', name: 'Default', steps: outreachRecipe(4, 7) }] }, team)).toEqual([{ names: ['Alyssa', 'Avani'], text: '4 steps, one a week', steps: '4 steps', spacing: 'one a week' }]);
  });

  it('keeps an unfinished draft, and autosaves without an audit line each time', async () => {
    const unfinished = { ...draft(), productInterest: [], fos: [], defaultBatchSize: 0 };
    const c = await saveCampaignCalendar(unfinished, admin, {});
    expect(c.status).toBe('DRAFT'); expect(c.personIds).toEqual(ids); expect(c.publishedPlan).toBeNull();
    const again = await saveCampaignCalendar({ ...unfinished, name: 'Audience, renamed' }, admin, { id: c.id, revision: c.updatedAt.toISOString(), auto: true });
    expect(again.name).toBe('Audience, renamed');
    expect(await prisma.auditLog.count({ where: { entityId: c.id, action: 'draft_saved' } })).toBe(1);
    await expect(saveCampaignCalendar({ ...unfinished, name: '' }, admin, { id: c.id, revision: again.updatedAt.toISOString() })).rejects.toThrow(/Name your campaign/);
  });
});

describe('choosing people by priority', () => {
  it('matches any chosen group on the planner’s own labels, and Unclassified is everyone else', async () => {
    await prisma.personCache.createMany({ data: [
      { id: 'prio-client', firstName: 'Prio', lastName: 'Client', podOwner: 'ALISA', contactType: ['CLIENTS'] },
      { id: 'prio-mip', firstName: 'Prio', lastName: 'Mip', podOwner: 'ALISA', tags: ['MIP'] },
      { id: 'prio-t1', firstName: 'Prio', lastName: 'TierOne', podOwner: 'ALISA', tier: 'LEVEL_1' },
      { id: 'prio-t1tag', firstName: 'Prio', lastName: 'TierTag', podOwner: 'ALISA', tags: ['Tier 1'] },
      { id: 'prio-t2', firstName: 'Prio', lastName: 'TierTwo', podOwner: 'ALISA', tier: 'LEVEL_2' },
      { id: 'prio-none', firstName: 'Prio', lastName: 'None', podOwner: 'ALISA', tier: 'LEVEL_4' },
      { id: 'prio-null', firstName: 'Prio', lastName: 'Null', podOwner: 'ALISA' },
    ] });
    const pick = async (priority: number[]) => { const r = await pickPeopleAction({ q: 'Prio', state: 'any', priority }); if (!r.ok) throw new Error(r.error); return r.rows.map(x => x.id).sort(); };
    expect(await pick([0, 1, 2])).toEqual(['prio-client', 'prio-mip', 'prio-t1', 'prio-t1tag']);
    expect(await pick([3])).toEqual(['prio-t2']);
    expect(await pick([5])).toEqual(['prio-none', 'prio-null']);
    expect(await pick([])).toHaveLength(7);
    // MIP is its own switch, as on People, and joins the priority groups chosen.
    const mip = async (priority: number[]) => { const r = await pickPeopleAction({ q: 'Prio', state: 'any', priority, mip: true }); if (!r.ok) throw new Error(r.error); return r.rows.map(x => x.id).sort(); };
    expect(await mip([])).toEqual(['prio-mip']);
    expect(await mip([0, 2])).toEqual(['prio-client', 'prio-mip', 'prio-t1', 'prio-t1tag']);
  });
  it('shows why a contact cannot join and skips them in select-all', async () => {
    await prisma.personCache.createMany({ data: [
      { id: 'pick-dnd', firstName: 'Pick', lastName: 'Dnd', podOwner: 'ALISA', dnd: true },
      { id: 'pick-karson', firstName: 'Pick', lastName: 'Karson', podOwner: 'ALISA', ownerMemberId: b.users.karson.twentyMemberId },
      { id: 'pick-ok', firstName: 'Pick', lastName: 'Ok', podOwner: 'ALISA', ownerMemberId: b.users.alisa.twentyMemberId },
    ] });
    const filters = { q: 'Pick', state: 'any' as const, campaignPodId: b.pods.Alisa.id, campaignFoIds: [b.users.alisa.id] };
    const r = await pickPeopleAction(filters); if (!r.ok) throw new Error(r.error);
    expect(Object.fromEntries(r.rows.map(x => [x.id, x.ineligibleReason ?? null]))).toEqual({ 'pick-dnd': 'Do not contact', 'pick-karson': `Owned by ${b.users.karson.name}`, 'pick-ok': null });
    const all = await pickAllIdsAction(filters); if (!all.ok) throw new Error(all.error);
    expect(all).toEqual({ ok: true, ids: ['pick-ok'], skipped: 2 });
    const early = await pickPeopleAction({ ...filters, campaignFoIds: [] }); if (!early.ok) throw new Error(early.error);
    expect(early.rows.find(x => x.id === 'pick-karson')?.ineligibleReason).toBeUndefined();
  });
});
