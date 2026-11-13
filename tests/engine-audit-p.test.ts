import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { DEFAULT_SEQUENCE_STEPS } from '@/lib/sequences/default-sequence';
import { activateCampaign, changeCampaignStatus, launchScheduledCampaigns } from '@/lib/engine/campaigns';
import { completeTask, mirrorMissedWrites, runSchedulerTick, stopEndedCampaigns } from '@/lib/engine/tasks';
import { enrollPeople, pauseEnrollment, resumeEnrollment } from '@/lib/engine/enrollment';
import { claimNightly, nightlyLookbackDays, NIGHTLY_MARKER } from '@/lib/nightly';
import { nextOccurrence, syncNextActions } from '@/lib/next-actions';
import { notificationScope } from '@/lib/notifications';
import { getSettings, saveSettingsSection } from '@/lib/settings';
import { workspaceTimezone } from '@/lib/workspace';
import { addDays, todayIn } from '@/lib/dates';
import { resetDb, seedBasics, type Basics } from './helpers/db';

let b: Basics;
const at = (iso: string) => new Date(`${iso}T18:00:00Z`);
const quiet = (now: Date) => ({ actor: SYSTEM_ACTOR, now, skipSync: true });
beforeEach(async () => { await resetDb(); b = await seedBasics(); });

