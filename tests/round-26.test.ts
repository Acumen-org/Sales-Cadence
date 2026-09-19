import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { canRate, isMip, mipStarsFor, ratablePodOwners, setMipStars } from '@/lib/mip';
import { createMeetingAction } from '@/lib/actions/meetings';
import { ingestEvent, isAutomaticReply } from '@/lib/engine/ingest';
import { rawFromMessage } from '@/lib/engine/reconcile';
import { enrollPeople } from '@/lib/engine/enrollment';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { accountDetail, listAccounts } from '@/lib/accounts-query';
import { getSettings, RulesSettingsSchema, saveSettingsSection } from '@/lib/settings';
import { WORKSPACE_TIMEZONE, workspaceTimezone } from '@/lib/workspace';
import { resetDb, seedBasics, type Basics } from './helpers/db';

/**
 * The September round: most-important people are starred by their pod, meetings say who booked
 * them and need no recording, an automatic reply is not a reply anywhere replies are counted, and
 * the workspace clock is a setting rather than a constant.
 */
const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/auth/current-user')>()), requireUser: auth.user, requireAdmin: auth.user }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let b: Basics;
const at = (date: string, time = '10:00:00') => new Date(`${date}T${time}Z`);
const iso = (date: string, time = '10:00:00') => at(date, time).toISOString();
const session = (user: Basics['users']['alisa'], podIds: string[] = []): SessionUser => ({ ...user, timezone: WORKSPACE_TIMEZONE, podIds, pods: podIds.map((id) => ({ id, name: id })) });

beforeEach(async () => { await resetDb(); b = await seedBasics(); auth.user.mockResolvedValue(session(b.users.ria)); });

describe('most-important people', () => {
  beforeEach(async () => {
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { tags: ['MIP'], podOwner: 'ALISA' } });
    await prisma.personCache.update({ where: { id: 'person-02' }, data: { tags: [], podOwner: 'ALISA' } });
  });
  it('is a Twenty tag, and stars are set by the pod or an admin only', async () => {
    expect(isMip(['Mip'])).toBe(true);
    expect(isMip(['VIP'])).toBe(false);
    const alisa = session(b.users.alisa, [b.pods.Alisa.id]);
    expect(await setMipStars(alisa, 'person-01', 2)).toEqual({ stars: 2 });
    expect((await mipStarsFor(['person-01', 'person-02'])).get('person-01')).toBe(2);
    // Another pod cannot touch it; an admin can; nobody can star someone Twenty has not tagged.
    await expect(setMipStars(session(b.users.leigh, [b.pods.Leigh.id]), 'person-01', 1)).rejects.toThrow(/that pod/);
    expect(await setMipStars(session(b.users.ria), 'person-01', 3)).toEqual({ stars: 3 });
    await expect(setMipStars(alisa, 'person-02', 1)).rejects.toThrow(/tagged MIP/);
    await expect(setMipStars(alisa, 'person-01', 4)).rejects.toThrow();
    // Clearing removes the row rather than storing a zero.
    expect(await setMipStars(alisa, 'person-01', 0)).toEqual({ stars: 0 });
    expect((await mipStarsFor(['person-01'])).size).toBe(0);
  });
  it('answers who may rate whom without a query per row', async () => {
    expect(await ratablePodOwners(session(b.users.ria))).toBeNull();
    const mine = await ratablePodOwners(session(b.users.alisa, [b.pods.Alisa.id]));
    expect(canRate(mine, 'ALISA')).toBe(true);
    expect(canRate(mine, 'LEIGH')).toBe(false);
    expect(canRate(mine, null)).toBe(false);
    expect(canRate(null, null)).toBe(true);
    expect(canRate(await ratablePodOwners(session(b.users.karson)), 'ALISA')).toBe(false);
  });
});

