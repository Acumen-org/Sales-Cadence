import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { addDays, todayIn } from '@/lib/dates';
import { workspaceTimezone } from '@/lib/workspace';
import type { SessionUser } from '@/lib/auth/current-user';
import { coldAudienceIssues } from '@/lib/sandbox/campaigns';
import { buildReports, reportingRange } from '@/lib/reports-query';
import { listActivity, type ActivityPage } from '@/lib/activity-query';
import { repPath } from '@/lib/sandbox/path';
import { listContacts } from '@/lib/sandbox/query';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { sessionOf } from './helpers/cold-campaign';

/**
 * W13 speed budgets (PLAN 9.4) on a workspace loaded like production at its busiest: 5,000 cold
 * contacts, 4,000 open cold steps, 50 reps in 4 pods, and three months of CRM and cold touches, calls
 * and activity. Each case times what the screen waits for on the server, and fails when a budget is
 * missed: an admin's view gets twice a rep's (PLAN 9.4). The timings are printed for the build log.
 */

const CONTACTS = 5000;
const REPS = 50;
const ms = async <T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  // One warm-up, then the timed run: the first query of a shape pays Prisma's and Postgres' set-up.
  await work();
  const t = performance.now();
  const value = await work();
  return { value, ms: Math.round(performance.now() - t) };
};
const report = (name: string, took: number, budget: number) => process.stdout.write(`[volume] ${name}: ${took} ms (budget ${budget} ms)\n`);

