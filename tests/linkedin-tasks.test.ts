import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { todayIn } from '@/lib/dates';
import { processPendingEvents, storeEvents } from '@/lib/linkedin/events';
import { listFollowUpItems, needsOwnerItems } from '@/lib/linkedin/tasks-view';
import { dueCounts } from '@/lib/tasks-query';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { sessionOf } from './helpers/cold-campaign';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.user, requireAdmin: auth.user, toActor: (user: SessionUser) => user }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
const { assignFollowUpAction, completeFollowUpAction } = await import('@/lib/actions/linkedin');

let b: Basics;
let seq = 0;
const ev = (type: string, publicId: string, data: Record<string, unknown> = {}) => ({ seq: ++seq, type, at: new Date().toISOString(), account: { id: 'acc-1', linkedinName: 'Sam Leader' }, user: { email: 'alisa@cadence.local' }, person: { publicId, profileUrl: `https://www.linkedin.com/in/${publicId}`, name: 'Nia New' }, data });
const form = (o: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(o)) fd.set(k, v); return fd; };

/** Someone unknown Alisa reached who accepted: an ownerless cold contact in Alisa's pod, waiting for an owner. */
async function acceptedStranger(publicId = 'nia-new') {
  await storeEvents([ev('invitation.sent', publicId), ev('connection.accepted', publicId, { invitedByUs: true })], 'test');
  await processPendingEvents();
  return prisma.linkedInFollowUp.findFirstOrThrow({ where: { sandboxContact: { linkedinUrl: `linkedin.com/in/${publicId}` } } });
}

beforeEach(async () => { await resetDb(); b = await seedBasics(); seq = 0; });

describe('LinkedIn tasks on the Tasks screen', () => {
  it('needs an owner: shown to the pod, not in anyone\'s tabs, and in the tabs once taken', async () => {
    const f = await acceptedStranger();
    const karson = await sessionOf(b.users.karson.id);
    const leigh = await sessionOf(b.users.leigh.id);
    expect((await needsOwnerItems(karson)).map((x) => x.id)).toEqual([f.id]);
    expect(await needsOwnerItems(leigh)).toEqual([]);
    expect((await listFollowUpItems(karson, { tab: 'upcoming' }, new Date())).rows).toEqual([]);

    // Karson takes it: due 2 working days on, so in Upcoming, counted under LinkedIn, and not in a sidebar due count yet.
    auth.user.mockResolvedValue(karson);
    expect(await assignFollowUpAction(form({ id: f.id }))).toMatchObject({ ok: true });
    const list = await listFollowUpItems(karson, { tab: 'upcoming', foUserId: karson.id }, new Date());
    expect(list.rows.map((x) => x.id)).toEqual([f.id]);
    expect(list.counts.upcoming).toBe(1);
    expect(list.channelCounts).toEqual({ CALL: 0, EMAIL: 0, LINKEDIN: 1 });
    expect((await listFollowUpItems(karson, { tab: 'upcoming', channel: 'EMAIL' }, new Date())).rows).toEqual([]);
    expect(await dueCounts(karson.id, 'all', todayIn(karson.timezone))).toEqual({ today: 0, overdue: 0 });
    await prisma.linkedInFollowUp.update({ where: { id: f.id }, data: { dueDate: todayIn(karson.timezone) } });
    expect(await dueCounts(karson.id, 'all', todayIn(karson.timezone))).toEqual({ today: 1, overdue: 0 });
  });

  it('a junior can take it but not give it; another pod cannot touch it', async () => {
    const f = await acceptedStranger();
    auth.user.mockResolvedValue(await sessionOf(b.users.karson.id));
    expect(await assignFollowUpAction(form({ id: f.id, foUserId: b.users.alisa.id }))).toMatchObject({ ok: false });
    auth.user.mockResolvedValue(await sessionOf(b.users.daniel.id));
    expect(await assignFollowUpAction(form({ id: f.id }))).toMatchObject({ ok: false, error: 'This contact is in another pod.' });
    // Alisa leads the pod and gives it to Karson.
    auth.user.mockResolvedValue(await sessionOf(b.users.alisa.id));
    expect(await assignFollowUpAction(form({ id: f.id, foUserId: b.users.karson.id }))).toMatchObject({ ok: true, message: 'Given to Karson ' + b.users.karson.name.split(' ').slice(1).join(' ') + '.' });
    // Only Karson, his pod leader or an admin closes it; Daniel cannot.
    auth.user.mockResolvedValue(await sessionOf(b.users.daniel.id));
    expect(await completeFollowUpAction(form({ id: f.id }))).toMatchObject({ ok: false });
    auth.user.mockResolvedValue(await sessionOf(b.users.karson.id));
    expect(await completeFollowUpAction(form({ id: f.id }))).toMatchObject({ ok: true });
  });
});
