import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { buildReports, reportingRange, type Activity, type ReportingRange } from '@/lib/reports-query';
import { loadReportBundle } from '@/lib/reports-bundle';
import { callReport } from '@/lib/calls/analytics';
import { buildHome } from '@/lib/home-query';
import { replyCount, repliesByRep, type Period } from '@/lib/outreach/metrics';
import { reportsHref } from '@/lib/report-keys';
import { campaignDetail, listCampaigns } from '@/lib/campaigns-query';
import { campaignPeoplePage } from '@/lib/campaign-people-page';
import { labelBeyond, upNextWords } from '@/lib/task-cues';
import { accountDetail } from '@/lib/accounts-query';
import { EMAIL_TO_DO_NOT_CONTACT, MARKED_REPLY_PREFIX, recordColdReply, type SeenMail } from '@/lib/mail/cold-email';
import { ingestEvent } from '@/lib/engine/ingest';
import { rawFromMessage } from '@/lib/engine/reconcile';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

const auth = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock('@/lib/auth/current-user', () => ({
  requireUser: async () => auth.user,
  getCurrentUser: async () => auth.user,
  requireAdmin: async () => auth.user,
  toActor: (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), redirect: () => { throw new Error('redirect'); } }));

const { CallsDocument } = await import('@/components/reports/calls-report');
const { ReportDocument } = await import('@/components/reports/report-document');
const { GET: exportReport } = await import('@/app/reports/export/route');
const { newColdContactFromCallAction } = await import('@/lib/actions/call-forms');
const { finishFromTaskAction } = await import('@/lib/actions/tasks');

/**
 * S8 (cold outreach PLAN 6, W9): Reports in three views, All outreach · CRM · Cold outreach, every
 * figure from the shared metrics module, so All outreach = CRM + Cold for work done and Home agrees.
 * Each test is named after its bug.
 */

// Friday 6 Nov 2026, midday in Chicago. The week is Mon 2 to Sun 8 Nov.
const NOW = new Date('2026-11-06T18:00:00Z');
const TODAY = '2026-11-06';
const WEEK = reportingRange('2026-11-02', '2026-11-08', TODAY);
const at = (iso: string) => new Date(iso);
const session = (u: { id: string; email: string; name: string; role: Role; timezone: string; twentyMemberId: string | null; dailyCap: number | null }, podIds: string[]): SessionUser => ({ id: u.id, email: u.email, name: u.name, role: u.role, timezone: u.timezone, twentyMemberId: u.twentyMemberId, dailyCap: u.dailyCap, podIds, pods: podIds.map((id) => ({ id, name: id })) });
const ACTIVITY: (keyof Activity)[] = ['sent', 'emails', 'calls', 'linkedin', 'dials', 'connects', 'replies', 'meetings', 'booked'];