const enrol = async (personIds: string[], now = at('2026-09-07')) =>
  (await enrollPeople({ personIds, sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-07', assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR }, { now, skipSync: true })).enrolled.map((e) => e.enrollmentId);
const legacy = (data: Record<string, unknown> = {}) =>
  prisma.campaign.create({ data: { name: 'Legacy', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-07', status: 'SCHEDULED', personIds: ['person-01', 'person-02'], assignmentMode: 'ROUND_ROBIN', productInterest: ['PHH'], ...data } });
const setRules = async (patch: Record<string, unknown>) => { const s = await getSettings(); await saveSettingsSection('rules', { ...s.rules, ...patch } as typeof s.rules); };

describe('campaign engine (audit 14, P03 onward)', () => {
  it('P04: people left Paused in a resumed campaign are resumed by the worker', async () => {
    const c = await legacy();
    await activateCampaign(c.id, quiet(at('2026-09-07')));
    await changeCampaignStatus(c.id, 'PAUSED', SYSTEM_ACTOR, at('2026-09-08'));
    // A resume cut off after the campaign row was written: it runs, its people are still Paused.
    await prisma.campaign.update({ where: { id: c.id }, data: { status: 'ACTIVE' } });
    await runSchedulerTick(quiet(at('2026-09-09')));
    expect(await prisma.enrollment.count({ where: { campaignId: c.id, status: 'ACTIVE' } })).toBe(2);
  });

  it('P05: a pause is added to the clock once, not again when the held step is done', async () => {
    const [id] = await enrol(['person-01']);
    await pauseEnrollment(id, { reason: 'holiday', actor: SYSTEM_ACTOR, now: at('2026-09-07') });
    await resumeEnrollment(id, quiet(at('2026-09-14')));
    for (const t of await prisma.task.findMany({ where: { enrollmentId: id, state: 'PENDING' } })) await completeTask({ taskId: t.id, source: 'MANUAL' }, quiet(at('2026-09-14')));
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id } })).shiftDays).toBe(7);
  });

  it('P08: a move to a step cut off after the park still gets its step at the next pass', async () => {
    const [id] = await enrol(['person-01']);
    // The first half of "Move to step 3": open work cancelled, parked just before it.
    await prisma.task.updateMany({ where: { enrollmentId: id, state: 'PENDING' }, data: { state: 'CANCELLED', cancelReason: 'moved_to_step:3' } });
    await prisma.enrollment.update({ where: { id }, data: { currentStep: 1, currentStepId: DEFAULT_SEQUENCE_STEPS[1].id } });
    await runSchedulerTick(quiet(at('2026-09-08')));
    const open = await prisma.task.findMany({ where: { enrollmentId: id, state: 'PENDING' } });
    expect(open.map((t) => t.stepIndex)).toEqual([2]);
  });

  it('P10: a restart leaves out whoever the last run ended as not interested', async () => {
    const c = await legacy({ runNumber: 2 });
    await prisma.enrollment.create({ data: { personId: 'person-01', foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, campaignId: c.id, campaignRun: 1, startDate: '2026-08-03', status: 'EXITED', exitReason: 'not_interested' } });
    await activateCampaign(c.id, quiet(at('2026-09-07')));
    const run2 = await prisma.enrollment.findMany({ where: { campaignId: c.id, campaignRun: 2 }, select: { personId: true } });
    expect(run2.map((e) => e.personId)).toEqual(['person-02']);
  });

  it('P11: a campaign that cannot start is tried hourly, not each minute, and its creator is told once', async () => {
    const c = await legacy({ createdById: b.users.alisa.id });
    await prisma.pod.update({ where: { id: b.pods.Alisa.id }, data: { archived: true } });
    await launchScheduledCampaigns(quiet(at('2026-09-07')));
    await launchScheduledCampaigns(quiet(at('2026-09-07')));
    expect(await prisma.auditLog.count({ where: { entityId: c.id, action: 'launch_failed' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: b.users.alisa.id, kind: 'campaign_launch_failed' } })).toBe(1);
    // An edit to the campaign tries again at once.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await prisma.campaign.update({ where: { id: c.id }, data: { name: 'Legacy, edited' } });
    await launchScheduledCampaigns(quiet(at('2026-09-07')));
    expect(await prisma.auditLog.count({ where: { entityId: c.id, action: 'launch_failed' } })).toBe(2);
  });

  it('P12: the scheduler opens only enrollments that can move', async () => {
    await enrol(['person-01', 'person-02']);
    expect((await runSchedulerTick(quiet(at('2026-09-08')))).scanned).toBe(0);
  });

  it('P16: a paused campaign past its hard end date has its people ended', async () => {
    const c = await legacy({ startDate: '2026-08-03', endDate: '2026-09-10', hardStopAtEnd: true });
    await activateCampaign(c.id, quiet(at('2026-08-03')));
    await changeCampaignStatus(c.id, 'PAUSED', SYSTEM_ACTOR, at('2026-08-05'));
    await stopEndedCampaigns(quiet(at('2026-09-14')));
    expect(await prisma.enrollment.count({ where: { campaignId: c.id, status: { in: ['ACTIVE', 'PAUSED'] } } })).toBe(0);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('COMPLETED');
  });

  it('P17: a resume brings overdue steps back under the daily cap', async () => {
    const ids = await enrol(['person-01', 'person-02', 'person-03']);
    for (const id of ids) await pauseEnrollment(id, { reason: 'holiday', actor: SYSTEM_ACTOR, now: at('2026-09-07') });
    await setRules({ dailyCap: 2 });
    for (const id of ids) await resumeEnrollment(id, quiet(at('2026-09-14')));
    const due = await prisma.task.groupBy({ by: ['dueDate'], where: { enrollmentId: { in: ids }, state: 'PENDING' }, _count: { _all: true } });
    expect(due.map((d) => [d.dueDate, d._count._all]).sort()).toEqual([['2026-09-14', 2], ['2026-09-15', 2], ['2026-09-16', 2]]);
  });

  it('P19: a campaign whose people are all in other sequences stays scheduled', async () => {
    await enrol(['person-01', 'person-02']);
    const c = await legacy();
    await activateCampaign(c.id, quiet(at('2026-09-08')));
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SCHEDULED');
    expect(await prisma.auditLog.count({ where: { entityId: c.id, action: 'launch_failed' } })).toBe(1);
  });

  it('P14: an open CRM step a restart left without its CRM task is mirrored once', async () => {
    const [id] = await enrol(['person-01']);
    const later = new Date(Date.now() + 11 * 60_000);
    expect(await mirrorMissedWrites(later)).toEqual({ created: 2 });
    expect(await prisma.task.count({ where: { enrollmentId: id, state: 'PENDING', twentyTaskId: null } })).toBe(0);
    expect(await mirrorMissedWrites(later)).toEqual({ created: 0 });
  });

  it('P28: one email closes one step, even when two steps take it at once', async () => {
    const [id] = await enrol(['person-01']);
    const tasks = await prisma.task.findMany({ where: { enrollmentId: id, state: 'PENDING' } });
    const results = await Promise.all(tasks.map((t) => completeTask({ taskId: t.id, source: 'OBSERVED_MESSAGE', evidenceId: 'message:same' }, quiet(at('2026-09-07')))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe('worker, nightly and next actions (audit 14)', () => {
  it('P13: two workers at once: only one claims the nightly run', async () => {
    const now = new Date();
    const claims = await Promise.all([claimNightly(now), claimNightly(now)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimNightly(now)).toBeNull();
  });

  it('P31: the nightly reconcile reaches back over every day since the last finished run', async () => {
    const now = new Date();
    await prisma.setting.create({ data: { key: NIGHTLY_MARKER, value: { day: addDays(todayIn(workspaceTimezone(), now), -10) } } });
    expect(await nightlyLookbackDays(now, 3)).toBe(11);
  });

  it('P20: a monthly next action keeps the day it was set for after a weekend or a short month', async () => {
    const { rules } = await getSettings();
    // The 15th fell on a Sunday and was done on Tuesday the 17th: the next is the 15th again.
    expect(nextOccurrence('2026-11-17', 'MONTHLY', '2026-11-17', rules.workingDays, 15)).toBe('2026-12-15');
    // The 31st was the 28th in February; March has its 31st.
    expect(nextOccurrence('2027-02-26', 'MONTHLY', '2027-02-26', rules.workingDays, 31)).toBe('2027-03-31');
  });

  it('P21: the worker follows only next actions whose person changed in the CRM', async () => {
    const na = await prisma.nextAction.create({ data: { personId: 'person-01', foUserId: b.users.alisa.id, label: 'Call back', dueDate: '2026-11-20', crmPending: false, crmSyncedAt: new Date() } });
    expect(await syncNextActions(new Date())).toMatchObject({ followed: 0, closed: 0 });
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { nextAction: 'Call back', nextActionDueDate: '2026-11-24', twentyUpdatedAt: new Date(Date.now() + 60_000) } });
    expect(await syncNextActions(new Date())).toMatchObject({ followed: 1 });
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: na.id } })).dueDate).toBe('2026-11-24');
  });

  it('P22: a reply rings the FO of a running or recent sequence, not every past FO for ever', async () => {
    await prisma.enrollment.create({ data: { personId: 'person-01', foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-08-03', status: 'EXITED', exitReason: 'test' } });
    await prisma.touch.create({ data: { personId: 'person-01', channel: 'EMAIL', direction: 'INBOUND', occurredAt: new Date(), summary: 'Re: hello', externalId: 'message:p22' } });
    const alisa = { id: b.users.alisa.id, twentyMemberId: null };
    expect(await prisma.touch.count({ where: notificationScope(alisa, new Date()) })).toBe(1);
    expect(await prisma.touch.count({ where: notificationScope(alisa, new Date(Date.now() + 40 * 86_400_000)) })).toBe(0);
  });

  it('P29: a Settings save keeps the workspace time zone in place', async () => {
    await setRules({ workspaceTimezone: 'Europe/London' });
    await getSettings();
    await setRules({ dailyCap: 30 });
    expect(workspaceTimezone()).toBe('Europe/London');
  });
});
