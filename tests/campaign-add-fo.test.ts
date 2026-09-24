import { beforeEach, describe, expect, it } from 'vitest';
import type { Prisma, User } from '@prisma/client';
import { prisma } from '@/lib/db';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { previewCampaignCalendar, saveCampaignCalendar, type PublishedCalendar } from '@/lib/campaign-planning-service';
import { CampaignDraftSchema, type CampaignDraft } from '@/lib/campaign-planner';
import type { SessionUser } from '@/lib/auth/current-user';
import { activateCampaign } from '@/lib/engine/campaigns';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { addFoCandidates, addFoWindow, applyAddFo, planAddFo } from '@/lib/campaign-add-fo';

const asUser = (user: User, podIds: string[], role = user.role): SessionUser => ({ ...user, role, podIds, pods: podIds.map((id) => ({ id, name: id })) });
const START = new Date('2027-01-04T16:00:00Z');
const NEXT_DAY = new Date('2027-01-05T16:00:00Z');
const ALISA_PEOPLE = ['person-01', 'person-02', 'person-03', 'person-04'];
const KARSON_PEOPLE = ['person-05', 'person-06', 'person-07', 'person-08'];

/**
 * A new FO joins a running studio campaign on its start day, with their own people. Nobody already
 * on it changes: their batches, outreach and enrollments stay exactly as launched. The window is the
 * start day only, the pod's leaders and admins decide, and the reviewed plan is the one applied.
 */
