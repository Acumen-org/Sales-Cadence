import { beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { activateCampaign } from '@/lib/engine/campaigns';
import { runSchedulerTick } from '@/lib/engine/tasks';
import { campaignChoices, campaignMemberWhere, membershipFor, membershipLabel, primaryMembership, startingSoon } from '@/lib/campaign-membership';
import type { SessionUser } from '@/lib/auth/current-user';
import { resetDb, seedBasics, type Basics } from './helpers/db';

/**
 * A campaign runs between two dates. Before it starts it is still somebody's campaign; at its end
 * people mid-sequence finish unless it was told to stop them; and nobody starts when the window
 * has no room to finish them.
 */
let b: Basics;
const at = (iso: string) => new Date(`${iso}T18:00:00Z`);
const session = (user: Basics['users']['ria'], podIds: string[] = []): SessionUser => ({ ...user, pods: [], podIds });

beforeEach(async () => { await resetDb(); b = await seedBasics(); });

async function campaign(data: Partial<Prisma.CampaignUncheckedCreateInput> = {}) {
  const base: Prisma.CampaignUncheckedCreateInput = { name: 'Window', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-14', endDate: '2026-11-13', status: 'SCHEDULED', personIds: ['person-01', 'person-02'], assignmentMode: 'ROUND_ROBIN', productInterest: ['PHH'] };
  return prisma.campaign.create({ data: { ...base, ...data } });
}

describe('before the start', () => {
  it('a scheduled campaign is visible on its people, its accounts and the week ahead', async () => {
    const c = await campaign({ startDate: '2026-09-21', endDate: '2026-11-20' });
    const membership = await membershipFor(['person-01', 'person-03']);
    const first = primaryMembership(membership.get('person-01'));
    expect(first).toMatchObject({ campaignId: c.id, kind: 'upcoming', enrollmentId: null, step: null, steps: 8 });
    expect(membershipLabel(first!)).toEqual({ label: 'Upcoming', tone: 'purple' });
    expect(membership.get('person-03')).toBeUndefined();

    const soon = await startingSoon(session(b.users.alisa, [b.pods.Alisa.id]), { now: at('2026-09-18') });
    expect(soon).toHaveLength(1);
    expect(soon[0]).toMatchObject({ id: c.id, people: 2, daysUntil: 3 });
    expect(await startingSoon(session(b.users.alisa, [b.pods.Alisa.id]), { now: at('2026-09-01') })).toEqual([]);

    const where = await campaignMemberWhere(c.id);
    const members = await prisma.personCache.findMany({ where, select: { id: true } });
    expect(members.map((m) => m.id).sort()).toEqual(['person-01', 'person-02']);

    const choices = await campaignChoices(session(b.users.ria), { manageOnly: true });
    expect(choices.find((x) => x.id === c.id)).toMatchObject({ kind: 'upcoming', members: 2 });
  });
});

describe('the launch', () => {
  it('a window too short for the plan starts nobody and leaves the campaign scheduled', async () => {
    // The default plan spans 31 days; five days is not a window.
    const c = await campaign({ startDate: '2026-09-14', endDate: '2026-09-18' });
    const result = await activateCampaign(c.id, { actor: SYSTEM_ACTOR, now: at('2026-09-14'), skipSync: true });
    expect(result.enrolled).toBe(0);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SCHEDULED');
    expect(await prisma.auditLog.count({ where: { entityType: 'campaign', entityId: c.id, action: 'launch_failed' } })).toBe(1);
  });

  it('a window that fits starts everyone and paces them by the planner', async () => {
    const c = await campaign();
    const result = await activateCampaign(c.id, { actor: SYSTEM_ACTOR, now: at('2026-09-14'), skipSync: true });
    expect(result.enrolled).toBe(2);
    const enrollments = await prisma.enrollment.findMany({ where: { campaignId: c.id } });
    expect(enrollments.every((e) => e.startDate >= '2026-09-14' && e.startDate <= '2026-11-13')).toBe(true);
    const membership = await membershipFor(['person-01']);
    expect(primaryMembership(membership.get('person-01'))).toMatchObject({ kind: 'running', enrollmentStatus: 'ACTIVE' });
  });
});

describe('the end date', () => {
  async function running(hardStopAtEnd: boolean) {
    const c = await campaign({ startDate: '2026-08-03', endDate: '2026-09-10', hardStopAtEnd });
    await activateCampaign(c.id, { actor: SYSTEM_ACTOR, now: at('2026-08-03'), skipSync: true });
    expect(await prisma.enrollment.count({ where: { campaignId: c.id, status: 'ACTIVE' } })).toBe(2);
    return c;
  }

  it('by default people mid-sequence finish and the campaign shows them running over', async () => {
    const c = await running(false);
    await runSchedulerTick({ actor: SYSTEM_ACTOR, now: at('2026-09-14'), skipSync: true });
    expect(await prisma.enrollment.count({ where: { campaignId: c.id, status: 'ACTIVE' } })).toBe(2);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('ACTIVE');
  });

  it('told to stop, it ends what is left on the day and cancels their open touches', async () => {
    const c = await running(true);
    const openBefore = await prisma.task.count({ where: { enrollment: { campaignId: c.id }, state: 'PENDING' } });
    expect(openBefore).toBeGreaterThan(0);
    await runSchedulerTick({ actor: SYSTEM_ACTOR, now: at('2026-09-14'), skipSync: true });
    expect(await prisma.enrollment.count({ where: { campaignId: c.id, status: { in: ['ACTIVE', 'PAUSED'] } } })).toBe(0);
    expect(await prisma.enrollment.count({ where: { campaignId: c.id, status: 'EXITED', exitReason: 'campaign_ended' } })).toBe(2);
    expect(await prisma.task.count({ where: { enrollment: { campaignId: c.id }, state: 'PENDING' } })).toBe(0);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('COMPLETED');
  });
});
