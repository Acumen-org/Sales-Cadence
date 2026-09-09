import { beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/current-user';
import { listActivity } from '@/lib/activity-query';
import { buildReports, reportingRange } from '@/lib/reports-query';
import { prisma } from '@/lib/db';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const at = (iso: string) => new Date(iso);
const asUser = (user: User, podIds: string[]): SessionUser => ({ ...user, podIds, pods: podIds.map((id) => ({ id, name: id })) });

describe('reporting dates', () => {
  it('uses inclusive Central Time calendar dates across both daylight-saving transitions', () => {
    const spring = reportingRange('2026-03-08', '2026-03-08', '2026-09-09');
    expect(spring.fromInstant.toISOString()).toBe('2026-03-08T06:00:00.000Z');
    expect(spring.toInstant.toISOString()).toBe('2026-03-09T05:00:00.000Z');
    const autumn = reportingRange('2026-11-01', '2026-11-01', '2026-09-09');
    expect(autumn.toInstant.getTime() - autumn.fromInstant.getTime()).toBe(25 * 3_600_000);
  });

  it('rejects impossible/reversed dates and allows history longer than 28 days', () => {
    expect(reportingRange('2026-02-30', '2026-09-09', '2026-09-09').error).toBeTruthy();
    expect(reportingRange('2026-09-09', '2026-09-01', '2026-09-09').error).toBeTruthy();
    const range = reportingRange('2020-01-01', '2026-09-09', '2026-09-09');
    expect(range.error).toBeNull();
    expect(range.from).toBe('2020-01-01');
  });
});

describe('scoped activity and performance', () => {
  let basics: Basics;
  let admin: SessionUser;
  let leader: SessionUser;
  let junior: SessionUser;
  let foreignTaskId: string;
  const range = reportingRange('2026-09-08', '2026-09-08', '2026-09-09');

  beforeAll(async () => {
    await resetDb();
    basics = await seedBasics();
    admin = asUser(basics.users.ria, []);
    leader = { ...asUser(basics.users.alisa, [basics.pods.Alisa.id]), role: 'SALES_LEADER' };
    junior = asUser(basics.users.karson, [basics.pods.Alisa.id]);
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { ownerMemberId: basics.users.karson.twentyMemberId, podOwner: 'ALISA' } });
    await prisma.personCache.update({ where: { id: 'person-02' }, data: { ownerMemberId: basics.users.karson.twentyMemberId, podOwner: 'ALISA' } });
    await prisma.personCache.update({ where: { id: 'person-03' }, data: { ownerMemberId: basics.users.daniel.twentyMemberId, podOwner: 'LEIGH' } });
    const enrollment = async (personId: string, podId: string, createdAt: string) => prisma.enrollment.create({ data: {
      personId, podId, foUserId: basics.users.karson.id, sequenceId: basics.sequence.id,
      startDate: createdAt.slice(0, 10), currentStep: 0, createdAt: at(createdAt),
    } });
    const old = await enrollment('person-01', basics.pods.Alisa.id, '2026-06-01T05:00:00Z');
    const current = await enrollment('person-02', basics.pods.Alisa.id, '2026-09-08T05:00:00Z');
    const foreign = await enrollment('person-03', basics.pods.Leigh.id, '2026-09-08T05:00:00Z');
    await prisma.enrollment.update({ where: { id: old.id }, data: { status: 'REPLIED', repliedAt: at('2026-09-08T06:00:00Z') } });
    await prisma.enrollment.update({ where: { id: current.id }, data: { status: 'MEETING', meetingAt: at('2026-09-09T05:00:00Z') } });
    const task = async (enrollmentId: string, actionIndex: number, when: string) => prisma.task.create({ data: {
      enrollmentId, foUserId: basics.users.karson.id, stepIndex: 0, stepId: 'email-step', stepDay: 1,
      actionIndex, actionId: `email-${actionIndex}`, action: 'EMAIL', label: `Email ${actionIndex}`, dueDate: when.slice(0, 10), dueAt: at(when), plannedDate: when.slice(0, 10),
      state: 'DONE', completedAt: at(when), completionSource: 'MANUAL',
    } });
    await task(old.id, 0, '2026-06-01T12:00:00Z');
    await task(old.id, 1, '2026-09-08T05:00:00Z');
    await task(current.id, 0, '2026-09-09T04:59:59Z');
    await task(current.id, 1, '2026-09-09T05:00:00Z');
    const foreignTask = await task(foreign.id, 0, '2026-09-08T12:00:00Z');
    foreignTaskId = foreignTask.id;
    await prisma.auditLog.create({ data: { entityType: 'task', entityId: foreignTask.id, actorType: 'USER', actorId: basics.users.karson.id, actorLabel: basics.users.karson.name, action: 'completed', createdAt: at('2026-09-08T12:00:00Z') } });
    await prisma.touch.createMany({ data: [
      { personId: 'person-01', channel: 'EMAIL', direction: 'INBOUND', summary: 'Reply at start', occurredAt: at('2026-09-08T05:00:00Z'), externalId: 'reporting:start' },
      { personId: 'person-01', channel: 'CALL', direction: 'OUTBOUND', summary: 'Call inside', occurredAt: at('2026-09-09T04:59:59Z'), externalId: 'reporting:inside', actorUserId: basics.users.karson.id },
      { personId: 'person-01', channel: 'LINKEDIN', direction: 'OUTBOUND', summary: 'LinkedIn inside', occurredAt: at('2026-09-08T14:00:00Z'), externalId: 'reporting:linkedin', actorUserId: basics.users.karson.id },
      { personId: 'person-01', channel: 'EMAIL', direction: 'INBOUND', summary: 'Reply at end', occurredAt: at('2026-09-09T05:00:00Z'), externalId: 'reporting:end' },
      ...Array.from({ length: 7 }, (_, index) => ({ personId: 'person-02', channel: 'EMAIL' as const, direction: 'OUTBOUND' as const, summary: `Timestamp peer ${index}`, occurredAt: at('2026-08-01T12:00:00Z'), externalId: `reporting:peer:${index}` })),
      { personId: 'person-02', channel: 'EMAIL', direction: 'OUTBOUND', summary: 'Historical needle', occurredAt: at('2026-01-01T12:00:00Z'), externalId: 'reporting:historical' },
    ] });
  });

  it('filters channel and exact calendar boundaries on the server', async () => {
    const page = await listActivity({ viewer: leader, from: range.fromInstant, to: range.toInstant, channel: 'EMAIL' });
    expect(page.items.map((item) => item.title)).toEqual(['Reply at start']);
    const linkedin = await listActivity({ viewer: leader, from: range.fromInstant, to: range.toInstant, channel: 'LINKEDIN' });
    expect(linkedin.items.map((item) => item.title)).toEqual(['LinkedIn inside']);
  });

  it('scopes task audit records by their pod even when an FO works across pods', async () => {
    const page = await listActivity({ viewer: leader, from: range.fromInstant, to: range.toInstant, kinds: ['task'] });
    expect(page.items.some((item) => item.id === `a:${foreignTaskId}`)).toBe(false);
    expect(page.items).toHaveLength(0);
    expect((await listActivity({ viewer: admin, from: range.fromInstant, to: range.toInstant, kinds: ['task'] })).items).toHaveLength(1);
  });

  it('pages every record at the same instant without duplicates or dropped rows', async () => {
    const ids: string[] = [];
    let before: string | null = null;
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await listActivity({ viewer: admin, from: at('2026-08-01T00:00:00Z'), to: at('2026-08-02T00:00:00Z'), limit: 2, before });
      expect(page.items.length).toBeLessThanOrEqual(2);
      ids.push(...page.items.map((item) => item.id));
      before = page.nextCursor;
      if (!before) break;
    }
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
  });

  it('finds historical search matches beyond a full page of unrelated events', async () => {
    await prisma.touch.createMany({ data: Array.from({ length: 205 }, (_, index) => ({ personId: 'person-02', channel: 'CALL' as const, direction: 'OUTBOUND' as const, summary: `Recent unrelated ${index}`, occurredAt: at('2026-07-01T12:00:00Z'), externalId: `reporting:noise:${index}` })) });
    const page = await listActivity({ viewer: admin, q: 'Historical needle', limit: 2 });
    expect(page.items.map((item) => item.title)).toEqual(['Historical needle']);
    expect(page.hasMore).toBe(false);
  });

  it('counts events in a chosen period even for older enrollments, with no next-day leakage', async () => {
    const report = await buildReports(leader, '2026-09-09', { range });
    expect(report.totals.enrollments).toBe(1);
    expect(report.totals.tasksDone).toBe(2);
    expect(report.totals.replied).toBe(1);
    expect(report.totals.meeting).toBe(0);
    expect(report.activity[0].period).toMatchObject({ emails: 2, total: 2, replies: 1, meetings: 0 });
    expect(report.byPod).toHaveLength(1);
    expect(report.byPod[0].meetingRate).toBe(0);
  });

  it('combines pod and FO filters inside viewer scope and allows long history', async () => {
    const wide = reportingRange('2026-01-01', '2026-09-08', '2026-09-09');
    const report = await buildReports(admin, '2026-09-09', { range: wide, podId: basics.pods.Alisa.id, foUserId: basics.users.karson.id });
    expect(report.totals.tasksDone).toBe(3);
    expect(report.totals.enrollments).toBe(2);
    const forbidden = await buildReports(leader, '2026-09-09', { range, podId: basics.pods.Leigh.id });
    expect(forbidden.totals.tasksDone).toBe(0);
    const own = await buildReports(junior, '2026-09-09', { range });
    expect(own.activity.every((item) => item.id === basics.users.karson.id)).toBe(true);
  });
});
