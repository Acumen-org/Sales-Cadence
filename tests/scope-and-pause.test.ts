import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/current-user';
import { accountDetail } from '@/lib/accounts-query';
import { meetingReadWhere, canReadMeeting } from '@/lib/meetings-query';
import { listTaskGroups } from '@/lib/tasks-query';
import { buildHome } from '@/lib/home-query';
import { completeTask, enrollPeople, pauseEnrollment, resumeEnrollment, skipTask, snoozeTask } from '@/lib/engine';
import { resetDb, seedBasics, type Basics } from './helpers/db';

/**
 * Reading somebody else's pod, and working a campaign that has been stopped.
 *
 * Both were reachable: the account record page and the meetings list were fetched by id with no
 * scope at all, and pausing a campaign only stopped future step generation - every open touch
 * stayed in every FO's Today, so pressing Done still wrote a note into the CRM for a campaign
 * the leader had stopped.
 */

const at = (date: string) => new Date(`${date}T10:00:00Z`);
const session = (u: { id: string; role: string; email: string; name: string; twentyMemberId: string | null }, podIds: string[]): SessionUser =>
  ({ ...u, podIds, timezone: 'America/Chicago' }) as unknown as SessionUser;

describe('reading scope and a paused campaign', () => {
  let b: Basics;
  let alisa: SessionUser;
  let karson: SessionUser;
  let andrew: SessionUser;
  let ria: SessionUser;

  beforeAll(async () => {
    await resetDb();
    b = await seedBasics();
    alisa = session(b.users.alisa, [b.pods.Alisa.id]);
    karson = session(b.users.karson, [b.pods.Alisa.id]);
    andrew = session(b.users.andrew, [b.pods.Andrew.id]);
    ria = session(b.users.ria, []);
    await enrollPeople(
      { personIds: ['person-01', 'person-02'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-07', assignment: { mode: 'FIXED', foUserId: b.users.karson.id }, actor: SYSTEM_ACTOR },
      { now: at('2026-09-07') },
    );
  });

  it('an account record opens for anyone on the team, whichever pod works it', async () => {
    // The account is built here rather than borrowed from the fixtures, where most companies have
    // contacts in more than one pod - which is realistic, and would make this assert nothing.
    const companyId = 'acct-alisa-only';
    await prisma.companyCache.create({ data: { id: companyId, name: 'Alisa Only Ltd' } });
    await prisma.personCache.create({
      data: { id: 'person-alisa-only', firstName: 'Only', lastName: 'Contact', companyId, companyName: 'Alisa Only Ltd', podOwner: 'ALISA', ownerMemberId: 'wm-alisa' },
    });

    // Alisa's pod works this company, so she reads it; so does an admin.
    expect(await accountDetail(companyId, alisa)).not.toBeNull();
    expect(await accountDetail(companyId, ria)).not.toBeNull();
    // Andrew leads a different pod and works nobody here; he still reads it.
    expect(await accountDetail(companyId, andrew)).not.toBeNull();
    expect(await accountDetail('no-such-company', andrew)).toBeNull();
  });

  it('a meeting is readable by the whole team, whichever pod it belongs to', async () => {
    const meeting = await prisma.meeting.create({
      data: {
        title: 'Intro call',
        sourceUrl: 'https://example.com/recording.mp4',
        provider: 'FILE',
        occurredAt: at('2026-09-08'),
        companyId: 'acct-alisa-only',
        createdById: b.users.karson.id,
        attendees: { create: [{ personId: 'person-alisa-only', name: 'Only Contact', external: true }] },
      },
    });

    // Andrew leads a different pod and works nobody here; the meetings library is still his to read.
    for (const reader of [ria, karson, alisa, andrew]) expect(await canReadMeeting(reader, meeting.id)).toBe(true);
    // And the list where clause agrees with the single-record check.
    expect(await prisma.meeting.count({ where: { AND: [{ id: meeting.id }, await meetingReadWhere(andrew)] } })).toBe(1);
    // A meeting that does not exist is not readable, so a stale link still answers not-found.
    expect(await canReadMeeting(andrew, 'no-such-meeting')).toBe(false);
  });

  it('pausing holds every open touch: it leaves the lists and refuses to be worked', async () => {
    const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-01' } });
    const before = await listTaskGroups(karson, { tab: 'today', channel: null, podId: null, foUserId: null }, at('2026-09-07'));
    expect(before.rows.some((r) => r.enrollmentId === enrollment.id)).toBe(true);
    const homeBefore = await buildHome(karson, at('2026-09-07'));

    await pauseEnrollment(enrollment.id, { reason: 'campaign paused', actor: SYSTEM_ACTOR, now: at('2026-09-07') });

    const during = await listTaskGroups(karson, { tab: 'today', channel: null, podId: null, foUserId: null }, at('2026-09-07'));
    const homeDuring = await buildHome(karson, at('2026-09-07'));
    expect(during.rows.some((r) => r.enrollmentId === enrollment.id)).toBe(false);
    // The other enrollment is untouched, so this is a hold and not an empty list.
    expect(during.rows.length).toBe(before.rows.length - 1);

    const [task] = await prisma.task.findMany({ where: { enrollmentId: enrollment.id, state: 'PENDING' }, orderBy: { actionIndex: 'asc' } });
    expect((await completeTask({ taskId: task.id, source: 'MANUAL' }, { actor: SYSTEM_ACTOR, now: at('2026-09-07') })).ok).toBe(false);
    expect((await skipTask({ taskId: task.id, reason: 'Not now' }, { actor: SYSTEM_ACTOR })).ok).toBe(false);
    expect((await snoozeTask({ taskId: task.id, toDate: '2026-09-11' }, { actor: SYSTEM_ACTOR, now: at('2026-09-07') })).ok).toBe(false);
    // Held, not cancelled: the touch is still there and still pending.
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).state).toBe('PENDING');

    // Every figure has to agree with the list, or a badge sends the FO to an empty screen. Home,
    // the Tasks tabs and the sidebar badge all count touchpoints (a step of one enrollment), so
    // Home lost exactly the touchpoints that were held.
    const heldTouchpoints = new Set((await prisma.task.findMany({ where: { enrollmentId: enrollment.id, state: 'PENDING' }, select: { stepId: true } })).map((t) => t.stepId)).size;
    expect(heldTouchpoints).toBeGreaterThan(0);
    expect(homeBefore.my.todayTotal + homeBefore.my.overdueTotal - (homeDuring.my.todayTotal + homeDuring.my.overdueTotal)).toBe(heldTouchpoints);
    expect(during.held).toBe(heldTouchpoints);

    // Resuming one person inside a campaign that is itself paused must refuse and say why, not
    // report success and leave their work held.
    await prisma.campaign.create({ data: { id: 'camp-paused', name: 'Paused campaign', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-07', status: 'PAUSED' } });
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { campaignId: 'camp-paused' } });
    const refused = await resumeEnrollment(enrollment.id, { actor: SYSTEM_ACTOR, now: at('2026-09-07') });
    expect(refused.resumed).toBe(false);
    expect(refused.refused).toMatch(/campaign/i);
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status).toBe('PAUSED');
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { campaignId: null } });

    expect((await resumeEnrollment(enrollment.id, { actor: SYSTEM_ACTOR, now: at('2026-09-07') })).resumed).toBe(true);
    const after = await listTaskGroups(karson, { tab: 'today', channel: null, podId: null, foUserId: null }, at('2026-09-07'));
    expect(after.rows.some((r) => r.enrollmentId === enrollment.id)).toBe(true);
    expect((await completeTask({ taskId: task.id, source: 'MANUAL' }, { actor: SYSTEM_ACTOR, now: at('2026-09-07') })).ok).toBe(true);
  });
});
