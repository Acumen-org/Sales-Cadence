import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { campaignPeoplePage } from '@/lib/campaign-people-page';
import { addDays, todayIn } from '@/lib/dates';
import { workspaceTimezone } from '@/lib/workspace';
import { resetDb, seedBasics, type Basics } from './helpers/db';

/**
 * Owner, 25 September 2026: "17 people have overdue steps" on a running campaign while Tasks had
 * none. The campaign counted a step by its first due date; Tasks counts it by the day it is
 * worked - its snoozed day - and holds back what a pause stopped. The campaign now counts the same.
 */
describe("a campaign's overdue count", () => {
  let b: Basics;
  beforeEach(async () => { await resetDb(); b = await seedBasics(); });

  it('counts by the snoozed day and leaves out paused outreach, as Tasks does', async () => {
    const today = todayIn(workspaceTimezone());
    const campaign = await prisma.campaign.create({ data: { name: 'Running', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: addDays(today, -10), status: 'ACTIVE' } });
    const people = ['person-01', 'person-02', 'person-03', 'person-04'];
    const step = async (personId: string, over: { snoozedTo?: string | null; status?: 'ACTIVE' | 'PAUSED'; dueDate?: string }) => {
      const e = await prisma.enrollment.create({ data: { personId, foUserId: b.users.alisa.id, sequenceId: b.sequence.id, campaignId: campaign.id, podId: b.pods.Alisa.id, startDate: addDays(today, -10), status: over.status ?? 'ACTIVE' } });
      const due = over.dueDate ?? addDays(today, -3);
      await prisma.task.create({ data: { enrollmentId: e.id, foUserId: b.users.alisa.id, stepIndex: 0, stepId: 's1', stepDay: 1, actionIndex: 0, actionId: 'a1', action: 'EMAIL', label: 'Email 1', dueDate: due, dueAt: new Date(`${due}T14:00:00Z`), plannedDate: due, snoozedTo: over.snoozedTo ?? null } });
    };
    await step(people[0], {}); // overdue
    await step(people[1], { snoozedTo: addDays(today, 2) }); // snoozed ahead: not overdue
    await step(people[2], { status: 'PAUSED' }); // held by a pause: not overdue
    await step(people[3], { dueDate: today }); // due today: not overdue
    const page = await campaignPeoplePage({ id: campaign.id, personIds: people, plannerDraft: null, publishedPlan: null }, undefined, undefined);
    expect(page.stats.late).toBe(1);
  });
});