describe('cold outreach at production volume (W13)', () => {
  let b: Basics;
  let admin: SessionUser;
  let leader: SessionUser;
  let rep: SessionUser;
  const today = todayIn(workspaceTimezone());

  beforeAll(async () => {
    await resetDb();
    b = await seedBasics();
    const delta = await prisma.pod.create({ data: { name: 'Pod Delta', podOwnerValue: 'DELTA' } });
    const pods = [b.pods.Alisa.id, b.pods.Leigh.id, b.pods.Andrew.id, delta.id];
    const repIds = Array.from({ length: REPS }, (_, i) => `vol-rep-${i}`);
    await prisma.user.createMany({ data: repIds.map((id, i) => ({ id, email: `${id}@cadence.local`, name: `Rep ${i}`, role: i % 10 === 0 ? 'SALES_LEADER' : i % 3 === 0 ? 'SENIOR_FO' : 'JUNIOR_FO', passwordHash: 'x' })) });
    await prisma.userPod.createMany({ data: repIds.map((userId, i) => ({ userId, podId: pods[i % pods.length] })) });
    const podOf = (r: number) => pods[r % pods.length];

    // 5,000 cold contacts: most live, four in five owned.
    const statuses = (i: number) => (i % 20 === 0 ? 'OPTED_OUT' : i % 20 === 1 ? 'REMOVED' : i % 20 === 2 ? 'MOVED' : 'ACTIVE') as 'ACTIVE' | 'OPTED_OUT' | 'REMOVED' | 'MOVED';
    const contacts = Array.from({ length: CONTACTS }, (_, i) => {
      const owned = i % 5 !== 0;
      const r = i % REPS;
      return { id: `vol-c-${String(i).padStart(5, '0')}`, source: 'BELLWETHER' as const, firstName: `First${i}`, lastName: `Last${i}`, sortName: `last${i} first${i}`, email: `p${i}@firm${i % 400}.com`, phone: `+1312${String(5550000 + i).padStart(7, '0')}`, phoneType: 'direct', companyName: `Firm ${i % 400}`, jobTitle: 'Advisor', country: 'US', state: 'IL', productInterest: ['PHH'], status: statuses(i), ownerId: owned ? repIds[r] : null, podId: owned ? podOf(r) : pods[i % pods.length], claimedAt: owned ? new Date() : null, optedOutAt: statuses(i) === 'OPTED_OUT' ? new Date() : null, createdAt: new Date(Date.now() - (i % 90) * 86_400_000) };
    });
    for (let i = 0; i < contacts.length; i += 1000) await prisma.sandboxContact.createMany({ data: contacts.slice(i, i + 1000) });
    const live = contacts.filter((c) => c.status === 'ACTIVE' && c.ownerId);

    // 4,000 open cold steps: 1,500 next steps, and 1,000 contacts in a campaign with 2 or 3 steps each
    // open; the other 900 owned contacts have nothing next, which the No next step view works out.
    await prisma.nextAction.createMany({ data: live.slice(0, 1500).map((c, i) => ({ sandboxContactId: c.id, foUserId: c.ownerId!, label: 'Call back', action: 'CALL' as const, dueDate: addDays(today, (i % 21) - 10), audience: 'SANDBOX' as const })) });
    const campaign = await prisma.campaign.create({ data: { name: 'Volume campaign', audience: 'SANDBOX', sequenceId: b.sequence.id, podId: pods[0], startDate: addDays(today, -20), status: 'ACTIVE', personIds: live.slice(1500, 2500).map((c) => c.id) } });
    const enrollments = live.slice(1500, 2500).map((c, i) => ({ id: `vol-e-${i}`, sandboxContactId: c.id, campaignId: campaign.id, foUserId: c.ownerId!, podId: c.podId, sequenceId: b.sequence.id, startDate: addDays(today, -20), currentStep: 0, status: 'ACTIVE' as const, audience: 'SANDBOX' as const }));
    await prisma.enrollment.createMany({ data: enrollments });
    await prisma.task.createMany({ data: enrollments.flatMap((e, i) => Array.from({ length: 2 + (i % 2) }, (_, k) => ({ enrollmentId: e.id, foUserId: e.foUserId, stepIndex: 0, stepId: 'step-1', stepDay: 1, actionIndex: k, actionId: `a-${k}`, action: (k === 1 ? 'CALL' : 'EMAIL') as 'CALL' | 'EMAIL', label: `Step 1.${k + 1}`, dueDate: addDays(today, (i % 21) - 10), dueAt: new Date(), plannedDate: addDays(today, (i % 21) - 10) }))) });

    // Three months of work: CRM people and their touches, cold touches, calls, and the audit trail
    // a busy CRM writes (step audits are most of it, and the cold Activity view must skip them).
    const people = Array.from({ length: 2000 }, (_, i) => ({ id: `vol-p-${i}`, firstName: `Crm${i}`, lastName: `Person${i}`, sortName: `person${i} crm${i}`, email: `crm${i}@client${i % 300}.com`, companyName: `Client ${i % 300}` }));
    await prisma.personCache.createMany({ data: people });
    // Spread over three months, none in the last day (the newest day is the CRM's step audits below).
    const day = (i: number) => new Date(Date.now() - (1 + (i % 89)) * 86_400_000 - (i % 1440) * 60_000);
    const touches = Array.from({ length: 30_000 }, (_, i) => {
      const cold = i % 4 === 0;
      return { externalId: `vol-t-${i}`, ...(cold ? { sandboxContactId: live[i % live.length].id } : { personId: people[i % people.length].id }), channel: (i % 3 === 0 ? 'CALL' : 'EMAIL') as 'CALL' | 'EMAIL', direction: (i % 7 === 0 ? 'INBOUND' : 'OUTBOUND') as 'INBOUND' | 'OUTBOUND', occurredAt: day(i), summary: i % 7 === 0 ? 'Reply: thanks' : 'Email sent', actorUserId: repIds[i % REPS], audience: (cold ? 'SANDBOX' : 'CRM') as 'SANDBOX' | 'CRM' };
    });
    for (let i = 0; i < touches.length; i += 5000) await prisma.touch.createMany({ data: touches.slice(i, i + 5000) });
    const calls = Array.from({ length: 5000 }, (_, i) => {
      const cold = i % 2 === 0;
      return { source: 'TWILIO_IMPORT' as const, direction: 'OUTBOUND' as const, status: 'COMPLETED' as const, userId: repIds[i % REPS], podId: pods[i % pods.length], startedAt: day(i * 7), talkSec: i % 5 === 0 ? 120 : 0, ...(cold ? { sandboxContactId: live[i % live.length].id, audience: 'SANDBOX' as const } : { personId: people[i % people.length].id, audience: 'CRM' as const }) };
    });
    await prisma.callLog.createMany({ data: calls });
    // The CRM's campaign steps done in those months: what Reports' Sent counts most of.
    const crmEnrollments = people.map((p, i) => ({ id: `vol-crm-e-${i}`, personId: p.id, foUserId: repIds[i % REPS], podId: podOf(i), sequenceId: b.sequence.id, startDate: addDays(today, -90), status: 'ACTIVE' as const, audience: 'CRM' as const }));
    await prisma.enrollment.createMany({ data: crmEnrollments });
    const doneSteps = Array.from({ length: 20_000 }, (_, i) => ({ enrollmentId: crmEnrollments[i % crmEnrollments.length].id, foUserId: crmEnrollments[i % crmEnrollments.length].foUserId, stepIndex: Math.floor(i / crmEnrollments.length), stepId: `s-${Math.floor(i / crmEnrollments.length)}`, stepDay: 1, actionIndex: 0, actionId: 'a', action: 'EMAIL' as const, label: 'Email', dueDate: today, dueAt: day(i * 5), plannedDate: today, state: 'DONE' as const, completedAt: day(i * 5), completionSource: 'MANUAL' as const }));
    for (let i = 0; i < doneSteps.length; i += 5000) await prisma.task.createMany({ data: doneSteps.slice(i, i + 5000) });
    // The worst case for the cold Activity view: the newest 20,000 events are the CRM's step audits, so
    // it reads past all of them before it finds a cold event.
    const audits = Array.from({ length: 20_000 }, (_, i) => ({ entityType: 'task', entityId: `vol-crm-task-${i}`, action: 'completed', actorType: 'USER' as const, actorId: repIds[i % REPS], createdAt: new Date(Date.now() - i * 4000) }));
    for (let i = 0; i < audits.length; i += 5000) await prisma.auditLog.createMany({ data: audits.slice(i, i + 5000) });
    await prisma.auditLog.createMany({ data: live.slice(0, 300).map((c, i) => ({ entityType: 'sandbox_contact', entityId: c.id, action: 'claimed', actorType: 'USER' as const, actorId: c.ownerId, createdAt: day(i * 97) })) });

    admin = await sessionOf(b.users.ria.id);
    leader = await sessionOf(repIds[0]);
    rep = await sessionOf(repIds[1]);
  }, 600_000);

  it('S7 speed note: the cold audience check for 3,000 contacts at once (planning a big cold campaign)', async () => {
    const ids = (await prisma.sandboxContact.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, take: 3000, orderBy: { id: 'asc' } })).map((c) => c.id);
    const { value, ms: took } = await ms(() => coldAudienceIssues(ids, { podId: b.pods.Alisa.id, podName: 'Pod Alisa', foIds: [], anyPod: true }));
    report('coldAudienceIssues, 3,000 contacts', took, 3000);
    expect(value.length).toBeGreaterThan(0);
    expect(took).toBeLessThan(3000);
  });

  it('S8 speed note: Reports, All outreach, one month, all pods (admin)', async () => {
    const range = reportingRange(addDays(today, -30), today, today);
    const { ms: took } = await ms(() => buildReports(admin, today, { range, audience: 'all' }));
    report('Reports, All outreach, a month, all pods, admin', took, 3000);
    expect(took).toBeLessThan(3000);
    const quarter = reportingRange(addDays(today, -90), today, today);
    const { ms: q } = await ms(() => buildReports(admin, today, { range: quarter, audience: 'all' }));
    report('Reports, All outreach, three months, all pods, admin', q, 6000);
    expect(q).toBeLessThan(6000);
  });

  it('S8 speed note: Activity filtered to Cold outreach, when the CRM\'s own events are most of the feed (admin)', async () => {
    // The newest 20,000 events are the CRM's: each page reads a bounded stretch, says how far back it
    // looked, and "Load older activity" carries on from there until the cold events come.
    let cursor: string | null = null;
    let slowest = 0;
    const found: string[] = [];
    for (let page = 0; page < 10 && !found.length; page++) {
      const before: string | null = cursor;
      const { value, ms: took }: { value: ActivityPage; ms: number } = await ms(() => listActivity({ audience: 'cold', viewer: admin, limit: 60, before }));
      slowest = Math.max(slowest, took);
      expect(value.items.every((i) => i.audience === 'cold')).toBe(true);
      if (!value.items.length) expect(value).toEqual(expect.objectContaining({ hasMore: true, lookedTo: expect.any(Date) }));
      found.push(...value.items.map((i) => i.id));
      cursor = value.nextCursor;
    }
    report('Activity, Cold outreach only, admin, slowest page', slowest, 2000);
    expect(found.length).toBeGreaterThan(0);
    expect(slowest).toBeLessThan(2000);
  });

  it('S10 speed note: the step strip and the list\'s worked-out views, for an admin, a leader and a rep', async () => {
    for (const [who, user, budget] of [['admin', admin, 800], ['leader', leader, 400], ['rep', rep, 400]] as const) {
      const strip = await ms(() => repPath(user));
      report(`step strip, ${who}`, strip.ms, budget);
      expect(strip.ms).toBeLessThan(budget);
    }
    for (const [who, user, budget] of [['admin', admin, 800], ['rep', rep, 400]] as const) {
      for (const view of ['all', 'no_next_step', 'ready']) {
        const list = await ms(() => listContacts(user, { view, owner: '' }));
        report(`contacts list ?view=${view}, ${who}`, list.ms, budget);
        expect(list.ms).toBeLessThan(budget);
      }
    }
  });
});
