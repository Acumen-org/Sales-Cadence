import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { activateCampaign } from '@/lib/engine/campaigns';
import { stopEndedCampaigns } from '@/lib/engine/tasks';
import { resetDb, seedBasics, type Basics } from './helpers/db';

let b: Basics;
const at = (iso: string) => new Date(`${iso}T18:00:00Z`);
beforeEach(async () => { await resetDb(); b = await seedBasics(); });

describe('P02: the end-date stop', () => {
  it('ends a campaign in batches, each its own transaction, and records the total once', async () => {
    const c = await prisma.campaign.create({ data: { name: 'Studio', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-08-03', endDate: '2026-09-10', status: 'SCHEDULED', personIds: ['person-01', 'person-02'], assignmentMode: 'ROUND_ROBIN', productInterest: ['PHH'], hardStopAtEnd: true } });
    await activateCampaign(c.id, { actor: SYSTEM_ACTOR, now: at('2026-08-03'), skipSync: true });
    await stopEndedCampaigns({ actor: SYSTEM_ACTOR, now: at('2026-09-14'), skipSync: true }, 1);
    expect(await prisma.enrollment.count({ where: { campaignId: c.id, status: 'EXITED', exitReason: 'campaign_ended' } })).toBe(2);
    expect(await prisma.task.count({ where: { enrollment: { campaignId: c.id }, state: 'PENDING' } })).toBe(0);
    const ended = await prisma.auditLog.findMany({ where: { entityType: 'campaign', entityId: c.id, action: 'ended' } });
    expect(ended).toHaveLength(1);
    expect(ended[0].details).toMatchObject({ endedEnrollments: 2 });
  });
});
