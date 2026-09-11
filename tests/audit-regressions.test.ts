import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { dateTimeInputValue, localDateTimeToInstant } from '@/lib/dates';
import { buildHome } from '@/lib/home-query';
import { enrollPeople, previewEnrollment } from '@/lib/engine/enrollment';
import { completeTask, skipTask, snoozeTask } from '@/lib/engine/tasks';
import { completeCall, skipWithReason } from '@/lib/engine/outcomes';
import { createMeetingAction, updateMeetingAction } from '@/lib/actions/meetings';
import { globalSearchAction } from '@/lib/actions/search';
import { createUserAction, updateUserAction } from '@/lib/actions/users';
import { safeReturnPath } from '@/lib/auth/redirect';
import { nonReplierCandidates } from '@/lib/campaigns-query';
import { WORKSPACE_TIMEZONE } from '@/lib/workspace';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.requireUser, requireAdmin: auth.requireUser, toActor: (u: SessionUser) => u }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const NOW = new Date('2026-09-08T10:00:00Z');
const context = { actor: SYSTEM_ACTOR, now: NOW, skipSync: true };
let b: Basics;
const session = (u: Basics['users']['alisa'], podIds: string[] = []): SessionUser => ({ ...u, podIds, pods: podIds.map((id) => ({ id, name: id })) });

beforeEach(async () => {
  await resetDb(); b = await seedBasics();
  auth.requireUser.mockResolvedValue(session(b.users.ria));
});

async function finalTask(type: 'CALL' | 'EMAIL' = 'CALL', personId = 'person-01') {
  const sequence = await prisma.sequence.create({ data: { name: `Final ${personId}`, steps: [{ id: 'final', day: 1, actions: [{ id: 'final-action', type, label: `Final ${type}` }] }] } });
  await enrollPeople({ personIds: [personId], sequenceId: sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-08', assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR }, context);
  return prisma.task.findFirstOrThrow({ where: { enrollment: { personId }, state: 'PENDING' } });
}

describe('terminal outcomes and concurrent task actions', () => {
  it('credits an answered call on the final step as a reply', async () => {
    const task = await finalTask();
    const result = await completeCall({ taskId: task.id, disposition: 'connected' }, context);
    expect(result.ok).toBe(true);
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: task.enrollmentId } })).status).toBe('REPLIED');
  });
  it('keeps a final bounced step as exited, rather than completed without reply', async () => {
    const task = await finalTask('EMAIL');
    const result = await skipWithReason({ taskId: task.id, reasonKey: 'bounced' }, context);
    expect(result.ok && result.exited).toBe('bounced');
    expect(await prisma.enrollment.findUnique({ where: { id: task.enrollmentId } })).toMatchObject({ status: 'EXITED', exitReason: 'bounced' });
  });
  it('applies a completion exactly once when requests arrive together', async () => {
    const task = await finalTask('EMAIL');
    const results = await Promise.all([completeTask({ taskId: task.id, source: 'MANUAL' }, context), completeTask({ taskId: task.id, source: 'MANUAL' }, context)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { entityId: task.id, action: 'completed' } })).toBe(1);
  });
  it('does not overwrite a competing completion with a skip', async () => {
    const task = await finalTask('EMAIL');
    const results = await Promise.all([completeTask({ taskId: task.id, source: 'MANUAL' }, context), skipTask({ taskId: task.id, reason: 'Other' }, context)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { entityId: task.id, action: { in: ['completed', 'skipped'] } } })).toBe(1);
  });
  it('keeps the ordering instant aligned with a snoozed date', async () => {
    const task = await finalTask('EMAIL');
    const result = await snoozeTask({ taskId: task.id, toDate: '2026-09-10' }, context);
    expect(result.ok && dateTimeInputValue(result.task.dueAt, 'Europe/London')).toBe('2026-09-10T09:00');
  });
});