describe('Reports: All outreach, CRM and Cold outreach', () => {
  let b: Basics;
  let admin: SessionUser;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    admin = session(b.users.ria, []);
    auth.user = admin;
  });

  async function crmStep(personId: string, foUserId: string, completedAt: string, action: 'EMAIL' | 'CALL' | 'LINKEDIN_MESSAGE' = 'EMAIL', extra: { disposition?: string; podId?: string } = {}) {
    const enrollment = await prisma.enrollment.create({ data: { personId, foUserId, podId: extra.podId ?? b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-10-26', audience: 'CRM', currentStep: 0 } });
    return prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId, stepIndex: 0, stepId: 'step-d1', stepDay: 1, actionIndex: 0, actionId: `act-${action}`, action, label: action, dueDate: completedAt.slice(0, 10), dueAt: at(completedAt), plannedDate: completedAt.slice(0, 10), state: 'DONE', completedAt: at(completedAt), completionSource: 'MANUAL', disposition: extra.disposition ?? null } });
  }
  async function coldStep(contactId: string, foUserId: string, completedAt: string, action: 'EMAIL' | 'LINKEDIN_MESSAGE' = 'LINKEDIN_MESSAGE') {
    const enrollment = await prisma.enrollment.create({ data: { sandboxContactId: contactId, foUserId, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-10-26', audience: 'SANDBOX', currentStep: 0 } });
    return prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId, stepIndex: 0, stepId: 'step-d1', stepDay: 1, actionIndex: 0, actionId: `act-${action}`, action, label: action, dueDate: completedAt.slice(0, 10), dueAt: at(completedAt), plannedDate: completedAt.slice(0, 10), state: 'DONE', completedAt: at(completedAt), completionSource: 'MANUAL' } });
  }
  async function call(d: { userId: string | null; personId?: string; sandboxContactId?: string; startedAt: string; talkSec?: number; status?: 'COMPLETED' | 'NO_ANSWER'; direction?: 'OUTBOUND' | 'INBOUND'; outcome?: string; flags?: string[]; podId?: string | null; taskId?: string; nextActionId?: string }) {
    const audience = d.personId ? 'CRM' : d.sandboxContactId ? 'SANDBOX' : null;
    const c = await prisma.callLog.create({ data: { source: 'TWILIO_IMPORT', direction: d.direction ?? 'OUTBOUND', status: d.status ?? 'COMPLETED', statusRank: 5, userId: d.userId, personId: d.personId ?? null, sandboxContactId: d.sandboxContactId ?? null, matchedBy: audience ? 'number' : 'none', startedAt: at(d.startedAt), talkSec: d.talkSec ?? 0, audience, podId: d.podId === undefined ? b.pods.Alisa.id : d.podId, taskId: d.taskId ?? null, nextActionId: d.nextActionId ?? null, toNumber: '+13125550100', fromNumber: '+13125550199' } });
    if (d.outcome) await prisma.callForm.create({ data: { callId: c.id, userId: d.userId!, outcome: d.outcome, nextStep: 'none', flags: d.flags ?? [], audience, submittedAt: at(d.startedAt) } });
    return c;
  }
  const reply = (who: { personId?: string; sandboxContactId?: string }, occurredAt: string, key: string, extra: { copyOfTouchId?: string } = {}) =>
    prisma.touch.create({ data: { ...who, channel: 'EMAIL', direction: 'INBOUND', occurredAt: at(occurredAt), summary: `Reply: ${key}`, externalId: `rep:${key}`, audience: who.personId ? 'CRM' : 'SANDBOX', ...extra } });
  /** A week of work: CRM, cold, and a call not matched to anyone yet. */
  async function weekOfWork() {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await crmStep('person-01', b.users.alisa.id, '2026-11-03T15:00:00Z');
    await reply({ personId: 'person-01' }, '2026-11-04T15:00:00Z', 'crm');
    await call({ userId: b.users.alisa.id, personId: 'person-02', startedAt: '2026-11-04T16:00:00Z', talkSec: 120 });
    await prisma.meeting.create({ data: { title: 'Intro', sourceUrl: 'https://example.com/m1', occurredAt: at('2026-11-05T17:00:00Z'), bookedById: b.users.alisa.id } });
    await coldStep(c.id, b.users.alisa.id, '2026-11-03T16:00:00Z');
    await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Email', action: 'EMAIL', dueDate: '2026-11-04', state: 'DONE', lastDoneAt: at('2026-11-04T14:00:00Z'), audience: 'SANDBOX' } });
    await reply({ sandboxContactId: c.id }, '2026-11-05T15:00:00Z', 'cold');
    await call({ userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: '2026-11-05T16:00:00Z', talkSec: 200, outcome: 'meeting_booked' });
    await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Meeting', action: 'CALL', kind: 'MEETING', dueDate: TODAY, state: 'DONE', lastDoneAt: at('2026-11-06T15:00:00Z'), audience: 'SANDBOX' } });
    await call({ userId: b.users.alisa.id, startedAt: '2026-11-05T18:00:00Z', talkSec: 5, podId: b.pods.Alisa.id });
    return c;
  }
  const views = async (user: SessionUser, range: ReportingRange = WEEK, more: { podId?: string; foUserId?: string } = {}) => ({
    all: await buildReports(user, TODAY, { range, audience: 'all', ...more }, NOW),
    crm: await buildReports(user, TODAY, { range, audience: 'crm', ...more }, NOW),
    cold: await buildReports(user, TODAY, { range, audience: 'cold', ...more }, NOW),
  });

  it('B041, B122: All outreach is CRM + Cold for every count of work done, and calls not matched yet are their own part', async () => {
    await weekOfWork();
    const v = await views(admin);
    const value = (r: typeof v.all, k: keyof Activity) => (k === 'booked' ? r.totals.booked : k === 'meetings' ? r.totals.meetings : k === 'dials' ? r.totals.dials : k === 'connects' ? r.totals.connects : r.totals[k]);
    for (const k of ACTIVITY) {
      expect(value(v.all, k), k).toBe(value(v.crm, k) + value(v.cold, k) + v.all.parts.unmatched[k]);
      expect(v.all.parts.crm[k], k).toBe(value(v.crm, k));
      expect(v.all.parts.cold[k], k).toBe(value(v.cold, k));
    }
    // The CRM step, the call with no step, the cold step, the cold next step, the cold call, and the unmatched call.
    expect(v.all.totals).toEqual(expect.objectContaining({ sent: 6, dials: 3, replies: 2, meetings: 2, booked: 1 }));
    expect(v.all.parts.unmatched).toEqual(expect.objectContaining({ sent: 1, dials: 1 }));
    expect(v.cold.totals).toEqual(expect.objectContaining({ sent: 3, replies: 1, meetings: 1, booked: 1 }));
    // The sub-line reads as PLAN 6 shows it.
    const html = renderToStaticMarkup(createElement(ReportDocument, { reports: v.all, previous: null, range: WEEK, scope: 'All outreach', campaigns: [] }));
    expect(html).toContain('2 CRM · 3 Cold · 1 not matched yet');
    expect(html).toContain('title="Work done: All outreach is CRM plus Cold outreach"');
    // The cold view has its funnel; the CRM view does not.
    expect(renderToStaticMarkup(createElement(ReportDocument, { reports: v.cold, previous: null, range: WEEK, scope: 'Cold outreach', campaigns: [] }))).toContain('Cold outreach funnel');
    expect(renderToStaticMarkup(createElement(ReportDocument, { reports: v.crm, previous: null, range: WEEK, scope: 'CRM', campaigns: [] }))).not.toContain('Cold outreach funnel');
  });

  it('B037: a move to the CRM never moves a past figure out of Cold outreach', async () => {
    const c = await weekOfWork();
    const before = await views(admin);
    await prisma.sandboxContact.update({ where: { id: c.id }, data: { status: 'MOVED', twentyPersonId: 'person-05', movedAt: NOW } });
    for (const table of ['callLog', 'touch', 'enrollment', 'nextAction'] as const) await (prisma[table] as unknown as { updateMany: (a: object) => Promise<unknown> }).updateMany({ where: { sandboxContactId: c.id }, data: { personId: 'person-05' } });
    const after = await views(admin);
    expect(after.cold.totals).toEqual(before.cold.totals);
    expect(after.crm.totals).toEqual(before.crm.totals);
  });

  it('people tiles count each person once: a cold contact and its CRM twin are "1 in both"', async () => {
    const twin = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { crmMatchPersonId: 'person-03' });
    await coldStep(twin.id, b.users.alisa.id, '2026-11-03T15:00:00Z');
    await crmStep('person-03', b.users.alisa.id, '2026-11-04T15:00:00Z');
    await crmStep('person-04', b.users.alisa.id, '2026-11-04T16:00:00Z');
    const { all } = await views(admin);
    expect(all.people.reached).toEqual({ all: 2, crm: 2, cold: 1, both: 1 });
    expect(all.totals.reached).toBe(2);
    expect(renderToStaticMarkup(createElement(ReportDocument, { reports: all, previous: null, range: WEEK, scope: 'All outreach', campaigns: [] }))).toContain('2 CRM · 1 Cold · 1 in both');
  });

  it('B039, B123: Sent counts steps, next steps and calls that closed no step, each once, so replies never run past it', async () => {
    const step = await crmStep('person-01', b.users.alisa.id, '2026-11-03T15:00:00Z', 'CALL', { disposition: 'connected' });
    // The call that did the step is the step: counted once.
    await call({ userId: b.users.alisa.id, personId: 'person-01', startedAt: '2026-11-03T14:59:00Z', talkSec: 90, taskId: step.id });
    const next = await prisma.nextAction.create({ data: { personId: 'person-02', foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: '2026-11-04', state: 'DONE', lastDoneAt: at('2026-11-04T15:00:00Z'), audience: 'CRM' } });
    await call({ userId: b.users.alisa.id, personId: 'person-02', startedAt: '2026-11-04T14:58:00Z', talkSec: 40, nextActionId: next.id });
    // A call made from a mobile, closing nothing, that they answered: one sent, one reply.
    const loose = await call({ userId: b.users.alisa.id, personId: 'person-06', startedAt: '2026-11-05T15:00:00Z', talkSec: 75, outcome: 'connected' });
    const touch = await prisma.touch.create({ data: { personId: 'person-06', channel: 'CALL', direction: 'OUTBOUND', occurredAt: loose.startedAt!, summary: 'Answered call: Connected', externalId: `call:${loose.id}`, actorUserId: b.users.alisa.id, audience: 'CRM' } });
    await prisma.callLog.update({ where: { id: loose.id }, data: { touchId: touch.id } });
    const { crm } = await views(admin);
    expect(crm.totals).toEqual(expect.objectContaining({ sent: 3, calls: 3, replies: 1, answered: 2 }));
    expect(crm.totals.replyRate).toBeLessThanOrEqual(1);
    expect(crm.channels.find((c) => c.action === 'CALL')?.done).toBe(3);
  });

  it('B121: a call they answered is the caller\'s reply, not the campaign FO\'s, on Reports and Home alike', async () => {
    await crmStep('person-01', b.users.alisa.id, '2026-11-02T15:00:00Z');
    const c = await call({ userId: b.users.karson.id, personId: 'person-01', startedAt: '2026-11-04T15:00:00Z', talkSec: 80, outcome: 'connected' });
    const t = await prisma.touch.create({ data: { personId: 'person-01', channel: 'CALL', direction: 'OUTBOUND', occurredAt: c.startedAt!, summary: 'Answered call: Connected', externalId: `call:${c.id}`, actorUserId: b.users.karson.id, audience: 'CRM' } });
    await prisma.callLog.update({ where: { id: c.id }, data: { touchId: t.id } });
    const { all } = await views(admin);
    expect(all.byFo.find((r) => r.key === b.users.karson.id)?.replies).toBe(1);
    expect(all.byFo.find((r) => r.key === b.users.alisa.id)?.replies ?? 0).toBe(0);
    const byRep = await repliesByRep([b.users.alisa.id, b.users.karson.id], 'all', { from: WEEK.fromInstant, to: WEEK.toInstant });
    expect(byRep.get(b.users.karson.id)).toBe(1);
    expect(byRep.get(b.users.alisa.id) ?? 0).toBe(0);
  });

  it('B096: for a rep and a week, Reports reads what Home\'s board reads', async () => {
    await weekOfWork();
    const home = await buildHome(session(b.users.alisa, [b.pods.Alisa.id]), NOW);
    const row = home.team.find((r) => r.id === b.users.alisa.id)!;
    const range: ReportingRange = { from: home.week.from, to: home.week.to, fromInstant: home.week.fromInstant, toInstant: home.week.toInstant, error: null };
    const report = await buildReports(admin, TODAY, { range, foUserId: b.users.alisa.id }, NOW);
    expect({ replies: report.totals.replies, meetings: report.totals.meetings, booked: report.totals.booked, calls: report.totals.dials }).toEqual({ replies: row.replies, meetings: row.meetings, booked: row.booked, calls: row.calls });
    expect(row.replies).toBe(2);
  });

  it('meetings held count all of today, in Reports as on Home', async () => {
    // Today's meeting at 5pm, read at noon: held today, all day.
    await prisma.meeting.create({ data: { title: 'Later today', sourceUrl: 'https://example.com/m2', occurredAt: at('2026-11-06T23:00:00Z'), bookedById: b.users.alisa.id } });
    await prisma.meeting.create({ data: { title: 'Tomorrow', sourceUrl: 'https://example.com/m3', occurredAt: at('2026-11-07T17:00:00Z'), bookedById: b.users.alisa.id } });
    const { all } = await views(admin);
    expect(all.totals.meetings).toBe(1);
  });

  it('every new touch figure leaves copies out: the CRM\'s copy of a cold reply is no CRM reply', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { crmMatchPersonId: 'person-03' });
    const cold = await reply({ sandboxContactId: c.id }, '2026-11-04T15:00:00Z', 'once');
    await reply({ personId: 'person-03' }, '2026-11-04T15:02:00Z', 'copy', { copyOfTouchId: cold.id });
    const v = await views(admin);
    expect([v.all.totals.replies, v.crm.totals.replies, v.cold.totals.replies]).toEqual([1, 0, 1]);
    expect(v.all.people.replied).toEqual({ all: 1, crm: 0, cold: 1, both: 0 });
  });

  it('B038: a leader\'s "All pods" sticks, in Reports and in the export, and the pod select shows what was applied', async () => {
    const leader = session(b.users.alisa, [b.pods.Alisa.id]);
    expect((await loadReportBundle(leader, {})).podId).toBe(b.pods.Alisa.id);
    const all = await loadReportBundle(leader, { pod: '' });
    expect(all.podId).toBeNull();
    expect(all.scope).toBe('All outreach · All pods');
    expect((await loadReportBundle(leader, { pod: 'not-a-pod' })).podId).toBeNull();
  });

  it('B040: every figure takes the pod at the time of the work, not the rep\'s pod today', async () => {
    await call({ userId: b.users.alisa.id, personId: 'person-01', startedAt: '2026-11-03T15:00:00Z', talkSec: 60, podId: b.pods.Alisa.id });
    await prisma.userPod.deleteMany({ where: { userId: b.users.alisa.id } });
    await prisma.userPod.create({ data: { userId: b.users.alisa.id, podId: b.pods.Leigh.id } });
    expect((await buildReports(admin, TODAY, { range: WEEK, podId: b.pods.Alisa.id }, NOW)).totals.dials).toBe(1);
    expect((await buildReports(admin, TODAY, { range: WEEK, podId: b.pods.Leigh.id }, NOW)).totals.dials).toBe(0);
    const calls = await callReport({ from: WEEK.fromInstant, to: WEEK.toInstant, podId: b.pods.Alisa.id });
    expect(calls.totals.dials).toBe(1);
  });

  it('B042: changing the pod, the FO or the dates keeps the view and the audience', () => {
    const base = { tab: 'pods', from: '2026-11-02', to: '2026-11-08', pod: 'p1', fo: 'u1', view: 'calls' as const, audience: 'cold' as const };
    const url = new URL(reportsHref(base, { pod: '', fo: '' }), 'http://x');
    expect(Object.fromEntries(url.searchParams)).toEqual({ tab: 'pods', from: '2026-11-02', to: '2026-11-08', pod: '', fo: '', view: 'calls', audience: 'cold' });
    expect(new URL(reportsHref(base, { from: '2026-10-01' }, '/reports/export'), 'http://x').searchParams.get('audience')).toBe('cold');
    // The defaults stay out of the address.
    expect(reportsHref({ ...base, view: 'outreach', audience: 'all' })).not.toMatch(/view=|audience=/);
  });

  it('B124, B126, B122: the Calls view names who each call was with, says its status and direction, pages, and connects count calls out only', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jane', lastName: 'Cold', companyName: 'Cold Firm' });
    await call({ userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: '2026-11-03T15:00:00Z', talkSec: 120 });
    await call({ userId: b.users.alisa.id, personId: 'person-01', startedAt: '2026-11-03T16:00:00Z', status: 'NO_ANSWER' });
    await call({ userId: b.users.alisa.id, personId: 'person-02', startedAt: '2026-11-03T17:00:00Z', talkSec: 200, direction: 'INBOUND' });
    await call({ userId: b.users.alisa.id, startedAt: '2026-11-03T18:00:00Z', talkSec: 0, status: 'NO_ANSWER' });
    for (let i = 0; i < 52; i++) await call({ userId: b.users.karson.id, personId: 'person-04', startedAt: `2026-11-04T1${i % 10}:${String(i).padStart(2, '0')}:00Z`, status: 'NO_ANSWER' });
    const r = await callReport({ from: WEEK.fromInstant, to: WEEK.toInstant, audience: 'all' });
    expect(r.split.all.dials).toBe(r.split.crm.dials + r.split.cold.dials + r.split.unmatched.dials);
    expect(r.split.unmatched.dials).toBe(1);
    // B126: the incoming answered call is no connect; the rate is out of the same calls.
    expect(r.totals.connects).toBe(1);
    expect(r.totals.inboundAnswered).toBe(1);
    expect(r.totals.connectRate).toBeCloseTo(1 / r.totals.dials);
    // B124: 56 calls, 50 a page, the second page has the rest.
    expect([r.callsTotal, r.calls.length, r.pages]).toEqual([56, 50, 2]);
    const second = await callReport({ from: WEEK.fromInstant, to: WEEK.toInstant, audience: 'cold' });
    expect(second.calls.map((x) => x.subject?.lastName)).toEqual(['Cold']);
    const html = renderToStaticMarkup(createElement(CallsDocument, { data: second, timezone: 'America/Chicago', compared: null, links: { call: (id) => `/calls/${id}`, page: () => '/reports' } }));
    expect(html).toContain('Jane Cold');
    expect(html).toContain('Cold Firm');
    expect(html).toContain('>Out<');
    const all = renderToStaticMarkup(createElement(CallsDocument, { data: r, timezone: 'America/Chicago', compared: null }));
    expect(all).toContain('Not answered');
    expect(all).toContain('Showing 1 to 50 of 56');
    expect(all).not.toMatch(/no-answer|NO_ANSWER/);
  });

  it('B195: the Calls view compares with the period Outreach names, and says so when there were no calls then', async () => {
    await call({ userId: b.users.alisa.id, personId: 'person-01', startedAt: '2026-11-03T15:00:00Z', talkSec: 120 });
    const before = reportingRange('2026-10-26', '2026-11-01', TODAY);
    const r = await callReport({ from: WEEK.fromInstant, to: WEEK.toInstant, previous: { from: before.fromInstant, to: before.toInstant } });
    expect(r.previous?.dials).toBe(0);
    const html = renderToStaticMarkup(createElement(CallsDocument, { data: r, timezone: 'America/Chicago', compared: { from: before.from, to: before.to } }));
    expect(html).toContain('Compared with');
    expect(html).toContain('no calls then');
    expect(html).not.toContain('0% before');
  });

  it('B196: calls nobody is matched to follow the pod and FO filters when they have a rep, and show in every filter when they have none', async () => {
    await call({ userId: null, startedAt: '2026-11-03T15:00:00Z', podId: null });
    await call({ userId: b.users.leigh.id, startedAt: '2026-11-03T16:00:00Z', podId: b.pods.Leigh.id });
    await call({ userId: b.users.alisa.id, startedAt: '2026-11-03T17:00:00Z' });
    const alisaPod = await callReport({ from: WEEK.fromInstant, to: WEEK.toInstant, podId: b.pods.Alisa.id });
    expect(alisaPod.unmatchedTotal).toBe(2);
    expect(alisaPod.unmatched.map((c) => c.userId).sort()).toEqual([b.users.alisa.id, null].sort());
    expect((await callReport({ from: WEEK.fromInstant, to: WEEK.toInstant })).unmatchedTotal).toBe(3);
    expect(renderToStaticMarkup(createElement(CallsDocument, { data: alisaPod, timezone: 'UTC', compared: null }))).toContain('No rep yet: shown in every filter');
  });

  it('B125: the export follows the audience and the view', async () => {
    await weekOfWork();
    const cold = await exportReport(new Request('http://x/reports/export?from=2026-11-02&to=2026-11-08&pod=&fo=&audience=cold'));
    const coldHtml = await cold.text();
    expect(coldHtml).toContain('Cadence report, Cold outreach');
    expect(coldHtml).toContain('Cold outreach funnel');
    const calls = await (await exportReport(new Request('http://x/reports/export?from=2026-11-02&to=2026-11-08&pod=&fo=&view=calls'))).text();
    expect(calls).toContain('Cadence calls report, All outreach');
    expect(calls).toContain('CRM, Cold outreach and not matched yet');
    expect(calls).not.toContain('<script');
  });

  it('R02: the exported Calls report holds every call of the period, not the first page of 50', async () => {
    for (let i = 0; i < 55; i++) await call({ userId: b.users.alisa.id, startedAt: `2026-11-03T${String(10 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}:00Z` });
    const paged = await callReport({ from: WEEK.fromInstant, to: WEEK.toInstant });
    expect(paged.calls).toHaveLength(50);
    expect(renderToStaticMarkup(createElement(CallsDocument, { data: paged, timezone: 'UTC', compared: null }))).toContain('class="rp-pager"');
    expect((await callReport({ from: WEEK.fromInstant, to: WEEK.toInstant, allRows: true })).calls).toHaveLength(55);
    const html = await (await exportReport(new Request('http://x/reports/export?from=2026-11-02&to=2026-11-08&pod=&fo=&view=calls'))).text();
    expect(html).not.toContain('class="rp-pager"');
  });

  it('R22: an export asked for after the session ended goes to sign-in and back to the same Reports view', async () => {
    auth.user = null;
    const res = await exportReport(new Request('http://x/reports/export?from=2026-11-02&to=2026-11-08&view=calls'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`http://x/login?next=${encodeURIComponent('/reports?from=2026-11-02&to=2026-11-08&view=calls')}`);
  });

  it('B127: a leader adds who an unknown number was as a cold contact, the call is attached and stamped, and calls go only to sales reps', async () => {
    const leader = session(b.users.alisa, [b.pods.Alisa.id]);
    auth.user = leader;
    const c = await call({ userId: b.users.karson.id, startedAt: '2026-11-03T15:00:00Z' });
    const fd = new FormData();
    for (const [k, v] of Object.entries({ callId: c.id, firstName: 'Nora', lastName: 'Unknown', companyName: 'Walk-in Wealth' })) fd.set(k, v);
    expect(await newColdContactFromCallAction(fd)).toEqual(expect.objectContaining({ ok: true }));
    const after = await prisma.callLog.findUniqueOrThrow({ where: { id: c.id } });
    const contact = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: after.sandboxContactId! } });
    expect(contact).toEqual(expect.objectContaining({ source: 'CALL', ownerId: b.users.karson.id, podId: b.pods.Alisa.id, phone: '+13125550100' }));
    expect(after).toEqual(expect.objectContaining({ matchedBy: 'chosen', audience: 'SANDBOX' }));
    // It has a contact and a rep now, so it leaves the list.
    expect((await callReport({ from: WEEK.fromInstant, to: WEEK.toInstant })).unmatchedTotal).toBe(0);
    // A Biz Ops user is not a rep a call can be given to.
    const { assignCallRepAction } = await import('@/lib/actions/call-forms');
    const bizOps = await prisma.user.create({ data: { email: 'ops@cadence.local', name: 'Ops Person', role: 'BIZ_OPS', timezone: 'Europe/London', passwordHash: 'x' } });
    const give = new FormData(); give.set('callId', c.id); give.set('userId', bizOps.id);
    expect(await assignCallRepAction(give)).toEqual(expect.objectContaining({ ok: false }));
  });

  it('B194: the funnel counts real claims, not pushes, and meetings booked as contacts', async () => {
    const pushed = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { createdAt: at('2026-11-03T15:00:00Z') });
    const claimed = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { createdAt: at('2026-11-03T15:00:00Z'), firstClaimedAt: at('2026-11-04T15:00:00Z') });
    await call({ userId: b.users.alisa.id, sandboxContactId: claimed.id, startedAt: '2026-11-04T16:00:00Z', talkSec: 300, outcome: 'meeting_booked' });
    await call({ userId: b.users.alisa.id, sandboxContactId: claimed.id, startedAt: '2026-11-05T16:00:00Z', talkSec: 300, outcome: 'meeting_booked' });
    await prisma.auditLog.create({ data: { entityType: 'sandbox_contact', entityId: pushed.id, action: 'sandbox_moved', actorType: 'USER', actorId: b.users.alisa.id, actorLabel: 'Alisa', createdAt: at('2026-11-05T12:00:00Z') } });
    const { cold } = await views(admin);
    expect(cold.cold?.funnel).toEqual(expect.objectContaining({ added: 2, fromBellwether: 2, claimed: 1, worked: 1, connected: 1, booked: 1, moved: 1 }));
    expect(cold.cold?.byRep.find((r) => r.key === b.users.alisa.id)).toEqual(expect.objectContaining({ claimed: 1, worked: 1, connected: 1, booked: 1, moved: 1 }));
  });

  it('N065: a rep who has left keeps their cold calls in Reports, and stays in the FO list as "(removed)"', async () => {
    const c = await readyContact(b.users.karson.id, b.pods.Alisa.id);
    await call({ userId: b.users.karson.id, sandboxContactId: c.id, startedAt: '2026-11-03T15:00:00Z', talkSec: 60 });
    await prisma.user.update({ where: { id: b.users.karson.id }, data: { active: false } });
    const bundle = await loadReportBundle(admin, { from: '2026-11-02', to: '2026-11-08' });
    expect(bundle.users).toContainEqual({ id: b.users.karson.id, name: 'Karson Reed (removed)' });
    expect(bundle.reports.byFo.find((r) => r.key === b.users.karson.id)?.label).toBe('Karson Reed (removed)');
    const calls = await callReport({ from: WEEK.fromInstant, to: WEEK.toInstant });
    expect(calls.byRep.find((r) => r.userId === b.users.karson.id)?.name).toBe('Karson Reed (removed)');
  });

  it('N055: CRM Reports count the form\'s outcomes as answered calls', async () => {
    await crmStep('person-01', b.users.alisa.id, '2026-11-03T15:00:00Z', 'CALL', { disposition: 'not_interested' });
    await call({ userId: b.users.alisa.id, personId: 'person-02', startedAt: '2026-11-03T16:00:00Z', talkSec: 10, outcome: 'meeting_booked' });
    const { crm } = await views(admin);
    expect(crm.byFo.find((r) => r.key === b.users.alisa.id)?.answered).toBe(2);
    expect(crm.totals.connects).toBe(1);
  });

  it('the post-call form\'s flags show in Reports > Calls (B029), and emails to people who must not be contacted are counted (N016)', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { status: 'OPTED_OUT' });
    await call({ userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: '2026-11-03T15:00:00Z', talkSec: 30, outcome: 'do_not_contact', flags: ['called_opted_out'] });
    await call({ userId: b.users.alisa.id, personId: 'person-01', startedAt: '2026-11-03T16:00:00Z', talkSec: 150, outcome: 'voicemail', flags: ['long_voicemail'] });
    const r = await callReport({ from: WEEK.fromInstant, to: WEEK.toInstant });
    expect([r.totals.calledOptedOut, r.totals.longVoicemails]).toEqual([1, 1]);
    const html = renderToStaticMarkup(createElement(CallsDocument, { data: r, timezone: 'UTC', compared: null }));
    expect(html).toContain('Called someone who opted out');
    expect(html).toContain('Voicemail over 2 minutes');
    await prisma.auditLog.create({ data: { entityType: 'sandbox_contact', entityId: c.id, action: EMAIL_TO_DO_NOT_CONTACT, actorType: 'SYSTEM', actorLabel: 'Cadence', details: { mailboxUserId: b.users.alisa.id }, createdAt: at('2026-11-04T15:00:00Z') } });
    await prisma.auditLog.create({ data: { entityType: 'person', entityId: 'person-07', action: EMAIL_TO_DO_NOT_CONTACT, actorType: 'SYSTEM', actorLabel: 'Cadence', details: { mailboxUserId: b.users.leigh.id }, createdAt: at('2026-11-04T16:00:00Z') } });
    const v = await views(admin);
    expect([v.all.totals.doNotContactEmails, v.crm.totals.doNotContactEmails, v.cold.totals.doNotContactEmails]).toEqual([2, 1, 1]);
    expect((await buildReports(admin, TODAY, { range: WEEK, foUserId: b.users.alisa.id }, NOW)).totals.doNotContactEmails).toBe(1);
  });

  it('By campaign marks cold campaigns, and running campaigns of both kinds show in All outreach', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const campaign = await prisma.campaign.create({ data: { name: 'Cold Q4', audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-11-02', status: 'ACTIVE', personIds: [c.id] } });
    const e = await prisma.enrollment.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, campaignId: campaign.id, startDate: '2026-11-02', audience: 'SANDBOX', currentStep: 0 } });
    await prisma.task.create({ data: { enrollmentId: e.id, foUserId: b.users.alisa.id, stepIndex: 0, stepId: 's', stepDay: 1, actionIndex: 0, actionId: 'a', action: 'EMAIL', label: 'Email 1', dueDate: '2026-11-03', dueAt: at('2026-11-03T15:00:00Z'), plannedDate: '2026-11-03', state: 'DONE', completedAt: at('2026-11-03T15:00:00Z') } });
    const { all } = await views(admin);
    expect(all.byCampaign.find((r) => r.key === campaign.id)).toEqual(expect.objectContaining({ label: 'Cold Q4', cold: true, sent: 1 }));
    const bundle = await loadReportBundle(admin, { from: '2026-11-02', to: '2026-11-08' });
    expect(bundle.campaigns.find((x) => x.id === campaign.id)?.cold).toBe(true);
    expect((await loadReportBundle(admin, { from: '2026-11-02', to: '2026-11-08', audience: 'crm' })).campaigns.find((x) => x.id === campaign.id)).toBeUndefined();
  });
});