describe('meetings', () => {
  const form = (values: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(values)) fd.set(k, v); return fd; };
  it('need the FO who booked them and no longer need a recording link', async () => {
    const missing = await createMeetingAction(form({ title: 'No booker', occurredAt: '2026-09-08T14:30' }));
    expect(missing.ok).toBe(false);
    const nobody = await createMeetingAction(form({ title: 'Ghost booker', occurredAt: '2026-09-08T14:30', bookedById: 'nobody' }));
    expect(nobody.ok).toBe(false);
    const ok = await createMeetingAction(form({ title: 'Booked, no recording', occurredAt: '2026-09-08T14:30', bookedById: b.users.alisa.id }));
    expect(ok.ok).toBe(true);
    const meeting = await prisma.meeting.findFirstOrThrow({ where: { title: 'Booked, no recording' } });
    expect(meeting.bookedById).toBe(b.users.alisa.id);
    expect(meeting.mediaUrl).toBeNull();
    expect(meeting.embedUrl).toBeNull();
    expect(meeting.provider).toBe('OTHER');
    // A link, when given, is still checked.
    expect((await createMeetingAction(form({ title: 'Bad link', occurredAt: '2026-09-08T14:30', bookedById: b.users.alisa.id, sourceUrl: 'javascript:alert(1)' }))).ok).toBe(false);
  });
});

describe('automatic replies', () => {
  const mock = getMockTwentyClient();
  it('are recognised by their subject', () => {
    for (const s of ['Automatic reply: Intro', 'Re: Automatic reply: Intro', 'Out of Office', 'Out of the office: back Monday', 'Undeliverable: Intro', 'Accepted: Cadence intro', 'Autoreply']) expect(isAutomaticReply(s)).toBe(true);
    for (const s of ['Re: intro', 'Intro', 'Automatic pilot programme', 'RE: out of office policy question']) expect(isAutomaticReply(s)).toBe(false);
  });
  it('leave the sequence running and are stored as auto-replies, not replies', async () => {
    await enrollPeople({ personIds: ['person-16'], sequenceId: b.sequence.id, podId: b.pods.Leigh.id, startDate: '2026-09-07', assignment: { mode: 'FIXED', foUserId: b.users.leigh.id }, actor: SYSTEM_ACTOR }, { now: at('2026-09-06') });
    const message = mock.addMessage({ subject: 'Automatic reply: intro', receivedAt: iso('2026-09-10'), from: { handle: 'kwame.mensah@harbormedia.example', personId: 'person-16' }, to: [{ handle: 'leigh@acumen.example', workspaceMemberId: 'wm-leigh' }] });
    const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(message), now: at('2026-09-10') });
    expect(r.result).toBe('inbound_automatic_reply');
    expect((await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-16' } })).status).toBe('ACTIVE');
    const touch = await prisma.touch.findFirst({ where: { personId: 'person-16', direction: 'INBOUND' } });
    expect(touch?.summary.startsWith('Auto-reply:')).toBe(true);
  });
});

describe('replies are inbound messages', () => {
  it('count on the Accounts list and the account page, without automatic replies', async () => {
    const person = await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-01' }, select: { companyId: true } });
    const companyId = person.companyId!;
    await prisma.touch.createMany({
      data: [
        { personId: 'person-01', channel: 'EMAIL', direction: 'INBOUND', occurredAt: at('2026-09-10'), summary: 'Reply: Re: intro', externalId: 'message:r1:person:person-01' },
        { personId: 'person-01', channel: 'EMAIL', direction: 'INBOUND', occurredAt: at('2026-09-11'), summary: 'Auto-reply: Out of office', externalId: 'message:r2:person:person-01' },
        { personId: 'person-01', channel: 'EMAIL', direction: 'OUTBOUND', occurredAt: at('2026-09-09'), summary: 'Email sent: intro', externalId: 'message:o1:person:person-01' },
      ],
    });
    const list = await listAccounts(session(b.users.ria));
    expect(list.rows.find((r) => r.id === companyId)?.replied).toBe(1);
    const detail = await accountDetail(companyId, session(b.users.ria));
    expect(detail?.stats.replied).toBe(1);
  });
});

describe('the workspace clock', () => {
  it('is Central Time unless Settings says otherwise, and only a real zone is accepted', async () => {
    expect(RulesSettingsSchema.parse({}).workspaceTimezone).toBe('America/Chicago');
    expect(RulesSettingsSchema.safeParse({ workspaceTimezone: 'Mars/Olympus' }).success).toBe(false);
    const s = await getSettings();
    expect(workspaceTimezone()).toBe(WORKSPACE_TIMEZONE);
    await saveSettingsSection('rules', { ...s.rules, workspaceTimezone: 'America/New_York' });
    await getSettings();
    expect(workspaceTimezone()).toBe('America/New_York');
    await saveSettingsSection('rules', { ...s.rules, workspaceTimezone: 'America/Chicago' });
    await getSettings();
    expect(workspaceTimezone()).toBe('America/Chicago');
  });
});
