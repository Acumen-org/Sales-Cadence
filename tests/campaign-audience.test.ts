import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { campaignAudienceIssues } from '@/lib/campaign-audience';
import { outreachInWords, planCampaign, previewCampaignCalendar, saveCampaignCalendar } from '@/lib/campaign-planning-service';
import { quietDays, type CampaignDraft } from '@/lib/campaign-planner';
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
    // An owner in another pod is named with their pod, so it is plain why they cannot be added here.
    expect(reason).toEqual({ dnd: 'Marked Do not contact in Twenty', optout: 'Asked not to be contacted', deleted: 'Deleted in Twenty', outside: 'In Pod Andrew, so only a Pod Manager or admin can add them', karsons: `Owned by ${b.users.karson.name}, who is not on this campaign`, andrews: `Owned by ${b.users.andrew.name} in another pod (Pod Andrew)`, seatless: 'Their owner in Twenty is not a Cadence user', missing: 'Deleted in Twenty' });
    // Karson works this pod and could be added; Andrew does not.
    expect(issues.find(i => i.id === 'karsons')?.ownerId).toBe(b.users.karson.id);
    expect(issues.find(i => i.id === 'andrews')?.ownerId).toBeUndefined();
    // A pod named the way Twenty labels it is not called a pod twice.
    await prisma.pod.update({ where: { id: b.pods.Andrew.id }, data: { name: "Andrew's pod" } });
    expect((await campaignAudienceIssues(['outside'], context))[0].reason).toBe("In Andrew's pod, so only a Pod Manager or admin can add them");
    await prisma.pod.update({ where: { id: b.pods.Andrew.id }, data: { name: 'Andrew' } });
    expect((await campaignAudienceIssues(['outside'], context))[0].reason).toBe('In the Andrew pod, so only a Pod Manager or admin can add them');
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
    expect(plan.droppedFos).toEqual([{ id: b.users.karson.id, name: b.users.karson.name, reason: 'none of the people you picked are theirs' }]);
    expect(plan.leftOut).toEqual([]); expect(plan.draft.personIds).toHaveLength(16);
    expect(plan.paces).toEqual([{ foId: b.users.alisa.id, name: b.users.alisa.name, from: 1, to: 4 }]);
  });

  it('plans an edited outreach with empty days, says once in plain words why one cannot finish, and offers the studio’s own outreach first', async () => {
    const karsons = Array.from({ length: 4 }, (_, i) => `aud-k${i}`);
    await prisma.personCache.createMany({ data: karsons.map(id => ({ id, firstName: 'Aud', lastName: id, podOwner: 'ALISA', ownerMemberId: b.users.karson.twentyMemberId })) });
    const team = { personIds: [...ids, ...karsons], fos: [{ id: b.users.alisa.id, batchSize: 1 }, { id: b.users.karson.id, batchSize: 1 }], outreachEdited: true };
    // Two days apart, these people cannot fill every working day: the plan keeps days empty instead of asking.
    const spaced = [outreachRecipe(2)[0], { ...outreachRecipe(2)[1], day: 3 }];
    const gaps = await planCampaign(draft({ ...team, flows: [{ id: 'default', name: 'Default', steps: spaced }] }), admin, undefined, { reshapeOutreach: false });
    expect(gaps.calendar.valid).toBe(true); expect(gaps.draft.flows[0].steps).toEqual(spaced);
    expect(quietDays(gaps.calendar).size).toBeGreaterThan(0);
    // A week between steps cannot finish by Friday.
    const late = [outreachRecipe(2)[0], { ...outreachRecipe(2)[1], day: 8 }];
    const plan = await planCampaign(draft({ ...team, flows: [{ id: 'default', name: 'Default', steps: late }] }), admin, undefined, { reshapeOutreach: false });
    expect(plan.calendar.valid).toBe(false); expect(plan.stage).toBe('outreach');
    expect(plan.calendar.issues).toEqual([{ title: 'The steps run past Fri, Jan 8.', detail: 'Even starting on the first day, the last step would go out too late.', kind: 'window' }]);
    expect(plan.suggestions[0]).toMatchObject({ label: 'Let the studio set the outreach', studio: true });
    expect(plan.suggestions[0].detail).toMatch(/^(It sends \d+ steps?[^.]*\. All 8 people fit by Fri, Jan 8\.|(One step [^.]+\. )?All 8 people fit by Fri, Jan 8\. .+ sends? .+\.)$/);
    expect(plan.suggestions[0].draft.outreachEdited).toBe(false);
  });

  it('offers the studio outreach for a single person in the singular', async () => {
    const late = [outreachRecipe(2)[0], { ...outreachRecipe(2)[1], day: 8 }];
    const plan = await planCampaign(draft({ personIds: ['aud-1'], flows: [{ id: 'default', name: 'Default', steps: late }], outreachEdited: true }), admin, undefined, { reshapeOutreach: false });
    expect(plan.calendar.valid).toBe(false);
    expect(plan.calendar.issues[0]).toMatchObject({ kind: 'window', title: 'The steps run past Fri, Jan 8.' });
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
    expect(Object.fromEntries(r.rows.map(x => [x.id, x.ineligibleReason ?? null]))).toEqual({ 'pick-dnd': 'Marked Do not contact in Twenty', 'pick-karson': `Owned by ${b.users.karson.name}, who is not on this campaign`, 'pick-ok': null });
    const all = await pickAllIdsAction(filters); if (!all.ok) throw new Error(all.error);
    expect(all).toEqual({ ok: true, ids: ['pick-ok'], skipped: 2, why: `Pick Dnd (marked Do not contact in Twenty); Pick Karson (owned by ${b.users.karson.name}, who is not on this campaign)` });
    const early = await pickPeopleAction({ ...filters, campaignFoIds: [] }); if (!early.ok) throw new Error(early.error);
    expect(early.rows.find(x => x.id === 'pick-karson')?.ineligibleReason).toBeUndefined();
  });
});

