import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { createMeetingAction, updateMeetingAction } from '@/lib/actions/meetings';
import { addMeetingBackAction, approveMeetingAction, declineMeetingAction } from '@/lib/actions/meeting-approval';
import { approvalList, meetingsTabCounts, waitingForMe } from '@/lib/meetings/approval';
import { canApproveMeeting } from '@/lib/auth/rbac';
import { removeMeetingFromCrm, pushMeetingToCrm } from '@/lib/meetings/crm';
import { WORKSPACE_TIMEZONE } from '@/lib/workspace';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { withPeople } from './helpers/meeting-form';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.user, requireAdmin: auth.user, toActor: (user: SessionUser) => ({ id: user.id, role: user.role, podIds: user.podIds }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/meetings/crm', async (orig) => ({ ...(await orig<typeof import('@/lib/meetings/crm')>()), pushMeetingToCrm: vi.fn(async () => undefined), removeMeetingFromCrm: vi.fn(async () => undefined) }));

/**
 * Meetings with no recording link (owner, 20 November 2026): the Sales Leader of the booked-by FO's
 * pod, or an admin, approves or declines. A decline takes the meeting out of Cadence and the CRM and
 * tells Biz Ops and the FO why; only the Sales Leader, Biz Ops or an admin can add it back.
 */
let b: Basics;
let sam: User; // Sales Leader of Pod Alisa
let bea: User; // Biz Ops
const pods: Record<string, string[]> = {};

function as(user: User) {
  auth.user.mockResolvedValue({ ...user, timezone: WORKSPACE_TIMEZONE, podIds: pods[user.id] ?? [], pods: [] });
}
const actor = (user: User) => ({ id: user.id, role: user.role, podIds: pods[user.id] ?? [] });
function form(values: Record<string, string>, prospects = ['person-01']) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ title: 'Intro call', occurredAt: '2026-11-10', bookedById: b.users.karson.id, ...values })) fd.set(k, v);
  return withPeople(fd, b.users.karson.id, prospects);
}
const ids = (fd: FormData) => fd;
async function add(user: User, values: Record<string, string> = {}, prospects?: string[]) {
  as(user);
  const r = await createMeetingAction(ids(form(values, prospects)));
  expect(r).toMatchObject({ ok: true });
  return { r, meeting: await prisma.meeting.findFirstOrThrow({ where: { title: values.title ?? 'Intro call' }, orderBy: { createdAt: 'desc' } }) };
}
const payload = (meetingId: string, extra: Record<string, string> = {}) => { const fd = new FormData(); fd.set('meetingId', meetingId); for (const [k, v] of Object.entries(extra)) fd.set(k, v); return fd; };

