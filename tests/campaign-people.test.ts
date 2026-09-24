import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { canChangeCampaignPeople, mayChangeCampaignPeople } from '@/lib/auth/rbac';
import { previewCampaignCalendar, saveCampaignCalendar, type PublishedCalendar } from '@/lib/campaign-planning-service';
import type { CampaignDraft } from '@/lib/campaign-planner';
import { activateCampaign } from '@/lib/engine/campaigns';
import { addPeopleToCampaignAction, removePeopleFromCampaignAction } from '@/lib/actions/campaigns';
import { campaignChoices, membershipFor } from '@/lib/campaign-membership';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.user, requireAdmin: auth.user, toActor: (user: SessionUser) => user }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const asUser = (user: User, podIds: string[], role = user.role): SessionUser => ({ ...user, role, podIds, pods: podIds.map((id) => ({ id, name: id })) });
const form = (campaignId: string, personIds: string[]) => { const fd = new FormData(); fd.set('campaignId', campaignId); fd.set('personIds', JSON.stringify(personIds)); return fd; };
const actor = (id: string, role: SessionUser['role'], podIds: string[]) => ({ id, role, podIds });

describe('who may change a campaign’s people', () => {
  const team = { podId: 'pod-a', foIds: ['fo-on'] };
  it('is the campaign’s FOs, its pod’s Sales Leader and Pod Manager, and admins', () => {
    expect(canChangeCampaignPeople(actor('admin', 'ADMIN', []), team)).toBe(true);
    expect(canChangeCampaignPeople(actor('sl', 'SALES_LEADER', ['pod-a']), team)).toBe(true);
    expect(canChangeCampaignPeople(actor('pm', 'POD_MANAGER', ['pod-a']), team)).toBe(true);
    expect(canChangeCampaignPeople(actor('fo-on', 'JUNIOR_FO', ['pod-a']), team)).toBe(true);
    expect(canChangeCampaignPeople(actor('fo-on', 'SENIOR_FO', ['pod-a']), team)).toBe(true);
    // A leader of another pod, an FO of the pod who is not on it, and Biz Ops cannot.
    expect(canChangeCampaignPeople(actor('sl', 'SALES_LEADER', ['pod-b']), team)).toBe(false);
    expect(canChangeCampaignPeople(actor('pm', 'POD_MANAGER', ['pod-b']), team)).toBe(false);
    expect(canChangeCampaignPeople(actor('fo-off', 'SENIOR_FO', ['pod-a']), team)).toBe(false);
    expect(canChangeCampaignPeople(actor('fo-off', 'JUNIOR_FO', ['pod-a']), team)).toBe(false);
    expect(canChangeCampaignPeople(actor('fo-on', 'BIZ_OPS', ['pod-a']), team)).toBe(false);
    expect(canChangeCampaignPeople(actor('sl', 'SALES_LEADER', ['pod-a']), { podId: null, foIds: [] })).toBe(false);
    // A campaign from before the studio has no team of its own: its pod's FOs, as before.
    expect(canChangeCampaignPeople(actor('fo-off', 'JUNIOR_FO', ['pod-a']), { ...team, podWide: true })).toBe(true);
    expect(canChangeCampaignPeople(actor('fo-off', 'JUNIOR_FO', ['pod-b']), { ...team, podWide: true })).toBe(false);
    expect(canChangeCampaignPeople(actor('bo', 'BIZ_OPS', ['pod-a']), { ...team, podWide: true })).toBe(false);
    // Whether People offers the controls at all.
    expect(mayChangeCampaignPeople(actor('bo', 'BIZ_OPS', []))).toBe(false);
    expect(mayChangeCampaignPeople(actor('fo', 'JUNIOR_FO', ['pod-a']))).toBe(true);
  });
});

/**
 * People move in and out of studio campaigns from People. Before it runs the campaign takes them
 * in: a draft grows its audience, a scheduled one is planned again and published in place, or goes
 * back to draft when it cannot hold. Once it runs its plan is fixed. Only the FOs on it, its pod's
 * Sales Leader and Pod Manager, and admins may make the change.
 */