describe('scope boundaries', () => {
  it('refuses fixed assignment to an inactive FO or someone outside the campaign pod', async () => {
    const request = { personIds: ['person-01'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-08', actor: SYSTEM_ACTOR };
    await expect(previewEnrollment({ ...request, assignment: { mode: 'FIXED', foUserId: b.users.leigh.id } })).rejects.toThrow('active member');
    await prisma.user.update({ where: { id: b.users.alisa.id }, data: { active: false } });
    await expect(previewEnrollment({ ...request, assignment: { mode: 'FIXED', foUserId: b.users.alisa.id } })).rejects.toThrow('active member');
  });
  it('refuses a person whose Twenty pod is another pod, by name', async () => {
    // person-01 is in Alisa's pod in Twenty; Leigh's campaign cannot take them by pasting the id.
    const preview = await previewEnrollment({ personIds: ['person-01'], sequenceId: b.sequence.id, podId: b.pods.Leigh.id, startDate: '2026-09-08', assignment: { mode: 'ROUND_ROBIN' }, actor: SYSTEM_ACTOR });
    expect(preview.candidates).toHaveLength(0);
    expect(preview.conflicts).toMatchObject([{ personId: 'person-01', reason: 'pod_mismatch' }]);
  });
  it('excludes opted-out people from repeat campaign candidates', async () => {
    const task = await finalTask('EMAIL');
    await completeTask({ taskId: task.id, source: 'MANUAL' }, context);
    const campaign = await prisma.campaign.create({ data: { name: 'Follow-up', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-08' } });
    await prisma.enrollment.update({ where: { id: task.enrollmentId }, data: { campaignId: campaign.id } });
    expect(await nonReplierCandidates(campaign.id, 0, NOW)).toHaveLength(1);
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { optedOut: true } });
    expect(await nonReplierCandidates(campaign.id, 0, NOW)).toHaveLength(0);
  });
  it('search only returns campaigns the user can open', async () => {
    for (const key of ['Alisa', 'Leigh']) await prisma.campaign.create({ data: { name: `Private ${key}`, sequenceId: b.sequence.id, podId: b.pods[key].id, startDate: '2026-09-08' } });
    auth.requireUser.mockResolvedValue(session(b.users.alisa, [b.pods.Alisa.id]));
    expect((await globalSearchAction('Private')).filter((h) => h.kind === 'campaign').map((h) => h.title)).toEqual(['Private Alisa']);
    auth.requireUser.mockResolvedValue(session(b.users.ria));
    expect((await globalSearchAction('Private')).filter((h) => h.kind === 'campaign')).toHaveLength(2);
  });
  it('does not include another pod’s work in a shared FO’s team totals', async () => {
    await prisma.userPod.create({ data: { userId: b.users.karson.id, podId: b.pods.Leigh.id } });
    await enrollPeople({ personIds: ['person-16'], sequenceId: b.sequence.id, podId: b.pods.Leigh.id, startDate: '2026-09-08', assignment: { mode: 'FIXED', foUserId: b.users.karson.id }, actor: SYSTEM_ACTOR }, context);
    const home = await buildHome(session(b.users.alisa, [b.pods.Alisa.id]), NOW);
    expect(home.team.find((u) => u.id === b.users.karson.id)).toMatchObject({ today: 0, overdue: 0 });
    // An admin sees Karson's Leigh-pod work: day 1 is email + LinkedIn, one touchpoint on the board.
    const admin = await buildHome(session(b.users.ria), NOW);
    expect(admin.team.find((u) => u.id === b.users.karson.id)?.today).toBe(1);
  });
});

describe('account security and validation', () => {
  const userForm = () => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ userId: b.users.alisa.id, name: b.users.alisa.name, email: 'new@cadence.local', role: 'SENIOR_FO', active: 'true', password: 'new-password-123' })) form.set(key, value);
    return form;
  };
  it('revokes existing sessions on password reset', async () => {
    await prisma.session.create({ data: { userId: b.users.alisa.id, token: 'old-session', expiresAt: new Date('2030-01-01') } });
    expect((await updateUserAction(userForm())).ok).toBe(true);
    expect(await prisma.session.count({ where: { userId: b.users.alisa.id } })).toBe(0);
  });
  it('puts every account on the one workspace timezone, whatever the form says', async () => {
    // The team is all US Central, so timezone is not a per-user question any more: a submitted
    // value is ignored rather than validated, and nothing a form sends can shift someone's day.
    const form = userForm(); form.set('timezone', 'Mars/Olympus');
    expect((await updateUserAction(form)).ok).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.users.alisa.id } })).timezone).toBe(WORKSPACE_TIMEZONE);

    const created = new FormData();
    for (const [k, v] of Object.entries({ name: 'Tz Probe', email: 'tz.probe@cadence.local', role: 'JUNIOR_FO', password: 'tz-probe-password-1', timezone: 'Mars/Olympus' })) created.set(k, v);
    expect((await createUserAction(created)).ok).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'tz.probe@cadence.local' } })).timezone).toBe(WORKSPACE_TIMEZONE);
  });
  it('never lets a form write sender aliases: matching owns them, not the administrator', async () => {
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: b.users.alisa.id } })).aliases;
    const form = userForm(); form.set('aliases', 'typed@example.com, SOMETHING_ELSE');
    expect((await updateUserAction(form)).ok).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.users.alisa.id } })).aliases).toEqual(before);
  });
  it('keeps login return URLs on the application origin', () => {
    for (const path of [undefined, '//evil.example', '/\\evil.example', '/\n/evil.example', 'https://evil.example']) expect(safeReturnPath(path)).toBe('/home');
    expect(safeReturnPath('/tasks?tab=upcoming&type=CALL')).toBe('/tasks?tab=upcoming&type=CALL');
  });
});

