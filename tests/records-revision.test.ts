import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { createMeetingAction, updateMeetingAction, updateMeetingAttendeesAction, canManageMeetingAction, searchProspectsAction, searchTeamAction } from '@/lib/actions/meetings';
import { createUserAction, updateUserAction, setUserAccessAction, createPodAction, deletePodAction, restorePodAction } from '@/lib/actions/users';
import { ensurePod } from '@/lib/person-cache';
import { WORKSPACE_TIMEZONE } from '@/lib/workspace';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { enrollPeople } from '@/lib/engine/enrollment';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.user, requireAdmin: auth.user, toActor: (user: SessionUser) => user }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
let b: Basics;
const form = (values: Record<string, string>) => { const fd = new FormData(); for (const [key, value] of Object.entries(values)) fd.set(key, value); return fd; };
const session = (user: Basics['users']['alisa'], podIds: string[] = []): SessionUser => ({ ...user, timezone: WORKSPACE_TIMEZONE, podIds, pods: podIds.map((id) => ({ id, name: id })) });
const meetingForm = (team: string[] = [b.users.ria.id], prospects: string[] = ['person-01']) => { const fd = form({ title: 'Pilot meeting', sourceUrl: 'https://video.example.com/recording.mp4', occurredAt: '2026-09-09T10:30', bookedById: b.users.alisa.id, teamJson: JSON.stringify(team), prospectsJson: JSON.stringify(prospects) }); fd.append('products', 'PHH'); return fd; };

beforeEach(async () => { await resetDb(); b = await seedBasics(); auth.user.mockResolvedValue(session(b.users.ria)); });

