import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { completeNextAction, nextOccurrence, setNextActions, stopNextAction, syncNextActions } from '@/lib/next-actions';
import { userActor } from '@/lib/audit';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.user, requireAdmin: auth.user, toActor: (user: SessionUser) => user }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
const { saveNextActionAction } = await import('@/lib/actions/next-actions');

const asUser = (user: User, podIds: string[] = []): SessionUser => ({ ...user, podIds, pods: podIds.map((id) => ({ id, name: id })) });
const WEEKDAYS = [1, 2, 3, 4, 5];

/**
 * A person's next action outside any campaign: once or on repeat, worked in Tasks, and kept in
 * step with Twenty's Next Action and Next Action Due Date both ways.
 */
describe('next actions', () => {
  let b: Basics;
  const mock = getMockTwentyClient();
  const input = { label: 'Check in on the pilot', action: 'EMAIL' as const, dueDate: '2027-03-05', repeat: 'NONE' as const, foUserId: null };

  beforeEach(async () => {
    await resetDb(); b = await seedBasics();
    mock.writes = [];
    auth.user.mockResolvedValue(asUser(b.users.alisa, [b.pods.Alisa.id]));
  });

  it('repeats from the day it was due, never on or before today, and on a working day', () => {
    // Weekly, due Friday 5 March, done late on Wednesday 10 March: next Friday 12 March.
    expect(nextOccurrence('2027-03-05', 'WEEKLY', '2027-03-10', WEEKDAYS)).toBe('2027-03-12');
    expect(nextOccurrence('2027-03-05', 'BIWEEKLY', '2027-03-05', WEEKDAYS)).toBe('2027-03-19');
    // Monthly on the 31st keeps to the month's last day; a Saturday moves to Monday.
    expect(nextOccurrence('2027-01-29', 'MONTHLY', '2027-01-29', WEEKDAYS)).toBe('2027-03-01');
    expect(nextOccurrence('2027-03-31', 'MONTHLY', '2027-03-31', WEEKDAYS)).toBe('2027-04-30');
    expect(nextOccurrence('2027-01-15', 'QUARTERLY', '2027-01-15', WEEKDAYS)).toBe('2027-04-15');
    expect(nextOccurrence('2027-01-15', 'NONE', '2027-01-15', WEEKDAYS)).toBeNull();
  });

  it("goes to each person's own FO and to Twenty; a second one replaces the first", async () => {
    const people = await prisma.personCache.findMany({ where: { deletedAt: null, dnd: false, ownerMemberId: 'wm-karson' }, take: 1 });
    expect(people).toHaveLength(1);
    const r = await setNextActions([people[0].id], input, userActor(b.users.alisa), b.users.alisa.id);
    expect(r.set).toHaveLength(1);
    const na = await prisma.nextAction.findUniqueOrThrow({ where: { id: r.set[0] } });
    expect(na).toEqual(expect.objectContaining({ foUserId: b.users.karson.id, state: 'OPEN', dueDate: '2027-03-05', crmPending: false }));
    expect(mock.writes).toContainEqual({ op: 'setPersonNextAction', id: people[0].id, patch: { nextAction: 'Check in on the pilot', nextActionDueDate: '2027-03-05' } });
    await setNextActions([people[0].id], { ...input, label: 'Send the case study', dueDate: '2027-03-09' }, userActor(b.users.alisa), b.users.alisa.id);
    const open = await prisma.nextAction.findMany({ where: { personId: people[0].id, state: 'OPEN' } });
    expect(open).toHaveLength(1);
    expect(open[0]).toEqual(expect.objectContaining({ label: 'Send the case study', dueDate: '2027-03-09' }));
  });

  it('leaves out anyone marked do not contact', async () => {
    const dnd = await prisma.personCache.findFirstOrThrow({ where: { deletedAt: null } });
    await prisma.personCache.update({ where: { id: dnd.id }, data: { dnd: true } });
    const r = await setNextActions([dnd.id], input, userActor(b.users.alisa), b.users.alisa.id);
    expect(r.set).toHaveLength(0);
    expect(r.skipped[0].reason).toBe('Marked do not contact');
  });

  it('done moves a repeating one on and writes the new date; a one-off closes and clears Twenty', async () => {
    const [p1, p2] = await prisma.personCache.findMany({ where: { deletedAt: null, dnd: false }, take: 2, orderBy: { id: 'asc' } });
    const [weekly] = (await setNextActions([p1.id], { ...input, repeat: 'WEEKLY', foUserId: b.users.alisa.id }, userActor(b.users.alisa), b.users.alisa.id)).set;
    const [once] = (await setNextActions([p2.id], { ...input, foUserId: b.users.alisa.id }, userActor(b.users.alisa), b.users.alisa.id)).set;
    const now = new Date('2027-03-05T15:00:00Z');
    expect(await completeNextAction(weekly, userActor(b.users.alisa), now)).toEqual({ ok: true, next: '2027-03-12' });
    expect(await prisma.nextAction.findUniqueOrThrow({ where: { id: weekly } })).toEqual(expect.objectContaining({ state: 'OPEN', dueDate: '2027-03-12', doneCount: 1 }));
    expect(mock.writes.at(-1)).toEqual({ op: 'setPersonNextAction', id: p1.id, patch: { nextAction: 'Check in on the pilot', nextActionDueDate: '2027-03-12' } });
    expect(await completeNextAction(once, userActor(b.users.alisa), now)).toEqual({ ok: true, next: null });
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: once } })).state).toBe('DONE');
    expect(mock.writes.at(-1)).toEqual({ op: 'setPersonNextAction', id: p2.id, patch: { nextAction: null, nextActionDueDate: null } });
    await stopNextAction(weekly, userActor(b.users.alisa));
    expect(mock.writes.at(-1)).toEqual({ op: 'setPersonNextAction', id: p1.id, patch: { nextAction: null, nextActionDueDate: null } });
  });

  it('follows a date changed in Twenty, and closes when it is cleared there', async () => {
    const [p1, p2] = await prisma.personCache.findMany({ where: { deletedAt: null, dnd: false }, take: 2, orderBy: { id: 'asc' } });
    const [a] = (await setNextActions([p1.id], input, userActor(b.users.alisa), b.users.alisa.id)).set;
    const [c] = (await setNextActions([p2.id], input, userActor(b.users.alisa), b.users.alisa.id)).set;
    const later = new Date(Date.now() + 60_000);
    await prisma.personCache.update({ where: { id: p1.id }, data: { nextActionDueDate: '2027-04-01', nextAction: 'Call after the board meeting', twentyUpdatedAt: later } });
    await prisma.personCache.update({ where: { id: p2.id }, data: { nextActionDueDate: null, twentyUpdatedAt: later } });
    expect(await syncNextActions()).toEqual(expect.objectContaining({ followed: 1, closed: 1 }));
    expect(await prisma.nextAction.findUniqueOrThrow({ where: { id: a } })).toEqual(expect.objectContaining({ dueDate: '2027-04-01', label: 'Call after the board meeting', state: 'OPEN' }));
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: c } })).state).toBe('CANCELLED');
    // Nothing new in Twenty: nothing moves on the next pass.
    expect(await syncNextActions()).toEqual({ pushed: 0, failed: 0, followed: 0, closed: 0 });
  });

  it('keeps trying Twenty until it takes the change', async () => {
    const p = await prisma.personCache.findFirstOrThrow({ where: { deletedAt: null, dnd: false } });
    mock.failNext = new Error('Twenty is down');
    const [id] = (await setNextActions([p.id], input, userActor(b.users.alisa), b.users.alisa.id)).set;
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id } })).crmPending).toBe(true);
    expect(await syncNextActions()).toEqual(expect.objectContaining({ pushed: 1 }));
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id } })).crmPending).toBe(false);
  });

  it("a junior FO's next actions are their own, whoever they pick", async () => {
    auth.user.mockResolvedValue(asUser(b.users.karson, [b.pods.Alisa.id]));
    const p = await prisma.personCache.findFirstOrThrow({ where: { deletedAt: null, dnd: false } });
    const fd = new FormData();
    fd.set('personIds', JSON.stringify([p.id]));
    for (const [k, v] of Object.entries({ label: 'Follow up', action: 'CALL', dueDate: '2027-03-05', repeat: 'MONTHLY', foUserId: b.users.alisa.id })) fd.set(k, v);
    expect((await saveNextActionAction(fd)).ok).toBe(true);
    expect((await prisma.nextAction.findFirstOrThrow({ where: { personId: p.id } })).foUserId).toBe(b.users.karson.id);
  });
});