describe('one reply counts once: "They replied" and the reply Outlook tracks (S8)', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    auth.user = session(b.users.alisa, [b.pods.Alisa.id]);
  });
  const outlook = (key: string, atTime: Date): SeenMail => ({ key, conversationId: `conv-${key}`, subject: 'Re: A quick idea', at: atTime, mailboxUserId: b.users.alisa.id, via: 'outlook' });
  const around = (t: Date): Period => ({ from: new Date(t.getTime() - 3 * 86_400_000), to: new Date(t.getTime() + 86_400_000) });
  async function openStep(contactId: string) {
    const e = await prisma.enrollment.create({ data: { sandboxContactId: contactId, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-10-26', audience: 'SANDBOX', currentStep: 0 } });
    return prisma.task.create({ data: { enrollmentId: e.id, foUserId: b.users.alisa.id, stepIndex: 0, stepId: 's', stepDay: 1, actionIndex: 0, actionId: 'a', action: 'EMAIL', label: 'Email 1', dueDate: '2026-10-26', dueAt: new Date('2026-10-26T15:00:00Z'), plannedDate: '2026-10-26' } });
  }
  const theyReplied = async (taskId: string) => { const fd = new FormData(); fd.set('kind', 'replied'); fd.set('taskId', taskId); return finishFromTaskAction(fd); };
  const replies = async (p: Period) => ({ all: await replyCount({ kind: 'all' }, 'all', p), cold: await replyCount({ kind: 'all' }, 'cold', p) });

  it('the rep marks "They replied", then Outlook tracks the same reply: one reply, the mark counts', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    expect(await theyReplied((await openStep(c.id)).id)).toEqual(expect.objectContaining({ ok: true }));
    const mark = await prisma.touch.findFirstOrThrow({ where: { sandboxContactId: c.id, externalId: { startsWith: MARKED_REPLY_PREFIX } } });
    // The email came an hour before the rep marked it; tracking reads it later.
    await recordColdReply(c.email!, outlook('<r1@x>', new Date(mark.occurredAt.getTime() - 3_600_000)), false);
    const tracked = await prisma.touch.findFirstOrThrow({ where: { sandboxContactId: c.id, externalId: { startsWith: 'graph:' } } });
    expect(tracked.copyOfTouchId).toBe(mark.id);
    expect(await replies(around(mark.occurredAt))).toEqual({ all: 1, cold: 1 });
  });

  it('the other way round: Outlook tracks the reply, then the rep marks "They replied": one reply, the email counts', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const atTime = new Date(Date.now() - 2 * 3_600_000);
    await recordColdReply(c.email!, outlook('<r2@x>', atTime), false);
    await theyReplied((await openStep(c.id)).id);
    const tracked = await prisma.touch.findFirstOrThrow({ where: { sandboxContactId: c.id, externalId: { startsWith: 'graph:' } } });
    const mark = await prisma.touch.findFirstOrThrow({ where: { sandboxContactId: c.id, externalId: { startsWith: MARKED_REPLY_PREFIX } } });
    expect([tracked.copyOfTouchId, mark.copyOfTouchId]).toEqual([null, tracked.id]);
    expect(await replies(around(atTime))).toEqual({ all: 1, cold: 1 });
    // A second, later email is a second reply; an out-of-office answers nothing and joins nothing.
    await recordColdReply(c.email!, { ...outlook('<r3@x>', new Date(atTime.getTime() + 3_600_000)), subject: 'Re: One more thing' }, false);
    await recordColdReply(c.email!, { ...outlook('<r4@x>', new Date(atTime.getTime() + 7_200_000)), subject: 'Automatic reply: away' }, true);
    expect(await replies(around(atTime))).toEqual({ all: 2, cold: 2 });
  });

  it('an "Also in CRM" contact: the mark, the tracked email and the CRM copy of it are one reply', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.personCache.create({ data: { id: 'person-twin', firstName: c.firstName, lastName: c.lastName, email: c.email, emailNorm: c.email, createdBySource: 'MANUAL' } });
    await prisma.sandboxContact.update({ where: { id: c.id }, data: { crmMatchPersonId: 'person-twin' } });
    await theyReplied((await openStep(c.id)).id);
    const mark = await prisma.touch.findFirstOrThrow({ where: { sandboxContactId: c.id, externalId: { startsWith: MARKED_REPLY_PREFIX } } });
    const atTime = new Date(mark.occurredAt.getTime() - 3_600_000);
    await recordColdReply(c.email!, outlook('<r5@x>', atTime), false);
    const msg = getMockTwentyClient().addMessage({ subject: 'Re: A quick idea', receivedAt: new Date(atTime.getTime() + 60_000).toISOString(), from: { handle: c.email!, personId: 'person-twin' }, to: [{ handle: 'alisa@cadence.local', workspaceMemberId: 'wm-alisa' }] });
    await ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(msg), now: new Date(atTime.getTime() + 120_000) });
    const tracked = await prisma.touch.findFirstOrThrow({ where: { sandboxContactId: c.id, externalId: { startsWith: 'graph:' } } });
    expect(await prisma.touch.findFirstOrThrow({ where: { personId: 'person-twin', direction: 'INBOUND' } })).toEqual(expect.objectContaining({ copyOfTouchId: tracked.id }));
    expect(await replyCount({ kind: 'all' }, 'all', around(mark.occurredAt))).toBe(1);
  });

  it('the release migration joins the pairs written since 5 Nov, once, and audits each', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const far = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const T0 = new Date('2026-11-05T15:00:00Z');
    const touch = (contactId: string, externalId: string, occurredAt: Date, summary = 'Reply: Re: Deck', createdAt = occurredAt) => prisma.touch.create({ data: { sandboxContactId: contactId, channel: 'EMAIL', direction: 'INBOUND', occurredAt, summary, externalId, audience: 'SANDBOX', createdAt } });
    const tracked = await touch(c.id, 'graph:<m1@x>:sbx:1', T0, 'Reply: Re: Deck', new Date(T0.getTime() + 600_000));
    const mark = await touch(c.id, `${MARKED_REPLY_PREFIX}e1`, new Date(T0.getTime() + 300_000), 'Replied (recorded in Tasks)');
    await touch(c.id, 'graph:<auto@x>:sbx:1', new Date(T0.getTime() + 60_000), 'Auto-reply: away');
    // Eight days apart: two replies.
    await touch(far.id, 'graph:<m2@x>:sbx:2', T0);
    await touch(far.id, `${MARKED_REPLY_PREFIX}e2`, new Date(T0.getTime() + 8 * 86_400_000), 'Replied (recorded in Tasks)');
    const sql = fs.readFileSync(path.join(process.cwd(), 'prisma/migrations/20261106000000_reply_counted_once/migration.sql'), 'utf8');
    const backfill = sql.slice(sql.indexOf('DO $$'));
    await prisma.$executeRawUnsafe(backfill);
    await prisma.$executeRawUnsafe(backfill);
    // The tracked email was recorded after the mark: it is the copy.
    expect((await prisma.touch.findUniqueOrThrow({ where: { id: tracked.id } })).copyOfTouchId).toBe(mark.id);
    expect((await prisma.touch.findUniqueOrThrow({ where: { id: mark.id } })).copyOfTouchId).toBeNull();
    expect(await prisma.touch.count({ where: { sandboxContactId: far.id, copyOfTouchId: { not: null } } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'reply_counted_once' } })).toBe(1);
  });
});

