import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import { listNotifications, markNotificationsRead, notify, unreadNotifications, type BellItem } from '@/lib/notifications';
import { acceptSuggestion } from '@/lib/outreach/suggestions';
import { userActor } from '@/lib/audit';
import { runSandboxRetention } from '@/lib/sandbox/retention';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/**
 * The notification bell (W10): every kind an earlier stage writes, in plain words, each linking to
 * what it is about; read and unread as the bell has always worked.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let b: Basics;
const viewer = (u: { id: string; twentyMemberId: string | null }, role: Role = 'SENIOR_FO') => ({ id: u.id, twentyMemberId: u.twentyMemberId, role });
const words = (i: BellItem) => [i.name, i.title, i.detail ?? '', i.linkLabel].join(' ');

describe('the notification bell', () => {
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });

  it('shows every kind of notification in plain words, each linking to what it is about', async () => {
    const alisa = b.users.alisa;
    const c = await readyContact(alisa.id, b.pods.Alisa.id, { firstName: 'Jane', lastName: 'Doe', companyName: 'Harbor Light' });
    const other = await readyContact(alisa.id, b.pods.Alisa.id, { firstName: 'Erin', lastName: 'Wu' });
    const person = await prisma.personCache.findFirstOrThrow({ where: { ownerMemberId: 'wm-alisa' } });
    const call = await prisma.callLog.create({ data: { source: 'MANUAL', userId: b.users.karson.id, direction: 'OUTBOUND', status: 'COMPLETED', fromNumber: '+13125550100', toNumber: '+13125550171', sandboxContactId: c.id, startedAt: new Date('2026-11-04T15:00:00Z') } });
    const move = await prisma.sandboxMove.create({ data: { createdById: alisa.id, state: 'DONE', count: 4 } });
    const at = (m: number) => new Date(Date.UTC(2026, 10, 4, 15, m));
    const rows: Array<Parameters<typeof notify>[1] & { at: Date }> = [
      { kind: 'reply', sandboxContactId: c.id, payload: { subject: 'Re: A quick idea' }, at: at(1) },
      { kind: 'bounce', sandboxContactId: c.id, payload: { subject: 'Email 1', text: 'The address is marked bounced and their campaign ended. Find another way to reach them.' }, at: at(2) },
      { kind: 'possible_bounce', sandboxContactId: c.id, payload: { subject: 'Email 2' }, at: at(3) },
      { kind: 'compliance_alert', sandboxContactId: c.id, fromUserId: alisa.id, payload: { text: 'Alisa emailed Jane Doe (j***@harbor.example) on 4 Nov, 15:00. They asked not to be contacted. Do not email, call or message this person.' }, at: at(4) },
      { kind: 'next_step_suggestion', sandboxContactId: c.id, fromUserId: b.users.karson.id, payload: { what: 'Follow up on pricing', how: 'CALL', kind: 'ACTION', when: '2026-11-12', callId: call.id, from: 'Karson' }, at: at(5) },
      { kind: 'call_flag', fromUserId: b.users.karson.id, payload: { text: 'Karson left a 3m 12s voicemail for Jane Doe.', callId: call.id, href: `/calls/${call.id}` }, at: at(6) },
      { kind: 'move_finished', payload: { moveId: move.id, done: 3, failed: 1, text: 'Move to CRM finished: 3 moved, 1 failed.', href: `/cold-outreach/moves/${move.id}` }, at: at(7) },
      { kind: 'retention_warning', payload: { count: 2, firstDueOn: '2027-02-01', contactIds: [c.id, other.id] }, at: at(8) },
    ];
    for (const r of rows) await prisma.notification.create({ data: { userId: alisa.id, kind: r.kind, sandboxContactId: r.sandboxContactId ?? null, fromUserId: r.fromUserId ?? null, payload: r.payload as object, createdAt: r.at } });
    await prisma.touch.create({ data: { personId: person.id, channel: 'EMAIL', direction: 'INBOUND', occurredAt: at(0), summary: 'Reply: Q2 update', externalId: 'message:bell:1', audience: 'CRM', createdAt: at(0) } });

    const page = await listNotifications(viewer(alisa));
    const by = Object.fromEntries(page.items.map((i) => [i.kind, i])) as Record<BellItem['kind'], BellItem>;
    expect(page.items.map((i) => i.kind)).toEqual(['retention_warning', 'move_finished', 'call_flag', 'next_step_suggestion', 'compliance_alert', 'possible_bounce', 'bounce', 'reply', 'crm_reply']);
    expect(by.reply).toEqual(expect.objectContaining({ name: 'Jane Doe', company: 'Harbor Light', title: 'Replied: Re: A quick idea', href: `/cold-outreach/${c.id}` }));
    expect(by.bounce).toEqual(expect.objectContaining({ title: 'Email bounced: Email 1', href: `/cold-outreach/${c.id}`, detail: expect.stringContaining('campaign ended') }));
    expect(by.possible_bounce).toEqual(expect.objectContaining({ title: 'Possible bounce: Email 2', detail: expect.stringContaining('Check the address') }));
    expect(by.compliance_alert).toEqual(expect.objectContaining({ title: 'Emailed someone who must not be contacted', href: `/cold-outreach/${c.id}` }));
    expect(by.next_step_suggestion).toEqual(expect.objectContaining({ title: 'Karson Reed suggests a next step: Follow up on pricing (Call) on 12 Nov', href: `/cold-outreach/${c.id}`, suggestion: expect.objectContaining({ mayAccept: true, resolution: null }) }));
    expect(by.call_flag).toEqual(expect.objectContaining({ name: 'Karson Reed', title: 'Karson left a 3m 12s voicemail for Jane Doe.', href: `/calls/${call.id}` }));
    expect(by.move_finished).toEqual(expect.objectContaining({ title: '3 contacts moved, 1 failed', href: `/cold-outreach/moves/${move.id}`, detail: expect.stringContaining('retry') }));
    expect(by.retention_warning).toEqual(expect.objectContaining({ title: '2 cold contacts of yours will be removed from 1 Feb 2027 unless someone works them', detail: expect.stringContaining('Jane Doe'), href: '/cold-outreach?owner=mine' }));
    expect(by.crm_reply).toEqual(expect.objectContaining({ title: 'Reply: Q2 update', href: `/people/${person.id}?tab=emails` }));
    // Plain words: the screen never says "sandbox" or "Twenty".
    for (const i of page.items) expect(words(i)).not.toMatch(/sandbox|twenty/i);
  });

  it('counts CRM replies and notifications as unread until Mark read, which marks everything up to when the list was opened', async () => {
    const alisa = b.users.alisa;
    const me = viewer(alisa);
    const c = await readyContact(alisa.id, b.pods.Alisa.id);
    const person = await prisma.personCache.findFirstOrThrow({ where: { ownerMemberId: 'wm-alisa' } });
    await prisma.touch.create({ data: { personId: person.id, channel: 'EMAIL', direction: 'INBOUND', occurredAt: new Date(), summary: 'Reply: hello', externalId: 'message:bell:2', audience: 'CRM' } });
    await notify([alisa.id, alisa.id, null], { kind: 'reply', sandboxContactId: c.id, payload: { subject: 'Re: hi' } });
    expect(await unreadNotifications(me)).toBe(2);
    const page = await listNotifications(me);
    expect(page.items.every((i) => i.unread)).toBe(true);

    await markNotificationsRead(alisa.id, new Date(page.through));
    expect(await unreadNotifications(me)).toBe(0);
    expect((await listNotifications(me)).items.some((i) => i.unread)).toBe(false);
    expect(await prisma.notification.count({ where: { userId: alisa.id, readAt: null } })).toBe(0);

    // Something newer than the list rings again.
    await new Promise((r) => setTimeout(r, 5));
    await notify([alisa.id], { kind: 'bounce', sandboxContactId: c.id, payload: { subject: 'Email 1', text: 'The address is marked bounced.' } });
    expect(await unreadNotifications(me)).toBe(1);
    // Someone else's bell is their own.
    expect(await unreadNotifications(viewer(b.users.andrew))).toBe(0);
  });

  it('pages newest first across CRM replies and notifications, with nothing repeated or lost', async () => {
    const alisa = b.users.alisa;
    const c = await readyContact(alisa.id, b.pods.Alisa.id);
    const person = await prisma.personCache.findFirstOrThrow({ where: { ownerMemberId: 'wm-alisa' } });
    const base = Date.UTC(2026, 10, 4, 12);
    for (let i = 0; i < 18; i++) await prisma.notification.create({ data: { userId: alisa.id, kind: 'reply', sandboxContactId: c.id, payload: { subject: `n${i}` }, createdAt: new Date(base + i * 2 * 60_000) } });
    for (let i = 0; i < 14; i++) await prisma.touch.create({ data: { personId: person.id, channel: 'EMAIL', direction: 'INBOUND', occurredAt: new Date(base), summary: `Reply: t${i}`, externalId: `message:page:${i}`, audience: 'CRM', createdAt: new Date(base + (i * 2 + 1) * 60_000) } });
    const first = await listNotifications(viewer(alisa));
    expect(first.items).toHaveLength(25);
    expect(first.next).not.toBeNull();
    const second = await listNotifications(viewer(alisa), first.next);
    expect(second.items).toHaveLength(7);
    expect(second.next).toBeNull();
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((i) => i.id)).size).toBe(32);
    // Newest first, the two kinds interleaved as they arrived.
    expect(all.slice(0, 3).map((i) => i.title)).toEqual(['Replied: n17', 'Replied: n16', 'Replied: n15']);
    expect(all.slice(3, 6).map((i) => i.title)).toEqual(['Replied: n14', 'Reply: t13', 'Replied: n13']);
    expect(all[31].title).toBe('Replied: n0');
    await expect(listNotifications(viewer(alisa), 'not-a-cursor')).rejects.toThrow('Notification cursor is unavailable.');
  });

  it('offers Accept as next step on a suggestion until it is answered, and never to Biz Ops', async () => {
    const alisa = b.users.alisa;
    const c = await readyContact(alisa.id, b.pods.Alisa.id);
    const n = await prisma.notification.create({ data: { userId: alisa.id, kind: 'next_step_suggestion', sandboxContactId: c.id, fromUserId: b.users.karson.id, payload: { what: 'Send the deck', how: 'EMAIL', kind: 'ACTION', when: '2099-01-05', from: 'Karson' } } });
    expect((await listNotifications(viewer(alisa))).items[0].suggestion).toEqual({ id: n.id, resolution: null, mayAccept: true });
    expect((await listNotifications(viewer(alisa, 'BIZ_OPS'))).items[0].suggestion?.mayAccept).toBe(false);

    const r = await acceptSuggestion(n.id, { id: alisa.id, role: 'SENIOR_FO', podIds: [b.pods.Alisa.id], name: alisa.name, timezone: 'Europe/London' }, userActor(alisa));
    expect(r.ok).toBe(true);
    const item = (await listNotifications(viewer(alisa))).items[0];
    expect(item.suggestion).toEqual({ id: n.id, resolution: 'accepted', mayAccept: false });
    expect(item.detail).toBe('You accepted it: it is the next step now.');
    expect(item.unread).toBe(false);
  });

  it('rings once for a retention warning that has not changed, not every night', async () => {
    const NOW = new Date('2027-03-01T03:00:00Z');
    const soon = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { createdAt: new Date(NOW.getTime() - 88 * 86_400_000), lastActivityAt: null });
    await runSandboxRetention(NOW);
    const me = viewer(b.users.alisa);
    expect(await unreadNotifications(me)).toBe(1);
    await markNotificationsRead(b.users.alisa.id, new Date());
    await runSandboxRetention(new Date(NOW.getTime() + 3_600_000));
    expect(await unreadNotifications(me)).toBe(0);
    expect(await prisma.notification.count({ where: { kind: 'retention_warning' } })).toBe(1);
    // A new contact due changes the warning, so it rings again.
    await readyContact(b.users.alisa.id, b.pods.Alisa.id, { createdAt: new Date(NOW.getTime() - 87 * 86_400_000), lastActivityAt: null });
    await runSandboxRetention(new Date(NOW.getTime() + 7_200_000));
    expect(await unreadNotifications(me)).toBe(1);
    expect(soon.id).toBeTruthy();
  });
});