describe('meeting attendees', () => {
  it('keeps Biz Ops read-only even for meetings they created before a role change', async () => {
    await createMeetingAction(meetingForm());
    const meeting = await prisma.meeting.findFirstOrThrow();
    auth.user.mockResolvedValue({ ...session(b.users.ria), role: 'BIZ_OPS' });
    expect((await createMeetingAction(meetingForm())).ok).toBe(false);
    expect(await canManageMeetingAction(meeting.id)).toBe(false);
    const edit = meetingForm(); edit.set('meetingId', meeting.id);
    expect((await updateMeetingAction(edit)).ok).toBe(false);
    expect((await updateMeetingAttendeesAction(form({ meetingId: meeting.id, teamJson: JSON.stringify([b.users.ria.id]), prospectsJson: '["person-02"]' }))).ok).toBe(false);
    expect(await prisma.meeting.count()).toBe(1);
  });
  it('resolves prospects and team members by their records, and marks each prospect', async () => {
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { email: null } });
    expect((await createMeetingAction(meetingForm([b.users.ria.id], ['person-01']))).ok).toBe(true);
    const attendees = await prisma.meetingAttendee.findMany();
    expect(attendees.find((a) => a.personId === 'person-01')).toMatchObject({ external: true, prospect: true, meetingNumber: 1 });
    expect(attendees.find((a) => a.userId === b.users.ria.id)).toMatchObject({ name: b.users.ria.name, external: false, host: true, prospect: false });
  });
  it('needs someone from the team, a prospect and a product, each said plainly', async () => {
    const without = async (fd: FormData) => createMeetingAction(fd);
    expect(await without(meetingForm([], ['person-01']))).toEqual({ ok: false, error: 'Choose who from the team was on the call.' });
    expect(await without(meetingForm([b.users.ria.id], []))).toEqual({ ok: false, error: 'Choose the prospects the meeting was with.' });
    const noProduct = meetingForm(); noProduct.delete('products');
    expect(await without(noProduct)).toEqual({ ok: false, error: 'Choose the products the meeting was about.' });
    expect((await without(meetingForm([b.users.ria.id], ['missing']))).ok).toBe(false);
    expect(await prisma.meeting.count()).toBe(0);
  });
  it('takes the account from the prospects, with no account to pick', async () => {
    await prisma.companyCache.create({ data: { id: 'acme-co', name: 'Acme Co' } });
    await prisma.personCache.updateMany({ where: { id: { in: ['person-01', 'person-02'] } }, data: { companyId: 'acme-co', companyName: 'Acme Co' } });
    const fd = meetingForm([b.users.ria.id], ['person-01', 'person-02']); fd.set('companyId', 'something-else');
    expect((await createMeetingAction(fd)).ok).toBe(true);
    expect(await prisma.meeting.findFirstOrThrow()).toMatchObject({ companyId: 'acme-co', companyName: 'Acme Co' });
  });
  it('replaces who was there, keeps a guest typed in before, and clears the analysis', async () => {
    await createMeetingAction(meetingForm([b.users.ria.id], ['person-01']));
    const meeting = await prisma.meeting.findFirstOrThrow();
    await prisma.meetingAttendee.create({ data: { meetingId: meeting.id, name: 'Old Guest', email: 'guest@outside.example', external: true } });
    await prisma.meeting.update({ where: { id: meeting.id }, data: { analysisStatus: 'READY', analysisModel: 'previous' } });
    const saved = await updateMeetingAttendeesAction(form({ meetingId: meeting.id, teamJson: JSON.stringify([b.users.alisa.id]), prospectsJson: '["person-02"]' }));
    expect(saved.ok).toBe(true);
    const rows = await prisma.meetingAttendee.findMany({ where: { meetingId: meeting.id } });
    expect(rows.map((a) => a.userId ?? a.personId ?? a.email).sort()).toEqual([b.users.alisa.id, 'guest@outside.example', 'person-02'].sort());
    expect(rows.find((a) => a.personId === 'person-02')).toMatchObject({ prospect: true, meetingNumber: 1 });
    expect(await prisma.meeting.findUnique({ where: { id: meeting.id } })).toMatchObject({ analysisStatus: 'NONE', analysisModel: null });
  });
  it('allows a leader to edit meetings for their pod, while rejecting other pods', async () => {
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { podOwner: 'ALISA' } });
    await createMeetingAction(meetingForm([b.users.ria.id], ['person-01']));
    const meeting = await prisma.meeting.findFirstOrThrow();
    auth.user.mockResolvedValue({ ...session(b.users.alisa, [b.pods.Alisa.id]), role: 'SALES_LEADER' });
    expect(await canManageMeetingAction(meeting.id)).toBe(true);
    auth.user.mockResolvedValue(session(b.users.leigh, [b.pods.Leigh.id]));
    expect(await canManageMeetingAction(meeting.id)).toBe(false);
    expect((await updateMeetingAttendeesAction(form({ meetingId: meeting.id, teamJson: JSON.stringify([b.users.leigh.id]), prospectsJson: '["person-02"]' }))).ok).toBe(false);
    expect(await prisma.meetingAttendee.count()).toBe(2);
  });
  it('keeps legacy notes stored when editing a meeting without a Notes field', async () => {
    await createMeetingAction(meetingForm());
    const meeting = await prisma.meeting.findFirstOrThrow();
    await prisma.meeting.update({ where: { id: meeting.id }, data: { notes: 'Historical note' } });
    const update = meetingForm(); update.set('meetingId', meeting.id);
    expect((await updateMeetingAction(update)).ok).toBe(true);
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).notes).toBe('Historical note');
  });
  it('does not grant edit access through another contact at a shared account', async () => {
    await prisma.companyCache.create({ data: { id: 'shared-company', name: 'Shared company' } });
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { companyId: 'shared-company', podOwner: 'ALISA' } });
    await prisma.personCache.update({ where: { id: 'person-02' }, data: { companyId: 'shared-company', podOwner: 'LEIGH' } });
    expect((await createMeetingAction(meetingForm([b.users.ria.id], ['person-02']))).ok).toBe(true);
    const meeting = await prisma.meeting.findFirstOrThrow();
    expect(meeting.companyId).toBe('shared-company');
    auth.user.mockResolvedValue(session(b.users.alisa, [b.pods.Alisa.id]));
    expect(await canManageMeetingAction(meeting.id)).toBe(false);
  });
  it('finds anyone in Twenty as a prospect, whatever pod they are in, and the team separately', async () => {
    const person = await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-01' } });
    // A junior in another pod still finds them: a meeting can be with anyone in Twenty.
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { podOwner: 'LEIGH' } });
    auth.user.mockResolvedValue({ ...session(b.users.karson, [b.pods.Alisa.id]), role: 'JUNIOR_FO' });
    expect((await searchProspectsAction(person.firstName.slice(0, 3))).some((p) => p.personId === person.id)).toBe(true);
    if (person.email) expect((await searchProspectsAction(person.email))[0]?.personId).toBe(person.id);
    // Our own people are never offered as prospects; they are found as the team.
    expect((await searchProspectsAction(b.users.alisa.email)).length).toBe(0);
    expect((await searchTeamAction(b.users.alisa.name.split(' ')[0])).some((t) => t.userId === b.users.alisa.id)).toBe(true);
  });
});