describe('contacts from other pods (owner, 15 October 2026)', () => {
  let manager: SessionUser, senior: SessionUser;
  const cross = async () => prisma.personCache.createMany({ data: [
    { id: 'cross-free', firstName: 'Cross', lastName: 'Free', sortName: 'cross free', email: 'free@prospect.example', podOwner: 'ANDREW' },
    { id: 'cross-free-2', firstName: 'Cross', lastName: 'Free Two', sortName: 'cross free two', email: 'free2@prospect.example', podOwner: 'ANDREW' },
    { id: 'cross-andrew', firstName: 'Cross', lastName: 'Andrew', sortName: 'cross andrew', email: 'andrew@prospect.example', podOwner: 'ANDREW', ownerMemberId: b.users.andrew.twentyMemberId },
  ] });
  beforeEach(async () => {
    const pm = await prisma.user.create({ data: { email: 'pm@cadence.local', name: 'Pat Manager', role: 'POD_MANAGER', passwordHash: 'x', timezone: 'Europe/London', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
    manager = { ...pm, podIds: [b.pods.Alisa.id], pods: [] };
    senior = { ...b.users.alisa, podIds: [b.pods.Alisa.id], pods: [] };
    await cross();
  });

  it('a Pod Manager sees every pod’s people, and one owned in another pod is blocked with that pod named', async () => {
    auth.user.mockResolvedValue(manager);
    const filters = { q: 'Cross', state: 'any' as const, campaignPodId: b.pods.Alisa.id, campaignFoIds: [b.users.alisa.id] };
    const r = await pickPeopleAction(filters); if (!r.ok) throw new Error(r.error);
    expect(Object.fromEntries(r.rows.map(x => [x.id, x.ineligibleReason ?? null]))).toEqual({ 'cross-andrew': `Owned by ${b.users.andrew.name} in another pod (Pod Andrew)`, 'cross-free': null, 'cross-free-2': null });
    // Before the team is chosen too: nobody on this pod could ever take Andrew's contact.
    const early = await pickPeopleAction({ ...filters, campaignFoIds: [] }); if (!early.ok) throw new Error(early.error);
    expect(early.rows.find(x => x.id === 'cross-andrew')?.ineligibleReason).toBe(`Owned by ${b.users.andrew.name} in another pod (Pod Andrew)`);
    // Everyone else still picks from the campaign's own pod.
    auth.user.mockResolvedValue(senior);
    const theirs = await pickPeopleAction(filters); if (!theirs.ok) throw new Error(theirs.error);
    expect(theirs.rows).toEqual([]);
  });

  it('plans them in, and a later edit by someone who could not add them keeps them', async () => {
    const intent = draft({ personIds: [...ids, 'cross-free', 'cross-andrew'] });
    const plan = await planCampaign(intent, manager, undefined, { reshapeOutreach: true });
    expect(plan.calendar.valid).toBe(true);
    expect(plan.draft.personIds).toEqual(expect.arrayContaining([...ids, 'cross-free']));
    expect(plan.leftOut.map(l => [l.id, l.reason])).toEqual([['cross-andrew', `Owned by ${b.users.andrew.name} in another pod (Pod Andrew)`]]);
    // A Senior FO of the pod opens the Pod Manager's draft: the contact stays, and they cannot add another.
    const saved = await saveCampaignCalendar(intent, manager, {});
    const edited = await planCampaign({ ...intent, personIds: [...intent.personIds, 'cross-free-2'] }, senior, saved.id, { reshapeOutreach: true });
    expect(edited.draft.personIds).toContain('cross-free');
    expect(edited.leftOut.find(l => l.id === 'cross-free-2')?.reason).toBe('In Pod Andrew, so only a Pod Manager or admin can add them');
  });
});

describe('anyone in a pod creates campaigns (owner, 15 October 2026)', () => {
  it('a Junior FO creates and edits their own draft, not someone else’s, and not in another pod', async () => {
    const karson: SessionUser = { ...b.users.karson, podIds: [b.pods.Alisa.id], pods: [] };
    const daniel: SessionUser = { ...b.users.daniel, podIds: [b.pods.Leigh.id], pods: [] };
    const senior: SessionUser = { ...b.users.alisa, podIds: [b.pods.Alisa.id], pods: [] };
    const own = await saveCampaignCalendar(draft(), karson, {});
    expect(own.createdById).toBe(karson.id);
    const renamed = await saveCampaignCalendar(draft({ name: 'Karson renamed' }), karson, { id: own.id, revision: own.updatedAt.toISOString() });
    expect(renamed.name).toBe('Karson renamed');
    const seniors = await saveCampaignCalendar(draft({ name: 'Senior draft' }), senior, {});
    await expect(saveCampaignCalendar(draft({ name: 'Taken over' }), karson, { id: seniors.id, revision: seniors.updatedAt.toISOString() })).rejects.toThrow(`Only ${b.users.alisa.name}, who created this campaign, the Senior FOs, Sales Leaders and Pod Managers of Pod Alisa, and admins can change it.`);
    await expect(saveCampaignCalendar(draft(), daniel, {})).rejects.toThrow('You are not in Pod Alisa, so you cannot create campaigns for it. You can create them only for the pods you are in.');
  });
});
