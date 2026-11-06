import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { CampaignDraftSchema, type CampaignDraft } from '@/lib/campaign-planner';
import { campaignPeoplePage } from '@/lib/campaign-people-page';
import { activateCampaign } from '@/lib/engine/campaigns';
import { bellWords } from '@/lib/notifications';
import { describeAudit } from '@/lib/audit-format';
import { runTool } from '../scripts/local-runtime';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';
import { coldDraft, publishColdCampaign, sessionOf } from './helpers/cold-campaign';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), usePathname: () => '/campaigns', useSearchParams: () => new URLSearchParams(), redirect: (to: string) => { throw new Error(`redirect:${to}`); }, notFound: () => { throw new Error('not found'); } }));
const { PlannedCampaignDetail } = await import('@/components/campaigns/planned-campaign-detail');

/**
 * Stage S11a (W14): the release's last clean-ups. Each migration is run a second time here on rows
 * made to look as they did before it, which shows what it does and that a second run changes nothing.
 */

/** Run one migration's SQL again, as `prisma migrate deploy` ran it. */
function rerun(name: string) {
  const file = path.join('prisma', 'migrations', name, 'migration.sql');
  const r = runTool(process.cwd(), 'prisma', ['db', 'execute', '--file', file, '--url', process.env.DATABASE_URL!], process.env, 'pipe');
  if (r.status !== 0) throw new Error(`${name} failed: ${r.stderr || r.stdout}`);
}

const LEGACY = '20261106300000_cold_campaigns_on_the_studio';

