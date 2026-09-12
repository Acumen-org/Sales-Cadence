import { beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/current-user';
import { campaignDetail, listCampaigns, nonReplierCandidates } from '@/lib/campaigns-query';
import { parsePersonIds } from '@/lib/csv';
import { completeTask, enrollPeople, markReplied } from '@/lib/engine';
import { buildReports } from '@/lib/reports-query';
import { listSequences, sequenceFunnel } from '@/lib/sequences-query';
import { parseSteps } from '@/lib/sequences/steps';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const at = (date: string) => new Date(`${date}T10:00:00Z`);

function sessionUser(u: { id: string; email: string; name: string; role: Role; timezone: string; twentyMemberId: string | null; dailyCap: number | null }, podIds: string[]): SessionUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timezone: u.timezone, twentyMemberId: u.twentyMemberId, dailyCap: u.dailyCap, podIds, pods: podIds.map((id) => ({ id, name: id })) };
}

describe('csv parsing', () => {
  it('reads ids from lines, csv with header, and csv without header', () => {
    expect(parsePersonIds('person-01\nperson-02, person-03\n\nperson-01').ids).toEqual(['person-01', 'person-02', 'person-03']);
    const csv = 'Name,Company,Id\n"Nina Halvorsen",Acme,3f6c1c5e-1111-4222-8333-444444444444\nTomas,Acme,person-02\n';
    const r = parsePersonIds(csv);
    expect(r.column).toBe('Id');
    expect(r.ids).toEqual(['3f6c1c5e-1111-4222-8333-444444444444', 'person-02']);
    expect(parsePersonIds('person-05;x\nperson-06;y').ids).toEqual(['person-05', 'person-06']);
    expect(parsePersonIds('').ids).toEqual([]);
  });
});

describe('campaigns and reports', () => {
  let b: Basics;
  let campaignId: string;

  beforeAll(async () => {
    await resetDb();
    b = await seedBasics();
    const campaign = await prisma.campaign.create({
      data: { name: 'SaaStr follow-up', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-07', status: 'ACTIVE', personIds: ['person-01', 'person-02', 'person-03', 'person-04'] },
    });
    campaignId = campaign.id;
    await enrollPeople(
      { personIds: ['person-01', 'person-02', 'person-03', 'person-04'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, campaignId, startDate: '2026-09-07', assignment: { mode: 'OWNER' }, actor: SYSTEM_ACTOR },
      { now: at('2026-09-07') },
    );
    // person-01 replies; person-02 completes email 1; person-03 untouched (will be overdue); person-04 completes whole sequence quickly
    const e1 = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-01' } });
    await markReplied(e1.id, { at: at('2026-09-08'), actor: SYSTEM_ACTOR });
    const t2 = await prisma.task.findFirstOrThrow({ where: { enrollment: { personId: 'person-02' }, label: 'Email 1' } });
    await completeTask({ taskId: t2.id, source: 'MANUAL' }, { actor: SYSTEM_ACTOR, now: at('2026-09-07') });
    const e4 = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-04' } });
    for (let step = 0; step < 8; step++) {
      const pending = await prisma.task.findMany({ where: { enrollmentId: e4.id, state: 'PENDING' } });
      for (const t of pending) await completeTask({ taskId: t.id, source: 'MANUAL' }, { actor: SYSTEM_ACTOR, now: at('2026-09-07') });
    }
  });

  it('lists campaigns with counts and rates, for every reader', async () => {
    const admin = sessionUser(b.users.ria, []);
    const [c] = await listCampaigns(admin);
    expect(c.name).toBe('SaaStr follow-up');
    expect(c.counts).toMatchObject({ total: 4, replied: 1, completed: 1 });
    expect(c.counts.active).toBe(2);
    expect(c.replyRate).toBeCloseTo(0.25);
    // Leigh reads Alisa's pod campaign too: reading is not pod-scoped, running it is.
    const leigh = sessionUser(b.users.leigh, [b.pods.Leigh.id]);
    expect(await listCampaigns(leigh)).toHaveLength(1);
  });

  it('builds the campaign detail funnel and per-FO table', async () => {
    const d = await campaignDetail(campaignId, '2026-09-10');
    expect(d).not.toBeNull();
    expect(d!.byStep[0]).toMatchObject({ day: 1, reached: 4 });
    expect(d!.byStep[0].done).toBe(2); // person-02 and person-04 did email 1; person-01 replied without doing it, person-03 did nothing
    expect(d!.byStep[7].done).toBe(1); // only person-04 reached the end
    // person-03 (owner Alisa) never touched: 2 tasks overdue on step 1 by the 10th
    expect(d!.byStep[0].overdue).toBeGreaterThanOrEqual(2);
    const alisaRow = d!.byFo.find((f) => f.name.startsWith('Alisa'))!;
    expect(alisaRow.total).toBeGreaterThanOrEqual(2);
    expect(d!.podFos.map((f) => f.name).sort()).toEqual(['Alisa Marsh', 'Karson Reed']);
  });

  it('finds non-repliers who finished the sequence', async () => {
    const soon = await nonReplierCandidates(campaignId, 0, at('2026-09-08'));
    expect(soon.map((c) => c.personId)).toEqual(['person-04']);
    const later = await nonReplierCandidates(campaignId, 30, at('2026-09-08'));
    expect(later).toHaveLength(0);
  });

  it('computes the sequence list and per-step funnel', async () => {
    const [s] = await listSequences();
    expect(s.stepCount).toBe(8);
    expect(s.lastDay).toBe(23);
    expect(s.enrollments.total).toBe(4);
    const steps = parseSteps(b.sequence.steps as unknown);
    const funnel = await sequenceFunnel(b.sequence.id, steps, '2026-09-10');
    expect(funnel[0].done).toBe(2);
    expect(funnel[0].replied).toBe(1); // person-01 replied while on step 1
    expect(funnel[0].overdue).toBeGreaterThanOrEqual(2);
    expect(funnel[7].done).toBe(1);
  });

  it('reports roll up by pod, FO, campaign, sequence and channel with overdue and stalled lists', async () => {
    const admin = sessionUser(b.users.ria, []);
    const r = await buildReports(admin, '2026-09-20');
    expect(r.totals.enrollments).toBe(4);
    expect(r.totals.replied).toBe(1);
    const pod = r.byPod.find((p) => p.label === 'Pod Alisa')!;
    expect(pod.enrolled).toBe(4);
    expect(pod.replied).toBe(1);
    expect(pod.completed).toBe(1);
    expect(pod.replyRate).toBeCloseTo(0.25);
    expect(r.byCampaign[0].label).toBe('SaaStr follow-up');
    expect(r.bySequence[0].tasksDone).toBeGreaterThanOrEqual(13);
    const email = r.channels.find((c) => c.action === 'EMAIL')!;
    expect(email.manual).toBeGreaterThanOrEqual(4);

    // A junior sees only their own enrollments
    const karson = sessionUser(b.users.karson, [b.pods.Alisa.id]);
    const rk = await buildReports(karson, '2026-09-20');
    expect(rk.totals.enrollments).toBeLessThan(4);
  });
});