beforeEach(async () => {
  await resetDb();
  b = await seedBasics();
  vi.mocked(removeMeetingFromCrm).mockClear();
  vi.mocked(pushMeetingToCrm).mockClear();
  sam = await prisma.user.create({ data: { email: 'sam@cadence.local', name: 'Sam Leader', role: 'SALES_LEADER', passwordHash: 'x', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
  bea = await prisma.user.create({ data: { email: 'bea@cadence.local', name: 'Bea Ops', role: 'BIZ_OPS', passwordHash: 'x' } });
  Object.assign(pods, {
    [sam.id]: [b.pods.Alisa.id], [bea.id]: [], [b.users.ria.id]: [],
    [b.users.alisa.id]: [b.pods.Alisa.id], [b.users.karson.id]: [b.pods.Alisa.id], [b.users.daniel.id]: [b.pods.Leigh.id],
  });
});

describe('who is asked', () => {
  it('a meeting with no recording waits for the Sales Leader of the FO who booked it, and nobody else is asked', async () => {
    const { r, meeting } = await add(b.users.karson);
    expect(r).toMatchObject({ message: expect.stringContaining('Sam Leader will approve it') });
    expect(meeting).toMatchObject({ approval: 'WAITING', review: 'APPROVED' });
    const asked = await prisma.notification.findMany({ where: { kind: 'meeting_approval' } });
    expect(asked.map((n) => n.userId)).toEqual([sam.id]);
    expect(asked[0].payload).toMatchObject({ meetingId: meeting.id, bookedBy: b.users.karson.name });
  });

  it('a meeting with a recording link needs no approval', async () => {
    const { meeting } = await add(b.users.karson, { sourceUrl: 'https://acumen.zoom.us/rec/share/abc' });
    expect(meeting.approval).toBeNull();
    expect(await prisma.notification.count({ where: { kind: 'meeting_approval' } })).toBe(0);
  });

  it('a pod with no Sales Leader asks the admins', async () => {
    const { r, meeting } = await add(b.users.daniel, { bookedById: b.users.daniel.id });
    expect(r).toMatchObject({ message: expect.stringContaining('an admin will approve it') });
    expect(meeting.approval).toBe('WAITING');
    expect((await prisma.notification.findMany({ where: { kind: 'meeting_approval' } })).map((n) => n.userId)).toEqual([b.users.ria.id]);
  });

  it('a Sales Leader never approves a meeting they booked: the admins are asked', async () => {
    const { meeting } = await add(sam, { bookedById: sam.id });
    expect(meeting.approval).toBe('WAITING');
    expect((await prisma.notification.findMany({ where: { kind: 'meeting_approval' } })).map((n) => n.userId)).toEqual([b.users.ria.id]);
    expect(canApproveMeeting(actor(sam), { bookedById: sam.id, bookerPodIds: [b.pods.Alisa.id] })).toBe(false);
  });

  it('whoever may approve it approves it by adding it: the pod\'s Sales Leader, or an admin', async () => {
    const bySam = await add(sam, { title: 'Sam adds it' });
    expect(bySam.meeting).toMatchObject({ approval: 'APPROVED', approvalById: sam.id });
    const byRia = await add(b.users.ria, { title: 'Ria adds it', occurredAt: '2026-11-11' });
    expect(byRia.meeting).toMatchObject({ approval: 'APPROVED', approvalById: b.users.ria.id });
    expect(await prisma.notification.count({ where: { kind: 'meeting_approval' } })).toBe(0);
  });

  it('a Senior FO or Pod Manager cannot approve: only the Sales Leader of that pod and admins', async () => {
    const ref = { bookedById: b.users.karson.id, bookerPodIds: [b.pods.Alisa.id] };
    expect(canApproveMeeting(actor(b.users.alisa), ref)).toBe(false);
    expect(canApproveMeeting({ id: 'pm', role: 'POD_MANAGER', podIds: [b.pods.Alisa.id] }, ref)).toBe(false);
    expect(canApproveMeeting({ id: 'other-sl', role: 'SALES_LEADER', podIds: [b.pods.Leigh.id] }, ref)).toBe(false);
    expect(canApproveMeeting(actor(bea), ref)).toBe(false);
    expect(canApproveMeeting(actor(sam), ref)).toBe(true);
    expect(canApproveMeeting(actor(b.users.ria), ref)).toBe(true);
  });
});

describe('Meetings > Approval', () => {
  it('a Sales Leader sees only their own pods\' FOs; admins see all; Biz Ops see only the declined', async () => {
    await add(b.users.karson);
    await add(b.users.daniel, { title: 'Leigh pod call', bookedById: b.users.daniel.id });
    expect(await waitingForMe(actor(sam))).toBe(1);
    expect((await approvalList(actor(sam), 'waiting')).map((r) => r.title)).toEqual(['Intro call']);
    expect(await waitingForMe(actor(b.users.ria))).toBe(2);
    expect(await waitingForMe(actor(bea))).toBe(0);
    expect(await waitingForMe(actor(b.users.karson))).toBe(0);
    expect(await meetingsTabCounts(actor(bea))).toEqual({ decides: false, waiting: 0, declined: 0 });
    expect(await meetingsTabCounts(actor(b.users.karson))).toBeNull();
    expect(await meetingsTabCounts(actor(b.users.alisa))).toBeNull();
  });
});

describe('approve and decline', () => {
  it('approving keeps it as it is and settles the bell line; a Senior FO is refused', async () => {
    const { meeting } = await add(b.users.karson);
    as(b.users.alisa);
    expect(await approveMeetingAction(payload(meeting.id))).toMatchObject({ ok: false, error: expect.stringContaining('Sales Leader') });
    as(sam);
    expect(await approveMeetingAction(payload(meeting.id))).toMatchObject({ ok: true });
    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).toMatchObject({ approval: 'APPROVED', approvalById: sam.id, review: 'APPROVED' });
    expect(await prisma.notification.findFirstOrThrow({ where: { kind: 'meeting_approval' } })).toMatchObject({ resolution: 'approved' });
    // Decided once: a second decision is refused.
    expect(await declineMeetingAction(payload(meeting.id, { reason: 'x' }))).toMatchObject({ ok: false, error: expect.stringContaining('approved already') });
  });

  it('declining needs a reason, takes it out of Cadence and the CRM, and tells Biz Ops and the FO why', async () => {
    const { meeting } = await add(b.users.karson);
    await prisma.meeting.update({ where: { id: meeting.id }, data: { twentyMeetingId: 'tw-meeting-1' } });
    // A later meeting with the same prospect is the 2nd until the first is declined.
    const later = await add(b.users.karson, { title: 'Second call', occurredAt: '2026-11-12', sourceUrl: 'https://acumen.zoom.us/rec/share/xyz' });
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: later.meeting.id } })).meetingNumber).toBe(2);

    as(sam);
    expect(await declineMeetingAction(payload(meeting.id, { reason: '  ' }))).toMatchObject({ ok: false, error: expect.stringContaining('Say why') });
    expect(await declineMeetingAction(payload(meeting.id, { reason: 'No proof it took place' }))).toMatchObject({ ok: true });

    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).toMatchObject({ approval: 'DECLINED', review: 'DISMISSED', declinedById: sam.id, declineReason: 'No proof it took place', twentyMeetingId: null });
    expect(removeMeetingFromCrm).toHaveBeenCalledWith({ twentyMeetingId: 'tw-meeting-1', twentyNoteId: null });
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: later.meeting.id } })).meetingNumber).toBe(1);
    const told = await prisma.notification.findMany({ where: { kind: 'meeting_declined' } });
    expect(told.map((n) => n.userId).sort()).toEqual([bea.id, b.users.karson.id].sort());
    expect(told[0].payload).toMatchObject({ reason: 'No proof it took place' });
    expect(await prisma.notification.findFirstOrThrow({ where: { kind: 'meeting_approval' } })).toMatchObject({ resolution: 'declined' });
    expect(await waitingForMe(actor(sam))).toBe(0);
    expect((await approvalList(actor(bea), 'declined')).map((r) => ({ title: r.title, mayAddBack: r.mayAddBack }))).toEqual([{ title: 'Intro call', mayAddBack: true }]);
  });

  it('a declined meeting cannot come back as a new one, or be edited, until it is added back', async () => {
    const { meeting } = await add(b.users.karson);
    as(sam);
    await declineMeetingAction(payload(meeting.id, { reason: 'Duplicate of the Zoom call' }));
    as(b.users.karson);
    expect(await createMeetingAction(form({}))).toMatchObject({ ok: false, error: expect.stringContaining('was declined') });
    const edit = form({}); edit.set('meetingId', meeting.id);
    expect(await updateMeetingAction(edit)).toMatchObject({ ok: false, error: expect.stringContaining('declined') });
    // Another day, or another prospect, is another meeting.
    expect(await createMeetingAction(form({ occurredAt: '2026-11-13' }))).toMatchObject({ ok: true });
  });

  it('the genuine meeting beside a declined duplicate stays editable; moving another onto it is refused', async () => {
    const genuine = await add(b.users.karson, { title: 'Recorded call', sourceUrl: 'https://acumen.zoom.us/rec/share/abc' });
    const dupe = await add(b.users.karson, { title: 'Duplicate entry', occurredAt: '2026-11-10' });
    as(sam);
    expect(await declineMeetingAction(payload(dupe.meeting.id, { reason: 'Duplicate of the recorded call' }))).toMatchObject({ ok: true });
    as(b.users.karson);
    const edit = form({ title: 'Recorded call, renamed', sourceUrl: 'https://acumen.zoom.us/rec/share/abc' }); edit.set('meetingId', genuine.meeting.id);
    expect(await updateMeetingAction(edit)).toMatchObject({ ok: true });
    const other = await add(b.users.karson, { title: 'Later call', occurredAt: '2026-11-20', sourceUrl: 'https://acumen.zoom.us/rec/share/zzz' });
    as(b.users.karson);
    const onto = form({ title: 'Later call', occurredAt: '2026-11-10', sourceUrl: 'https://acumen.zoom.us/rec/share/zzz' }); onto.set('meetingId', other.meeting.id);
    expect(await updateMeetingAction(onto)).toMatchObject({ ok: false, error: expect.stringContaining('was declined') });
  });

  it('only the Sales Leader, Biz Ops or an admin adds a declined meeting back; it counts and goes to the CRM again', async () => {
    const { meeting } = await add(b.users.karson);
    as(sam);
    await declineMeetingAction(payload(meeting.id, { reason: 'No recording' }));
    as(b.users.karson);
    expect(await addMeetingBackAction(payload(meeting.id))).toMatchObject({ ok: false });
    vi.mocked(pushMeetingToCrm).mockClear();
    as(bea);
    expect(await addMeetingBackAction(payload(meeting.id))).toMatchObject({ ok: true });
    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).toMatchObject({ approval: 'APPROVED', review: 'APPROVED', approvalById: bea.id, meetingNumber: 1 });
    expect(pushMeetingToCrm).toHaveBeenCalledWith(meeting.id);
    expect((await prisma.notification.findMany({ where: { kind: 'meeting_added_back' } })).map((n) => n.userId)).toEqual([b.users.karson.id]);
    expect(await addMeetingBackAction(payload(meeting.id))).toMatchObject({ ok: false, error: expect.stringContaining('in Cadence already') });
  });
});