describe('cold outreach, the finish (S11a, W14)', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });

  it('PLAN 9.7 step 14: cold campaigns from before the studio are put on it, so nothing reaches the old launcher or page', async () => {
    const alisa = b.users.alisa.id, karson = b.users.karson.id;
    const sally = await prisma.user.create({ data: { email: 'sally@cadence.local', name: 'Sally Leader', role: 'SALES_LEADER', passwordHash: 'x', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
    const gone = await prisma.user.create({ data: { email: 'gone@cadence.local', name: 'Gone Rep', role: 'JUNIOR_FO', passwordHash: 'x', active: false } });
    const [one, two, three] = await Promise.all([readyContact(alisa, b.pods.Alisa.id), readyContact(karson, b.pods.Alisa.id), readyContact(karson, b.pods.Alisa.id)]);
    // As the old Start campaign form left them: no studio plan, a library sequence, no end date.
    const old = (name: string, status: 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED', personIds: string[], createdById: string) =>
      prisma.campaign.create({ data: { name, audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds, startDate: '2026-11-04', status, createdById, approvedAt: status === 'DRAFT' ? null : new Date('2026-11-03T12:00:00Z'), approvedById: status === 'DRAFT' ? null : alisa, startsPerFoPerDay: 5 } });
    const scheduled = await old('Waiting to start', 'SCHEDULED', [one.id], alisa);
    const paused = await old('Paused before it started', 'PAUSED', [one.id], gone.id);
    const running = await old('Running since 4 Nov', 'ACTIVE', [two.id], alisa);
    const enrollment = await prisma.enrollment.create({ data: { sandboxContactId: two.id, campaignId: running.id, foUserId: karson, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-04', currentStep: 0, audience: 'SANDBOX' } });
    const task = await prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId: karson, stepIndex: 0, stepId: 's1', stepDay: 1, actionIndex: 0, actionId: 'a1', action: 'EMAIL', label: 'Email 1', dueDate: '2026-11-04', dueAt: new Date('2026-11-04T09:00:00Z'), plannedDate: '2026-11-04' } });
    const done = await old('Finished', 'COMPLETED', [three.id], alisa);
    await prisma.enrollment.create({ data: { sandboxContactId: three.id, campaignId: done.id, foUserId: karson, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-04', status: 'COMPLETED', audience: 'SANDBOX' } });
    const draft = await old('Never sent', 'DRAFT', [three.id], alisa);
    const crm = await prisma.campaign.create({ data: { name: 'CRM from before', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: ['person-01'], startDate: '2026-11-04', status: 'SCHEDULED' } });
    const studio = (await publishColdCampaign(await sessionOf(alisa), coldDraft(b.pods.Alisa.id, [(await readyContact(alisa, b.pods.Alisa.id)).id], [alisa], { name: 'Built in the studio' }))).campaign;
    const studioBefore = await prisma.campaign.findUniqueOrThrow({ where: { id: studio.id } });

    rerun(LEGACY);

    const get = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });
    // Not started: back to draft, nothing was sent, its creator told; a creator who left, the pod's leaders.
    expect(await get(scheduled.id)).toEqual(expect.objectContaining({ status: 'DRAFT', approvedAt: null, approvedById: null }));
    expect(await get(paused.id)).toEqual(expect.objectContaining({ status: 'DRAFT', approvedAt: null }));
    const told = await prisma.notification.findMany({ where: { kind: 'campaign_back_to_draft' }, orderBy: { userId: 'asc' } });
    expect(told.map((n) => [n.userId, (n.payload as { campaignId: string }).campaignId]).sort()).toEqual([[alisa, scheduled.id], [sally.id, paused.id]].sort());
    expect(bellWords(told[0], { people: new Map(), contacts: new Map(), users: new Map() }).title).toBe('Cold campaigns are now built in the campaign studio, so this one is a draft again');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: scheduled.id, action: 'back_to_draft' } });
    expect(audit.details).toEqual(expect.objectContaining({ from: 'SCHEDULED', to: 'DRAFT', approvedById: alisa }));
    expect(describeAudit('back_to_draft', {}, null, 'campaign').known).toBe(true);
    expect(describeAudit('studio_plan_added', {}, null, 'campaign').known).toBe(true);

    // Every one now has the plan the studio opens: its own fields, one Default group with the sequence's steps.
    const plan = (await get(scheduled.id)).plannerDraft as CampaignDraft;
    expect(plan).toEqual(expect.objectContaining({ name: 'Waiting to start', podId: b.pods.Alisa.id, startDate: '2026-11-04', endDate: '2026-12-16', personIds: [one.id], fos: [], defaultBatchSize: 5, outreachEdited: true }));
    expect(plan.flows).toEqual([expect.objectContaining({ id: 'default', name: 'Default', steps: b.sequence.steps })]);
    // It is a draft the studio can publish once someone picks a product and who runs it.
    expect(CampaignDraftSchema.safeParse({ ...plan, startDate: '2026-11-09', endDate: '2026-12-18', productInterest: ['PHH'], fos: [{ id: alisa, batchSize: 5 }] }).success).toBe(true);

    // A running one carries on exactly as it was, with the reps running it as its team.
    const live = await get(running.id);
    expect(live).toEqual(expect.objectContaining({ status: 'ACTIVE', endDate: null, publishedPlan: null }));
    expect((live.plannerDraft as CampaignDraft).fos).toEqual([{ id: karson, batchSize: 5 }]);
    expect(await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).toEqual(expect.objectContaining({ status: 'ACTIVE', currentStep: 0, scheduleDates: [] }));
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).state).toBe('PENDING');
    expect((await get(done.id)).plannerDraft).toBeTruthy();
    expect(await get(draft.id)).toEqual(expect.objectContaining({ status: 'DRAFT', plannerDraft: expect.objectContaining({ name: 'Never sent' }) }));
    // CRM campaigns and studio-built cold ones are not touched.
    expect((await get(crm.id)).plannerDraft).toBeNull();
    expect((await get(studio.id)).updatedAt).toEqual(studioBefore.updatedAt);
    expect(await prisma.auditLog.count({ where: { action: 'studio_plan_added' } })).toBe(5);

    // The one campaign page draws it: its contacts on their own pages, and no end date it never had.
    const people = await campaignPeoplePage(live, undefined, undefined);
    const html = renderToStaticMarkup(createElement(PlannedCampaignDetail, { campaign: live, manager: true, people }));
    expect(html).toContain('When the last contact finishes');
    expect(html).toContain(`/cold-outreach/${two.id}`);

    // A second run changes nothing.
    rerun(LEGACY);
    expect(await prisma.auditLog.count({ where: { action: { in: ['studio_plan_added', 'back_to_draft'] } } })).toBe(7);
    expect(await prisma.notification.count({ where: { kind: 'campaign_back_to_draft' } })).toBe(2);
  });

  it('W14: a cold campaign is launched only from its published calendar; the old launcher is gone', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    // A cold campaign without a studio plan (none can be made since the release) does not start.
    const bare = await prisma.campaign.create({ data: { name: 'No plan', audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [c.id], startDate: '2026-11-04', status: 'SCHEDULED' } });
    await expect(activateCampaign(bare.id, { actor: SYSTEM_ACTOR, now: new Date('2026-11-04T16:00:00Z'), skipSync: true })).rejects.toThrow('Not started: this campaign has no finished calendar');
    expect(await prisma.enrollment.count({ where: { campaignId: bare.id } })).toBe(0);
    expect('activateSandboxCampaign' in (await import('@/lib/sandbox/campaigns'))).toBe(false);
  });
});