describe('campaign meetings, copy slips, and the account replies tile', () => {
  let b: Basics;
  let admin: SessionUser;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    admin = session(b.users.ria, []);
    auth.user = admin;
  });

  it('B128: a campaign\'s meetings mean one thing on its list row, its tiles and its step and team tables', async () => {
    const campaign = await prisma.campaign.create({ data: { name: 'SaaStr', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-11-02', status: 'ACTIVE', personIds: ['person-01', 'person-02'] } });
    await prisma.enrollment.create({ data: { personId: 'person-01', foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, campaignId: campaign.id, startDate: '2026-11-02', currentStep: 0, status: 'MEETING', meetingAt: at('2026-11-04T15:00:00Z'), audience: 'CRM' } });
    await prisma.enrollment.create({ data: { personId: 'person-02', foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, campaignId: campaign.id, startDate: '2026-11-02', currentStep: 0, audience: 'CRM' } });
    // A meeting with someone in the campaign that came from elsewhere is not the campaign's.
    await prisma.meeting.create({ data: { title: 'Other', sourceUrl: 'https://example.com/o', occurredAt: at('2026-11-05T15:00:00Z'), bookedById: b.users.leigh.id, attendees: { create: [{ personId: 'person-02', email: 'p2@example.com', external: true }] } } });
    const [row] = await listCampaigns(admin);
    const detail = (await campaignDetail(campaign.id, TODAY))!;
    const people = await campaignPeoplePage({ ...campaign, plannerDraft: null, publishedPlan: null }, undefined, undefined);
    expect([row.counts.meeting, detail.summary.counts.meeting, detail.byStep.reduce((n, s) => n + s.meeting, 0), detail.byFo.reduce((n, f) => n + f.meeting, 0), people.stats.meetings]).toEqual([1, 1, 1, 1, 1]);
    // The campaign page's tile reads the same figure; "Meetings in window" is gone.
    const page = fs.readFileSync(path.join(process.cwd(), 'src/app/(app)/campaigns/[id]/page.tsx'), 'utf8');
    expect(page).toContain('<Stat label="Meetings" value={summary.counts.meeting}');
    expect(page).not.toContain('Meetings in window');
  });

  it('B197: "1 call", and a task whose label only repeats its action reads "Email · Acme", not "Email · Email"', async () => {
    expect(upNextWords({ kind: 'task', campaign: 'Email', company: 'Acme', fo: null }, 'Email', false)).toBe('Acme');
    expect(upNextWords({ kind: 'task', campaign: 'Follow-up after the call', company: 'Acme', fo: null }, 'Email', false)).toBe('Follow-up after the call · Acme');
    expect(upNextWords({ kind: 'step', campaign: null, company: null, fo: null }, 'Email', false)).toBe('No campaign');
    expect(labelBeyond('call again', 'Call again')).toBeNull();
    // A post-call form's next step is saved as the bare channel; Home's row no longer repeats it.
    await prisma.nextAction.create({ data: { personId: 'person-01', foUserId: b.users.alisa.id, label: 'Email', action: 'EMAIL', dueDate: TODAY, audience: 'CRM' } });
    const home = await buildHome(session(b.users.alisa, [b.pods.Alisa.id]), NOW);
    const next = home.my.nextTasks[0];
    expect(upNextWords(next, 'Email', false)).not.toMatch(/^Email/);
    const one = await callReport({ from: WEEK.fromInstant, to: WEEK.toInstant });
    expect(renderToStaticMarkup(createElement(CallsDocument, { data: { ...one, callsTotal: 1 }, timezone: 'UTC', compared: null }))).toContain('1 call<');
  });

  it('N004: an Account page counts its own people\'s replies only; an account with none shows 0', async () => {
    await prisma.touch.create({ data: { personId: 'person-01', channel: 'EMAIL', direction: 'INBOUND', occurredAt: at('2026-11-04T15:00:00Z'), summary: 'Reply: yes', externalId: 'n004:1', audience: 'CRM' } });
    const p1 = await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-01' } });
    const other = await prisma.personCache.findFirstOrThrow({ where: { companyId: { not: p1.companyId } } });
    expect((await accountDetail(p1.companyId!, admin))?.stats.replied).toBe(1);
    expect((await accountDetail(other.companyId!, admin))?.stats.replied).toBe(0);
  });
});