describe('editing a meeting', () => {
  it('a recording link added to a waiting meeting settles it; one taken off asks', async () => {
    const { meeting } = await add(b.users.karson);
    as(b.users.karson);
    const withLink = form({ sourceUrl: 'https://acumen.zoom.us/rec/share/abc' }); withLink.set('meetingId', meeting.id);
    expect(await updateMeetingAction(withLink)).toMatchObject({ ok: true });
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).approval).toBeNull();
    expect(await prisma.notification.findFirstOrThrow({ where: { kind: 'meeting_approval' } })).toMatchObject({ resolution: 'link_added' });

    const without = form({}); without.set('meetingId', meeting.id);
    expect(await updateMeetingAction(without)).toMatchObject({ ok: true, message: expect.stringContaining('Sam Leader will approve it') });
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).approval).toBe('WAITING');
  });

  it('a meeting saved without a link before approvals began is never asked about', async () => {
    const old = await prisma.meeting.create({ data: { title: 'Old in person', sourceUrl: '', occurredAt: new Date('2026-11-01T12:00:00Z'), createdById: b.users.karson.id, bookedById: b.users.karson.id } });
    as(b.users.karson);
    const edit = form({ title: 'Old in person', occurredAt: '2026-11-01' }); edit.set('meetingId', old.id);
    expect(await updateMeetingAction(edit)).toMatchObject({ ok: true, message: 'Saved.' });
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: old.id } })).approval).toBeNull();
    expect(await prisma.notification.count({ where: { kind: 'meeting_approval' } })).toBe(0);
  });
});