describe('meeting forms', () => {
  const form = (url = 'https://files.example.com/call.mp4') => {
    const fd = new FormData(); fd.set('title', 'Timezone review'); fd.set('sourceUrl', url); fd.set('occurredAt', '2026-09-08T14:30'); return fd;
  };
  it('creates and edits meetings using the viewer timezone', async () => {
    auth.requireUser.mockResolvedValue({ ...session(b.users.ria), timezone: 'America/New_York' });
    const result = await createMeetingAction(form()); expect(result.ok).toBe(true);
    const meeting = await prisma.meeting.findFirstOrThrow();
    expect(meeting.occurredAt.toISOString()).toBe('2026-09-08T18:30:00.000Z');
    const fd = form(); fd.set('meetingId', meeting.id); fd.set('occurredAt', '2026-09-08T16:00');
    expect((await updateMeetingAction(fd)).ok).toBe(true);
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).occurredAt.toISOString()).toBe('2026-09-08T20:00:00.000Z');
  });
  it('validates recording URLs on both creation and editing', async () => {
    expect((await createMeetingAction(form('javascript:alert(1)'))).ok).toBe(false);
    await createMeetingAction(form()); const meeting = await prisma.meeting.findFirstOrThrow();
    const fd = form('not a url'); fd.set('meetingId', meeting.id);
    expect((await updateMeetingAction(fd)).ok).toBe(false);
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).sourceUrl).toBe('https://files.example.com/call.mp4');
  });
  it('rejects impossible calendar dates and daylight-saving gaps', () => {
    expect(localDateTimeToInstant('2026-02-30T10:00', 'UTC')).toBeNull();
    expect(localDateTimeToInstant('2026-03-08T02:30', 'America/New_York')).toBeNull();
    expect(localDateTimeToInstant('2026-09-08T24:10', 'UTC')).toBeNull();
    expect(dateTimeInputValue(new Date('2026-09-08T00:00:00Z'), 'UTC')).toBe('2026-09-08T00:00');
  });
});