describe('adding an FO to a running campaign', () => {
  let b: Basics, admin: SessionUser, d: CampaignDraft, campaignId: string;

  beforeEach(async () => {
    await resetDb(); b = await seedBasics(); admin = asUser(b.users.ria, []);
    await prisma.personCache.updateMany({ where: { id: { in: ALISA_PEOPLE } }, data: { ownerMemberId: b.users.alisa.twentyMemberId, podOwner: 'ALISA', dnd: false, optedOut: false } });
    await prisma.personCache.updateMany({ where: { id: { in: KARSON_PEOPLE } }, data: { ownerMemberId: b.users.karson.twentyMemberId, podOwner: 'ALISA', dnd: false, optedOut: false } });
    d = { name: 'Calendar', podId: b.pods.Alisa.id, startDate: '2027-01-04', endDate: '2027-01-08', productInterest: ['PHH'], defaultBatchSize: 1, fos: [{ id: b.users.alisa.id, batchSize: 1 }], personIds: ALISA_PEOPLE, assignments: {}, flows: [{ id: 'default', name: 'Default', steps: [{ id: 'first', day: 1, actions: [{ id: 'email', type: 'EMAIL', label: 'Email', template: 'Hi {{firstName}}' }] }, { id: 'second', day: 2, actions: [{ id: 'email2', type: 'EMAIL', label: 'Follow up' }] }] }] };
    const preview = await previewCampaignCalendar(d, admin);
    expect(preview.calendar.valid).toBe(true);
    campaignId = (await saveCampaignCalendar(d, admin, { publish: true, fingerprint: preview.fingerprint })).id;
    await activateCampaign(campaignId, { actor: SYSTEM_ACTOR, now: START, skipSync: true });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe('ACTIVE');
  });

  const input = (personIds = KARSON_PEOPLE, batchSize = 1) => ({ foId: b.users.karson.id, personIds, batchSize });
  const snapshot = async () => {
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const plan = c.publishedPlan as unknown as PublishedCalendar;
    const enrollments = await prisma.enrollment.findMany({ where: { campaignId, foUserId: b.users.alisa.id }, orderBy: { personId: 'asc' }, select: { id: true, personId: true, sequenceId: true, startDate: true, scheduleDates: true, status: true, currentStep: true, currentStepId: true } });
    const tasks = await prisma.task.findMany({ where: { enrollment: { campaignId, foUserId: b.users.alisa.id } }, orderBy: { id: 'asc' }, select: { id: true, dueDate: true, state: true } });
    const draft = c.plannerDraft as unknown as CampaignDraft & { sequenceIds: Record<string, string> };
    return { batches: plan.batches.filter((x) => x.foId === b.users.alisa.id), enrollments, tasks, flows: draft.flows.filter((f) => f.id === 'default'), sequence: await prisma.sequence.findUniqueOrThrow({ where: { id: draft.sequenceIds.default } }) };
  };

  it('adds the FO and their people without touching anyone already on the campaign', async () => {
    const before = await snapshot();
    const r = await planAddFo(admin, campaignId, input(), { now: START });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.flow).toEqual(expect.objectContaining({ id: 'default', created: false }));
    expect(r.preview.leftOut).toEqual([]);
    // Nothing is written by the preview.
    expect(await prisma.enrollment.count({ where: { campaignId, foUserId: b.users.karson.id } })).toBe(0);

    const applied = await applyAddFo(admin, campaignId, input(), r.preview.fingerprint, { now: START, skipSync: true });
    expect(applied.enrolled).toBe(4);
    expect(await snapshot()).toEqual(before);

    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(c.status).toBe('ACTIVE');
    expect([...c.personIds].sort()).toEqual([...ALISA_PEOPLE, ...KARSON_PEOPLE].sort());
    const plan = c.publishedPlan as unknown as PublishedCalendar;
    expect(plan.fos.map((f) => f.id)).toEqual([b.users.alisa.id, b.users.karson.id]);
    const theirs = plan.batches.filter((x) => x.foId === b.users.karson.id);
    expect(theirs.flatMap((x) => x.personIds).sort()).toEqual(KARSON_PEOPLE);
    // Their own rule: something to send every working day, whole journeys by the end date.
    for (const day of plan.days) expect(theirs.some((x) => x.dates.includes(day))).toBe(true);
    for (const x of theirs) expect(x.dates.every((date) => date <= '2027-01-08')).toBe(true);
    // Batch ids stay unique across FOs.
    expect(new Set(plan.batches.map((x) => x.id)).size).toBe(plan.batches.length);
    const draft = c.plannerDraft as unknown as CampaignDraft & { request?: CampaignDraft };
    expect(draft.fos.map((f) => f.id)).toContain(b.users.karson.id);
    expect(draft.personIds).toEqual(expect.arrayContaining(KARSON_PEOPLE));
    if (draft.request) expect(draft.request.fos.map((f) => f.id)).toContain(b.users.karson.id);

    // Enrolled exactly on the planned dates, and the first steps are on today's list.
    const enrollments = await prisma.enrollment.findMany({ where: { campaignId, foUserId: b.users.karson.id }, include: { tasks: true } });
    expect(enrollments).toHaveLength(4);
    for (const e of enrollments) {
      const batch = theirs.find((x) => x.personIds.includes(e.personId))!;
      expect(e.scheduleDates).toEqual(batch.dates);
      expect(e.startDate).toBe(batch.dates[0]);
      expect(e.campaignRun).toBe(c.runNumber);
      expect(e.status).toBe('ACTIVE');
    }
    const today = enrollments.filter((e) => e.startDate === '2027-01-04');
    expect(today.length).toBeGreaterThan(0);
    for (const e of today) expect(e.tasks.some((t) => t.dueDate === '2027-01-04' && t.state === 'PENDING')).toBe(true);
    expect(await prisma.auditLog.count({ where: { entityId: campaignId, action: 'fo_added' } })).toBe(1);

    // The launch tick never runs the campaign again, and Karson is no longer a candidate.
    expect((await activateCampaign(campaignId, { actor: SYSTEM_ACTOR, now: START, skipSync: true })).enrolled).toBe(0);
    expect((await addFoCandidates(campaignId)).map((f) => f.id)).not.toContain(b.users.karson.id);
  });

  it('is open only on the start day, and only while the campaign runs', async () => {
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(addFoWindow(c, START).open).toBe(true);
    expect(addFoWindow(c, NEXT_DAY)).toEqual({ open: false, reason: expect.stringMatching(/start day/) });
    expect(addFoWindow({ ...c, plannerDraft: null }, START).open).toBe(false);
    // The fingerprint reviewed on the start day does not carry over to the next day.
    const r = await planAddFo(admin, campaignId, input(), { now: START });
    if (!r.ok) throw new Error(r.error);
    expect(await planAddFo(admin, campaignId, input(), { now: NEXT_DAY })).toEqual({ ok: false, error: expect.stringMatching(/start day/) });
    await expect(applyAddFo(admin, campaignId, input(), r.preview.fingerprint, { now: NEXT_DAY, skipSync: true })).rejects.toThrow(/start day/);
    for (const status of ['PAUSED', 'STOPPED', 'COMPLETED', 'SCHEDULED'] as const) {
      await prisma.campaign.update({ where: { id: campaignId }, data: { status } });
      expect(await planAddFo(admin, campaignId, input(), { now: START })).toEqual({ ok: false, error: expect.stringMatching(/running/) });
    }
    expect(await prisma.enrollment.count({ where: { campaignId, foUserId: b.users.karson.id } })).toBe(0);
    // A follow-up holds only the people who did not reply to the campaign before it.
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'ACTIVE', followupSourceId: (await prisma.campaign.create({ data: { name: 'Source', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, status: 'COMPLETED', startDate: '2026-11-02' } })).id } });
    expect(await planAddFo(admin, campaignId, input(), { now: START })).toEqual({ ok: false, error: expect.stringMatching(/follow-up/) });
  });

  it('opens from a weekend start date through the first working day', async () => {
    const c = { status: 'ACTIVE', startDate: '2027-01-02', plannerDraft: {}, publishedPlan: { days: ['2027-01-04', '2027-01-05'] } };
    expect(addFoWindow(c, new Date('2027-01-02T16:00:00Z')).open).toBe(true);
    expect(addFoWindow(c, new Date('2027-01-04T16:00:00Z')).open).toBe(true);
    expect(addFoWindow(c, new Date('2027-01-05T16:00:00Z')).open).toBe(false);
    expect(addFoWindow(c, new Date('2027-01-01T16:00:00Z')).open).toBe(false);
    // Just before and after midnight in Chicago.
    expect(addFoWindow({ ...c, startDate: '2027-01-04', publishedPlan: { days: ['2027-01-04'] } }, new Date('2027-01-05T05:59:00Z')).open).toBe(true);
    expect(addFoWindow({ ...c, startDate: '2027-01-04', publishedPlan: { days: ['2027-01-04'] } }, new Date('2027-01-05T06:01:00Z')).open).toBe(false);
  });

  it('adds an FO who was left off at publish without listing them or their people twice', async () => {
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const stored = c.plannerDraft as unknown as CampaignDraft & { request?: CampaignDraft };
    const request = { ...(stored.request ?? d), fos: [...(stored.request ?? d).fos, { id: b.users.karson.id, batchSize: 1 }], personIds: [...(stored.request ?? d).personIds, 'person-05'] };
    await prisma.campaign.update({ where: { id: campaignId }, data: { plannerDraft: { ...stored, request } as unknown as Prisma.InputJsonValue } });
    const r = await planAddFo(admin, campaignId, input(), { now: START });
    if (!r.ok) throw new Error(r.error);
    await applyAddFo(admin, campaignId, input(), r.preview.fingerprint, { now: START, skipSync: true });
    const saved = ((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).plannerDraft as unknown as { request: CampaignDraft }).request;
    expect(saved.fos.filter((f) => f.id === b.users.karson.id)).toHaveLength(1);
    expect(saved.personIds.filter((id) => id === 'person-05')).toHaveLength(1);
    // Plan another run opens from the request, so it must still be a valid draft.
    expect(() => CampaignDraftSchema.parse(saved)).not.toThrow();
  });

  it('lets two leaders add two different FOs at the same time', async () => {
    const other = await prisma.user.create({ data: { email: 'ines@cadence.local', name: 'Ines Other', role: 'JUNIOR_FO', twentyMemberId: 'wm-ines', passwordHash: 'x', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
    const theirs = ['person-12', 'person-13', 'person-14', 'person-15'];
    await prisma.personCache.updateMany({ where: { id: { in: theirs } }, data: { ownerMemberId: 'wm-ines', podOwner: 'ALISA', dnd: false, optedOut: false } });
    const one = await planAddFo(admin, campaignId, input(), { now: START });
    const two = await planAddFo(admin, campaignId, { foId: other.id, personIds: theirs, batchSize: 1 }, { now: START });
    if (!one.ok || !two.ok) throw new Error('both should plan');
    const [a, c] = await Promise.all([applyAddFo(admin, campaignId, input(), one.preview.fingerprint, { now: START, skipSync: true }), applyAddFo(admin, campaignId, { foId: other.id, personIds: theirs, batchSize: 1 }, two.preview.fingerprint, { now: START, skipSync: true })]);
    expect([a.enrolled, c.enrolled]).toEqual([4, 4]);
    const plan = (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).publishedPlan as unknown as PublishedCalendar;
    expect(plan.fos.map((f) => f.id).sort()).toEqual([b.users.alisa.id, b.users.karson.id, other.id].sort());
    expect(plan.batches.flatMap((x) => x.personIds)).toHaveLength(12);
    expect(await prisma.enrollment.count({ where: { campaignId } })).toBe(12);
  });

  it('lets only the pod’s leaders and admins add, and only an FO of the pod who is not on it yet', async () => {
    const pod = [b.pods.Alisa.id];
    // An FO already on the campaign, or from another pod, cannot be added.
    for (const foId of [b.users.alisa.id, b.users.andrew.id, b.users.daniel.id, b.users.ria.id]) {
      expect(await planAddFo(admin, campaignId, { ...input(), foId }, { now: START })).toEqual({ ok: false, error: expect.stringMatching(/not on the campaign yet/) });
    }
    // An inactive FO is not offered.
    await prisma.user.update({ where: { id: b.users.karson.id }, data: { active: false } });
    expect((await addFoCandidates(campaignId)).map((f) => f.id)).not.toContain(b.users.karson.id);
    await prisma.user.update({ where: { id: b.users.karson.id }, data: { active: true } });
    // Who may add.
    const refused = [asUser(b.users.karson, pod), asUser(b.users.leigh, [b.pods.Leigh.id]), asUser(b.users.leigh, [b.pods.Leigh.id], 'POD_MANAGER'), asUser(b.users.daniel, [], 'BIZ_OPS')];
    for (const who of refused) expect(await planAddFo(who, campaignId, input(), { now: START })).toEqual({ ok: false, error: expect.stringMatching(/leaders and admins/) });
    for (const who of [asUser(b.users.alisa, pod), asUser(b.users.leigh, pod, 'POD_MANAGER'), asUser(b.users.leigh, pod, 'SALES_LEADER'), admin]) expect((await planAddFo(who, campaignId, input(), { now: START })).ok).toBe(true);
    // A refused user cannot apply a plan someone else reviewed.
    const r = await planAddFo(admin, campaignId, input(), { now: START });
    if (!r.ok) throw new Error(r.error);
    await expect(applyAddFo(asUser(b.users.karson, pod), campaignId, input(), r.preview.fingerprint, { now: START, skipSync: true })).rejects.toThrow(/leaders and admins/);
    // The pace is a whole number from 1 to 500.
    for (const batchSize of [0, -1, 1.5, 501]) expect(await planAddFo(admin, campaignId, input(KARSON_PEOPLE, batchSize), { now: START })).toEqual({ ok: false, error: expect.stringMatching(/1 to 500/) });
    expect(await planAddFo(admin, campaignId, input([]), { now: START })).toEqual({ ok: false, error: expect.stringMatching(/Choose the people/) });
    expect(await planAddFo(admin, 'missing', input(), { now: START })).toEqual({ ok: false, error: 'Campaign not found.' });
  });

  it('leaves out people who cannot join, with the reason, and refuses when nobody can', async () => {
    await prisma.personCache.update({ where: { id: 'person-09' }, data: { ownerMemberId: b.users.alisa.twentyMemberId, podOwner: 'ALISA', dnd: false, optedOut: false } });
    await prisma.personCache.update({ where: { id: 'person-10' }, data: { ownerMemberId: b.users.karson.twentyMemberId, podOwner: 'ALISA', dnd: true } });
    await prisma.personCache.update({ where: { id: 'person-11' }, data: { ownerMemberId: b.users.karson.twentyMemberId, podOwner: 'ALISA', dnd: false, optedOut: false } });
    await prisma.campaign.create({ data: { name: 'Elsewhere', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, status: 'SCHEDULED', startDate: '2027-02-01', personIds: ['person-11'] } });
    const r = await planAddFo(admin, campaignId, input([...KARSON_PEOPLE, 'person-01', 'person-09', 'person-10', 'person-11']), { now: START });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const why = Object.fromEntries(r.preview.leftOut.map((l) => [l.id, l.reason]));
    expect(why).toEqual({ 'person-01': 'Already in Calendar', 'person-09': expect.stringMatching(/^Owned by Alisa/), 'person-10': 'Do not contact', 'person-11': 'Already in Elsewhere' });
    expect(r.preview.people.map((p) => p.id).sort()).toEqual(KARSON_PEOPLE);
    const applied = await applyAddFo(admin, campaignId, input([...KARSON_PEOPLE, 'person-01', 'person-09', 'person-10', 'person-11']), r.preview.fingerprint, { now: START, skipSync: true });
    expect(applied.enrolled).toBe(4);
    // person-01 keeps their one enrollment, with Alisa.
    expect(await prisma.enrollment.findMany({ where: { personId: 'person-01' }, select: { foUserId: true } })).toEqual([{ foUserId: b.users.alisa.id }]);
  });

  it('keeps the pod’s unowned contacts with the FO who brought them', async () => {
    await prisma.personCache.updateMany({ where: { id: { in: ['person-06', 'person-07'] } }, data: { ownerMemberId: null } });
    const r = await planAddFo(admin, campaignId, input(), { now: START });
    if (!r.ok) throw new Error(r.error);
    await applyAddFo(admin, campaignId, input(), r.preview.fingerprint, { now: START, skipSync: true });
    const draft = (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).plannerDraft as unknown as CampaignDraft;
    expect(draft.foAssignments).toEqual(expect.objectContaining({ 'person-06': b.users.karson.id, 'person-07': b.users.karson.id }));
    expect(await prisma.enrollment.count({ where: { campaignId, foUserId: b.users.karson.id, personId: { in: ['person-06', 'person-07'] } } })).toBe(2);
  });

  it('refuses when nobody chosen can join', async () => {
    await prisma.personCache.update({ where: { id: 'person-10' }, data: { ownerMemberId: b.users.karson.twentyMemberId, podOwner: 'ALISA', dnd: true } });
    const r = await planAddFo(admin, campaignId, input(['person-01', 'person-10']), { now: START });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/None of the people chosen/), leftOut: expect.arrayContaining([expect.objectContaining({ id: 'person-01' }), expect.objectContaining({ id: 'person-10' })]) });
  });

  it('refuses a stale review and writes nothing', async () => {
    const r = await planAddFo(admin, campaignId, input(), { now: START });
    if (!r.ok) throw new Error(r.error);
    // person-06 is promised to another campaign after the review.
    await prisma.campaign.create({ data: { name: 'Taken', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, status: 'SCHEDULED', startDate: '2027-02-01', personIds: ['person-06'] } });
    await expect(applyAddFo(admin, campaignId, input(), r.preview.fingerprint, { now: START, skipSync: true })).rejects.toThrow(/changed since you reviewed/);
    await expect(applyAddFo(admin, campaignId, input(), 'forged', { now: START, skipSync: true })).rejects.toThrow(/changed since you reviewed/);
    expect(await prisma.enrollment.count({ where: { campaignId, foUserId: b.users.karson.id } })).toBe(0);
    const plan = (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).publishedPlan as unknown as PublishedCalendar;
    expect(plan.fos.map((f) => f.id)).toEqual([b.users.alisa.id]);
    // A fresh review of what is left goes through.
    const again = await planAddFo(admin, campaignId, input(), { now: START });
    if (!again.ok) throw new Error(again.error);
    expect(again.preview.leftOut.map((l) => l.id)).toEqual(['person-06']);
  });

  it('adds the FO once when the same review is applied at the same time', async () => {
    const r = await planAddFo(admin, campaignId, input(), { now: START });
    if (!r.ok) throw new Error(r.error);
    const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => applyAddFo(admin, campaignId, input(), r.preview.fingerprint, { now: START, skipSync: true })));
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.enrollment.count({ where: { campaignId, foUserId: b.users.karson.id } })).toBe(4);
    const plan = (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).publishedPlan as unknown as PublishedCalendar;
    expect(plan.fos.filter((f) => f.id === b.users.karson.id)).toHaveLength(1);
    expect(plan.batches.filter((x) => x.foId === b.users.karson.id).flatMap((x) => x.personIds)).toHaveLength(4);
  });

  it('keeps an edited outreach as it is, and gives the FO their own when the studio built it', async () => {
    // One person cannot fill five working days with a two-step outreach.
    const edited = await planAddFo(admin, campaignId, input(['person-05']), { now: START });
    expect(edited).toEqual({ ok: false, error: expect.stringMatching(/With this campaign’s outreach/), leftOut: [] });

    // The same campaign, had its outreach been built by the studio.
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const stored = c.plannerDraft as unknown as CampaignDraft & { request?: CampaignDraft; sequenceIds: Record<string, string> };
    await prisma.campaign.update({ where: { id: campaignId }, data: { plannerDraft: { ...stored, outreachEdited: false, ...(stored.request ? { request: { ...stored.request, outreachEdited: false } } : {}) } as unknown as Prisma.InputJsonValue } });
    const before = await snapshot();
    const r = await planAddFo(admin, campaignId, input(['person-05']), { now: START });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.flow).toEqual(expect.objectContaining({ id: `fo-${b.users.karson.id}`, name: 'For Karson Reed', created: true }));
    expect(r.preview.flow.steps.length).toBeGreaterThan(2);
    await applyAddFo(admin, campaignId, input(['person-05']), r.preview.fingerprint, { now: START, skipSync: true });
    expect(await snapshot()).toEqual(before);
    const after = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const draft = after.plannerDraft as unknown as CampaignDraft & { sequenceIds: Record<string, string> };
    const plan = after.publishedPlan as unknown as PublishedCalendar;
    const flowId = `fo-${b.users.karson.id}`;
    expect(draft.flows.map((f) => f.id)).toEqual(['default', flowId]);
    expect(draft.assignments['person-05']).toBe(flowId);
    expect(plan.sequenceIds[flowId]).toBe(draft.sequenceIds[flowId]);
    expect(plan.sequenceIds.default).toBe(stored.sequenceIds.default);
    const sequence = await prisma.sequence.findUniqueOrThrow({ where: { id: draft.sequenceIds[flowId] } });
    expect(sequence).toEqual(expect.objectContaining({ name: 'For Karson Reed', campaignOwned: true }));
    const e = await prisma.enrollment.findFirstOrThrow({ where: { campaignId, personId: 'person-05' } });
    expect(e.sequenceId).toBe(sequence.id);
    expect(e.scheduleDates).toEqual(['2027-01-04', '2027-01-05', '2027-01-06', '2027-01-07', '2027-01-08']);
  });
});
