import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { enrollPeople, previewEnrollment } from '@/lib/engine/enrollment';
import { addPeopleToCampaignAction, removePeopleFromCampaignAction } from '@/lib/actions/campaigns';
import { campaignMemberWhere, membershipFor } from '@/lib/campaign-membership';
import { listCampaigns } from '@/lib/campaigns-query';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.user, requireAdmin: auth.user, toActor: (user: SessionUser) => user }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const asUser = (user: User, podIds: string[]): SessionUser => ({ ...user, podIds, pods: podIds.map((id) => ({ id, name: id })) });
const form = (values: Record<string, string>) => { const fd = new FormData(); for (const [key, value] of Object.entries(values)) fd.set(key, value); return fd; };

/**
 * Membership is one idea before and after launch. Adding to an upcoming campaign grows its list;
 * removing from a running one ends the person's sequence with reason `removed` and cancels their
 * open touches; a person promised to one upcoming campaign is refused by another; the People
 * filter for a launched campaign reads its enrollments, not the list it launched from; and an FO
 * sees upcoming campaigns that hold their people even though nothing is enrolled yet.
 */
describe('campaign membership writes', () => {
  let b: Basics;
  let leader: SessionUser;
  const now = new Date('2026-09-09T09:00:00Z');

  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    leader = { ...asUser(b.users.alisa, [b.pods.Alisa.id]), role: 'SALES_LEADER' };
    auth.user.mockResolvedValue(leader);
  });

  const upcoming = (personIds: string[], name = 'Autumn') => prisma.campaign.create({ data: { name, sequenceId: b.sequence.id, podId: b.pods.Alisa.id, createdById: b.users.alisa.id, status: 'SCHEDULED', startDate: '2026-10-05', endDate: '2026-11-13', personIds } });

  it('adds people to an upcoming campaign and refuses those the pod leader cannot manage', async () => {
    const c = await upcoming(['person-01']);
    const added = await addPeopleToCampaignAction(form({ campaignId: c.id, personIds: JSON.stringify(['person-02', 'person-03']) }));
    expect(added.ok).toBe(true);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).personIds.sort()).toEqual(['person-01', 'person-02', 'person-03']);
    // Everyone already in: nothing changes, and it says so.
    const again = await addPeopleToCampaignAction(form({ campaignId: c.id, personIds: JSON.stringify(['person-02']) }));
    expect(again.ok).toBe(true);
    expect(again.ok && again.message).toMatch(/already/);
    // Biz Ops reads everything and changes nothing.
    auth.user.mockResolvedValue({ ...asUser(b.users.daniel, []), role: 'BIZ_OPS' });
    const refused = await addPeopleToCampaignAction(form({ campaignId: c.id, personIds: JSON.stringify(['person-04']) }));
    expect(refused.ok).toBe(false);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).personIds).toHaveLength(3);
  });

  it('removes people from an upcoming campaign, and from a running one by ending their sequence', async () => {
    const c = await upcoming(['person-01', 'person-02']);
    const dropped = await removePeopleFromCampaignAction(form({ campaignId: c.id, personIds: JSON.stringify(['person-02']) }));
    expect(dropped.ok).toBe(true);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).personIds).toEqual(['person-01']);

    const running = await prisma.campaign.create({ data: { name: 'Running', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, createdById: b.users.alisa.id, status: 'ACTIVE', startDate: '2026-09-09', personIds: ['person-03', 'person-04'] } });
    const outcome = await enrollPeople({ personIds: ['person-03', 'person-04'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, campaignId: running.id, startDate: '2026-09-09', assignment: { mode: 'FIXED' as const, foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR }, { now });
    expect(outcome.enrolled).toHaveLength(2);
    const before = await prisma.task.count({ where: { enrollment: { personId: 'person-03' }, state: 'PENDING' } });
    expect(before).toBeGreaterThan(0);
    const removed = await removePeopleFromCampaignAction(form({ campaignId: running.id, personIds: JSON.stringify(['person-03']) }));
    expect(removed.ok).toBe(true);
    const e = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-03', campaignId: running.id } });
    expect(e.status).toBe('EXITED');
    expect(e.exitReason).toBe('removed');
    expect(await prisma.task.count({ where: { enrollmentId: e.id, state: 'PENDING' } })).toBe(0);
    // The other person is untouched.
    expect((await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-04', campaignId: running.id } })).status).toBe('ACTIVE');
    // The People filter for a launched campaign reads its enrollments: the removed person is still
    // history there, and someone on the original list who never enrolled is not a member.
    const where = await campaignMemberWhere(running.id);
    const members = (await prisma.personCache.findMany({ where, select: { id: true } })).map((p) => p.id).sort();
    expect(members).toEqual(['person-03', 'person-04']);
    await prisma.campaign.update({ where: { id: running.id }, data: { personIds: ['person-03', 'person-04', 'person-05'] } });
    expect((await prisma.personCache.findMany({ where: await campaignMemberWhere(running.id), select: { id: true } })).map((p) => p.id)).not.toContain('person-05');
  });

  it('refuses a person already promised to another upcoming campaign', async () => {
    await upcoming(['person-01'], 'First');
    const second = await upcoming([], 'Second');
    const preview = await previewEnrollment({ personIds: ['person-01', 'person-02'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, campaignId: second.id, startDate: '2026-10-05', assignment: { mode: 'OWNER' }, actor: SYSTEM_ACTOR });
    expect('error' in preview).toBe(false);
    if ('error' in preview) return;
    expect(preview.candidates.map((c) => c.personId)).toEqual(['person-02']);
    expect(preview.conflicts).toEqual([expect.objectContaining({ personId: 'person-01', reason: 'scheduled_elsewhere', detail: 'Scheduled in First' })]);
    // The campaign's own list is not "elsewhere".
    const own = await previewEnrollment({ personIds: ['person-01'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, campaignId: (await prisma.campaign.findFirstOrThrow({ where: { name: 'First' } })).id, startDate: '2026-10-05', assignment: { mode: 'OWNER' }, actor: SYSTEM_ACTOR });
    expect('error' in own ? [] : own.conflicts).toEqual([]);
  });

  it('shows an FO the upcoming campaigns that hold their people', async () => {
    // person-01 is owned by Alisa in Twenty; person-20 by Andrew.
    await upcoming(['person-01'], 'Alisa soon');
    await prisma.campaign.create({ data: { name: 'Andrew soon', sequenceId: b.sequence.id, podId: b.pods.Andrew.id, createdById: b.users.andrew.id, status: 'SCHEDULED', startDate: '2026-10-05', personIds: ['person-20'] } });
    const admin = asUser(b.users.ria, []);
    const forAlisa = (await listCampaigns(admin, { foUserId: b.users.alisa.id })).map((c) => c.name);
    expect(forAlisa).toContain('Alisa soon');
    expect(forAlisa).not.toContain('Andrew soon');
    const all = (await listCampaigns(admin, {})).map((c) => c.name);
    expect(all).toEqual(expect.arrayContaining(['Alisa soon', 'Andrew soon']));
    // Before launch the person's row already names the campaign.
    expect((await membershipFor(['person-01'])).get('person-01')?.[0]).toEqual(expect.objectContaining({ campaignName: 'Alisa soon', kind: 'upcoming' }));
  });
});
