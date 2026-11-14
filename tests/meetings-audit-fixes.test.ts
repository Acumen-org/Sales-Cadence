import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { createMeetingAction, toggleMeetingProductAction, updateMeetingAction } from '@/lib/actions/meetings';
import { findProspects } from '@/lib/meetings/people-search';
import { transcriptKey } from '@/lib/meetings/transcript-key';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { WORKSPACE_TIMEZONE } from '@/lib/workspace';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { withPeople } from './helpers/meeting-form';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.user, requireAdmin: auth.user, toActor: (user: SessionUser) => user }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/** Audit 17 (meetings), severity 2 and 3 fixes in the meeting actions. */
let b: Basics;
const mock = getMockTwentyClient();
const form = (fields: Record<string, string>, prospects = ['person-01']) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ title: 'Kick-off', sourceUrl: '', occurredAt: '2026-10-01', bookedById: b.users.karson.id, ...fields })) fd.set(k, v);
  return withPeople(fd, b.users.alisa.id, prospects);
};

beforeEach(async () => {
  await resetDb(); b = await seedBasics(); mock.reset(); mock.writes = [];
  auth.user.mockResolvedValue({ ...b.users.ria, timezone: WORKSPACE_TIMEZONE, podIds: [], pods: [] });
});

describe('meeting actions', () => {
  it('S13: a colleague’s CRM record cannot be logged as the prospect', async () => {
    await prisma.personCache.update({ where: { id: 'person-03' }, data: { email: b.users.alisa.email } });
    const r = await createMeetingAction(form({}, ['person-03']));
    expect(r).toMatchObject({ ok: false });
    expect(await prisma.meeting.count()).toBe(0);
  });

  it('S18, S20: an edit keeps a transcript that arrived while the form was open, and logs what changed', async () => {
    expect(await createMeetingAction(form({}))).toMatchObject({ ok: true });
    const m = await prisma.meeting.findFirstOrThrow();
    await prisma.meeting.update({ where: { id: m.id }, data: { transcript: 'WEBVTT\n\nArrived from Teams' } });
    const edit = form({ meetingId: m.id, bookedById: b.users.alisa.id, transcript: '', transcriptKey: transcriptKey(null) });
    expect(await updateMeetingAction(edit)).toMatchObject({ ok: true });
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).transcript).toBe('WEBVTT\n\nArrived from Teams');
    const logged = await prisma.auditLog.findFirstOrThrow({ where: { entityId: m.id, action: 'updated' } });
    expect(logged.details).toMatchObject({ changes: { bookedById: { from: b.users.karson.id, to: b.users.alisa.id } }, transcriptChanged: false });
    // Typed over a transcript that changed meanwhile: refused rather than lost.
    const clash = form({ meetingId: m.id, transcript: 'Mine', transcriptKey: transcriptKey(null) });
    expect(await updateMeetingAction(clash)).toMatchObject({ ok: false });
  });

  it('S19: two products tagged at the same moment are both kept', async () => {
    expect(await createMeetingAction(form({}))).toMatchObject({ ok: true });
    const m = await prisma.meeting.findFirstOrThrow();
    const tag = (product: string) => { const fd = new FormData(); fd.set('meetingId', m.id); fd.set('product', product); fd.set('on', 'true'); return toggleMeetingProductAction(fd); };
    await Promise.all([tag('ACUBOOTH'), tag('GLYNAC')]);
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).products).toEqual(['PHH', 'ACUBOOTH', 'GLYNAC']);
  });

  it('S24: the picker asks Twenty only for three letters or more and when the copy has too few', async () => {
    const live = vi.spyOn(mock, 'listPeople');
    await findProspects('ab');
    expect(live).not.toHaveBeenCalled();
    await findProspects('zzzqqq');
    expect(live).toHaveBeenCalledTimes(1);
    live.mockRestore();
  });
});