describe('team and pod administration', () => {
  const assignLiveWork = () => enrollPeople({ personIds: ['person-01'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-09', assignment: { mode: 'FIXED' as const, foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR }, { now: new Date('2026-09-09T14:00:00Z'), skipSync: true });
  it('creates Sales Leaders in Central Time and stores the selected pods', async () => {
    const fd = form({ name: 'Pilot Leader', email: 'pilot.leader@example.com', role: 'SALES_LEADER', password: 'pilot-password-123', timezone: 'Europe/London' }); fd.append('podIds', b.pods.Alisa.id);
    expect((await createUserAction(fd)).ok).toBe(true);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'pilot.leader@example.com' }, include: { pods: true } });
    expect(user).toMatchObject({ role: 'SALES_LEADER', timezone: WORKSPACE_TIMEZONE });
    expect(user.pods.map((p) => p.podId)).toEqual([b.pods.Alisa.id]);
  });
  it('updates email and maps the CRM member automatically', async () => {
    const fd = form({ userId: b.users.alisa.id, name: b.users.alisa.name, email: 'alisa@acumen.example', role: 'SENIOR_FO' }); fd.append('podIds', b.pods.Alisa.id);
    expect((await updateUserAction(fd)).ok).toBe(true);
    expect(await prisma.user.findUnique({ where: { id: b.users.alisa.id } })).toMatchObject({ email: 'alisa@acumen.example', twentyMemberId: 'wm-alisa', timezone: WORKSPACE_TIMEZONE });
  });
  it('removes access and sessions while retaining history and requires explicit restoration', async () => {
    await prisma.session.create({ data: { userId: b.users.alisa.id, token: 'pilot-session', expiresAt: new Date('2030-01-01') } });
    expect((await setUserAccessAction(form({ userId: b.users.alisa.id, active: 'false' }))).ok).toBe(true);
    expect(await prisma.session.count({ where: { userId: b.users.alisa.id } })).toBe(0);
    const edit = form({ userId: b.users.alisa.id, name: b.users.alisa.name, email: b.users.alisa.email, role: 'SENIOR_FO' }); edit.append('podIds', b.pods.Alisa.id);
    expect((await updateUserAction(edit)).ok).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.users.alisa.id } })).active).toBe(false);
    expect((await setUserAccessAction(form({ userId: b.users.alisa.id, active: 'true' }))).ok).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.users.alisa.id } })).active).toBe(true);
  });
  it('keeps removed pods archived after CRM rediscovery and blocks new memberships until restored', async () => {
    expect((await createPodAction(form({ name: 'Pilot pod' }))).ok).toBe(true);
    const pod = await prisma.pod.findUniqueOrThrow({ where: { name: 'Pilot pod' } });
    expect((await deletePodAction(form({ podId: pod.id }))).ok).toBe(true);
    await ensurePod(pod.podOwnerValue, 'Pilot pod');
    expect((await prisma.pod.findUniqueOrThrow({ where: { id: pod.id } })).archived).toBe(true);
    const edit = form({ userId: b.users.alisa.id, name: b.users.alisa.name, email: b.users.alisa.email, role: 'SENIOR_FO' }); edit.append('podIds', pod.id);
    expect((await updateUserAction(edit)).ok).toBe(false);
    expect((await restorePodAction(form({ podId: pod.id }))).ok).toBe(true);
    expect((await updateUserAction(edit)).ok).toBe(true);
  });
  it('refuses a membership edit that would strand live assigned work', async () => {
    await assignLiveWork();
    expect((await deletePodAction(form({ podId: b.pods.Alisa.id }))).ok).toBe(false);
    expect((await prisma.pod.findUniqueOrThrow({ where: { id: b.pods.Alisa.id } })).archived).toBe(false);
    const edit = form({ userId: b.users.alisa.id, name: b.users.alisa.name, email: b.users.alisa.email, role: 'SENIOR_FO' });
    expect((await updateUserAction(edit)).ok).toBe(false);
    expect(await prisma.userPod.findUnique({ where: { userId_podId: { userId: b.users.alisa.id, podId: b.pods.Alisa.id } } })).not.toBeNull();
  });
  it('requires an eligible replacement and transfers live work atomically before removing access', async () => {
    await assignLiveWork();
    expect((await setUserAccessAction(form({ userId: b.users.alisa.id, active: 'false' }))).ok).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.users.alisa.id } })).active).toBe(true);
    expect((await setUserAccessAction(form({ userId: b.users.alisa.id, active: 'false', replacementId: b.users.leigh.id }))).ok).toBe(false);
    expect((await setUserAccessAction(form({ userId: b.users.alisa.id, active: 'false', replacementId: b.users.karson.id }))).ok).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.users.alisa.id } })).active).toBe(false);
    expect(await prisma.enrollment.count({ where: { foUserId: b.users.alisa.id, status: { in: ['ACTIVE', 'PAUSED'] } } })).toBe(0);
    expect(await prisma.task.count({ where: { foUserId: b.users.alisa.id, state: 'PENDING' } })).toBe(0);
    expect(await prisma.task.count({ where: { foUserId: b.users.karson.id, state: 'PENDING' } })).toBeGreaterThan(0);
  });
});