describe('changing a studio campaign’s people from People', () => {
  let b: Basics, admin: SessionUser, d: CampaignDraft;
  const KARSON = ['person-05', 'person-06', 'person-07', 'person-08'];

  beforeEach(async () => {
    await resetDb(); b = await seedBasics(); admin = asUser(b.users.ria, []);
    await prisma.personCache.updateMany({ where: { id: { in: [...KARSON, 'person-09', 'person-10'] } }, data: { ownerMemberId: b.users.karson.twentyMemberId, podOwner: 'ALISA', dnd: false, optedOut: false } });
    await prisma.personCache.update({ where: { id: 'person-10' }, data: { dnd: true } });
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { ownerMemberId: b.users.alisa.twentyMemberId, podOwner: 'ALISA', dnd: false, optedOut: false } });
    d = { name: 'Karson only', podId: b.pods.Alisa.id, startDate: '2027-01-04', endDate: '2027-01-08', productInterest: ['PHH'], defaultBatchSize: 1, fos: [{ id: b.users.karson.id, batchSize: 1 }], personIds: KARSON, assignments: {}, flows: [{ id: 'default', name: 'Default', steps: [{ id: 'first', day: 1, actions: [{ id: 'email', type: 'EMAIL', label: 'Email', template: 'Hi {{firstName}}' }] }, { id: 'second', day: 2, actions: [{ id: 'email2', type: 'EMAIL', label: 'Follow up' }] }] }] };
    auth.user.mockResolvedValue(asUser(b.users.karson, [b.pods.Alisa.id]));
  });

  const draft = async () => (await saveCampaignCalendar(d, admin, {})).id;
  const scheduled = async () => { const p = await previewCampaignCalendar(d, admin); expect(p.calendar.valid).toBe(true); return (await saveCampaignCalendar(d, admin, { publish: true, fingerprint: p.fingerprint })).id; };
  const load = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });
  const stored = async (id: string) => (await load(id)).plannerDraft as unknown as CampaignDraft & { request?: CampaignDraft };

  it('lets the campaign’s own FO and the pod’s leaders change it, and nobody else', async () => {
    const id = await draft();
    const allowed = [asUser(b.users.karson, [b.pods.Alisa.id]), asUser(b.users.leigh, [b.pods.Alisa.id], 'POD_MANAGER'), asUser(b.users.leigh, [b.pods.Alisa.id], 'SALES_LEADER'), admin];
    const refused = [asUser(b.users.alisa, [b.pods.Alisa.id]), asUser(b.users.daniel, [b.pods.Leigh.id]), asUser(b.users.leigh, [b.pods.Leigh.id], 'POD_MANAGER'), asUser(b.users.daniel, [], 'BIZ_OPS')];
    for (const who of refused) {
      auth.user.mockResolvedValue(who);
      expect(await addPeopleToCampaignAction(form(id, ['person-09']))).toEqual({ ok: false, error: expect.stringMatching(/Only the FOs on this campaign/) });
      expect(await removePeopleFromCampaignAction(form(id, ['person-05']))).toEqual({ ok: false, error: expect.stringMatching(/Only the FOs on this campaign/) });
    }
    expect((await load(id)).personIds).toEqual(KARSON);
    for (const who of allowed) {
      auth.user.mockResolvedValue(who);
      expect((await addPeopleToCampaignAction(form(id, ['person-09']))).ok).toBe(true);
      expect((await removePeopleFromCampaignAction(form(id, ['person-09']))).ok).toBe(true);
    }
    expect((await load(id)).personIds).toEqual(KARSON);
    // The campaign picker on People offers only the campaigns the user may change.
    const names = async (who: SessionUser) => (await campaignChoices(who, { manageOnly: true })).map((c) => c.name);
    expect(await names(asUser(b.users.karson, [b.pods.Alisa.id]))).toContain('Karson only');
    expect(await names(asUser(b.users.alisa, [b.pods.Alisa.id]))).not.toContain('Karson only');
    expect(await names(asUser(b.users.leigh, [b.pods.Alisa.id], 'POD_MANAGER'))).toContain('Karson only');
    // The person's own page says who may take them out.
    const m = (await membershipFor(['person-05'])).get('person-05')![0];
    expect(m).toEqual(expect.objectContaining({ foIds: [b.users.karson.id], podWide: false }));
  });

  it('adds to a draft’s audience, skipping who cannot be in it, and says why', async () => {
    const id = await draft();
    const r = await addPeopleToCampaignAction(form(id, ['person-09', 'person-10', 'person-01', 'person-05']));
    expect(r).toEqual({ ok: true, message: expect.stringMatching(/^1 person added to Karson only; 2 skipped: .*Do not contact/) });
    expect(r.ok && r.message).toMatch(/Owned by Alisa/);
    const c = await load(id);
    expect(c.status).toBe('DRAFT');
    expect(c.personIds).toEqual([...KARSON, 'person-09']);
    const saved = await stored(id);
    expect(saved.personIds).toEqual([...KARSON, 'person-09']);
    if (saved.request) expect(saved.request.personIds).toEqual([...KARSON, 'person-09']);
    // Nobody who can join: refused, and nothing changes.
    expect(await addPeopleToCampaignAction(form(id, ['person-10']))).toEqual({ ok: false, error: expect.stringMatching(/Nobody could be added; 1 skipped: Do not contact/) });
    // Taking someone out of a draft drops them from its outreach choices too.
    const withChoice = { ...(await stored(id)), assignments: { 'person-09': 'default' } };
    await prisma.campaign.update({ where: { id }, data: { plannerDraft: withChoice } });
    expect(await removePeopleFromCampaignAction(form(id, ['person-09']))).toEqual({ ok: true, message: '1 person removed from Karson only.' });
    expect((await stored(id)).assignments).toEqual({});
    expect((await load(id)).personIds).toEqual(KARSON);
  });

  it('plans a scheduled campaign again and keeps it scheduled when the plan holds', async () => {
    const id = await scheduled();
    const r = await addPeopleToCampaignAction(form(id, ['person-09']));
    expect(r).toEqual({ ok: true, message: '1 person added to Karson only, and its calendar was updated.' });
    const c = await load(id);
    expect(c.status).toBe('SCHEDULED');
    expect(c.personIds).toContain('person-09');
    const plan = c.publishedPlan as unknown as PublishedCalendar;
    expect(plan.valid).toBe(true);
    expect(plan.batches.flatMap((x) => x.personIds).sort()).toEqual([...KARSON, 'person-09'].sort());
    for (const day of plan.days) expect(plan.batches.some((x) => x.dates.includes(day))).toBe(true);
    // It still launches on its start day, with the new person.
    await activateCampaign(id, { actor: SYSTEM_ACTOR, now: new Date('2027-01-04T16:00:00Z'), skipSync: true });
    expect(await prisma.enrollment.count({ where: { campaignId: id } })).toBe(5);
  });

  it('sends a scheduled campaign back to draft when it cannot hold without the people taken out', async () => {
    const id = await scheduled();
    const r = await removePeopleFromCampaignAction(form(id, ['person-06', 'person-07', 'person-08']));
    expect(r).toEqual({ ok: true, message: expect.stringMatching(/^3 people removed\. Karson only is back in draft because /) });
    const c = await load(id);
    expect(c.status).toBe('DRAFT');
    expect(c.publishedPlan).toBeNull();
    expect(c.personIds).toEqual(['person-05']);
    expect((await stored(id)).personIds).toEqual(['person-05']);
    // Nothing launches from it.
    await activateCampaign(id, { actor: SYSTEM_ACTOR, now: new Date('2027-01-04T16:00:00Z'), skipSync: true });
    expect(await prisma.enrollment.count({ where: { campaignId: id } })).toBe(0);
  });

  it('fixes the plan once it runs: nobody new, and taking someone out ends their outreach', async () => {
    const id = await scheduled();
    await activateCampaign(id, { actor: SYSTEM_ACTOR, now: new Date('2027-01-04T16:00:00Z'), skipSync: true });
    expect(await addPeopleToCampaignAction(form(id, ['person-09']))).toEqual({ ok: false, error: expect.stringMatching(/has started, so its plan is fixed/) });
    expect((await load(id)).personIds).not.toContain('person-09');
    const removed = await removePeopleFromCampaignAction(form(id, ['person-05']));
    expect(removed.ok).toBe(true);
    const e = await prisma.enrollment.findFirstOrThrow({ where: { campaignId: id, personId: 'person-05' } });
    expect(e).toEqual(expect.objectContaining({ status: 'EXITED', exitReason: 'removed' }));
    expect(await prisma.task.count({ where: { enrollmentId: e.id, state: 'PENDING' } })).toBe(0);
    expect(await prisma.enrollment.count({ where: { campaignId: id, status: 'ACTIVE' } })).toBe(3);
    // The FO on it is still on it after launch, so they may still take people out.
    auth.user.mockResolvedValue(asUser(b.users.alisa, [b.pods.Alisa.id]));
    expect((await removePeopleFromCampaignAction(form(id, ['person-06']))).ok).toBe(false);
    await prisma.campaign.update({ where: { id }, data: { status: 'COMPLETED' } });
    auth.user.mockResolvedValue(admin);
    expect(await addPeopleToCampaignAction(form(id, ['person-09']))).toEqual({ ok: false, error: expect.stringMatching(/has ended/) });
  });

  it('opens a campaign from before the studio to its pod until it runs, then to the FOs running it', async () => {
    const legacy = await prisma.campaign.create({ data: { name: 'Legacy', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, status: 'SCHEDULED', startDate: '2027-01-04', personIds: ['person-01'] } });
    const karson = asUser(b.users.karson, [b.pods.Alisa.id]);
    auth.user.mockResolvedValue(karson);
    expect((await addPeopleToCampaignAction(form(legacy.id, ['person-09']))).ok).toBe(true);
    // Running: Alisa runs its enrollment, so Alisa may change it and Karson may not.
    await prisma.campaign.update({ where: { id: legacy.id }, data: { status: 'ACTIVE' } });
    await prisma.enrollment.create({ data: { campaignId: legacy.id, personId: 'person-01', foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2027-01-04', status: 'ACTIVE' } });
    expect(await removePeopleFromCampaignAction(form(legacy.id, ['person-01']))).toEqual({ ok: false, error: expect.stringMatching(/Only the FOs on this campaign/) });
    expect((await membershipFor(['person-01'])).get('person-01')![0]).toEqual(expect.objectContaining({ foIds: [b.users.alisa.id], podWide: false }));
    auth.user.mockResolvedValue(asUser(b.users.alisa, [b.pods.Alisa.id]));
    expect((await removePeopleFromCampaignAction(form(legacy.id, ['person-01']))).ok).toBe(true);
  });

  it('keeps a follow-up to the people who did not reply', async () => {
    const source = await prisma.campaign.create({ data: { name: 'Source', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, status: 'COMPLETED', startDate: '2026-11-02' } });
    const id = await draft();
    await prisma.campaign.update({ where: { id }, data: { followupSourceId: source.id } });
    expect(await addPeopleToCampaignAction(form(id, ['person-09']))).toEqual({ ok: false, error: expect.stringMatching(/follow-up/) });
  });
});
