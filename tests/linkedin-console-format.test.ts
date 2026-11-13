import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { resetEnvCache } from '@/lib/env';
import { processPendingEvents, storeEvents } from '@/lib/linkedin/events';
import { pollFeed } from '@/lib/linkedin/console';
import { resetDb, seedBasics, type Basics } from './helpers/db';

/**
 * Events exactly as the LinkedIn Console sends them (its docs/event-feed.md, 13 Nov 2026): per-type fields beside
 * the envelope (not under `data`), the account's name as `name`, and the feed's cursor as `nextCursor`.
 */
let b: Basics;
const consoleEvent = (seq: number, type: string, publicId: string, extra: Record<string, unknown> = {}) => ({
  seq, type, at: new Date().toISOString(),
  person: { memberUrn: `urn:li:fsd_profile:${publicId}`, publicId, profileUrl: `https://www.linkedin.com/in/${publicId}/`, name: 'Jane Doe' },
  account: { id: 'ab12cd34ef56', name: 'Acme Sales' },
  user: { email: 'alisa@cadence.local', name: 'Alisa' },
  ...extra,
});

beforeEach(async () => { await resetDb(); b = await seedBasics(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetEnvCache(); });

describe('the LinkedIn Console\'s own event format', () => {
  it('reads invitedByUs beside the envelope, and the account name', async () => {
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { linkedinUrl: 'https://www.linkedin.com/in/jane-doe', linkedinKey: 'linkedin.com/in/jane-doe', ownerMemberId: b.users.alisa.twentyMemberId, dnd: false, optedOut: false } });
    await storeEvents([consoleEvent(1, 'connection.accepted', 'stranger', { invitedByUs: false, user: null }), consoleEvent(2, 'connection.accepted', 'jane-doe', { invitedByUs: true, user: null })], 'feed');
    expect(await processPendingEvents()).toEqual({ not_ours: 1, accepted_message_opened: 1 });
    expect(await prisma.linkedInAccount.findUniqueOrThrow({ where: { id: 'ab12cd34ef56' } })).toMatchObject({ name: 'Acme Sales' });
    expect(await prisma.linkedInFollowUp.findFirstOrThrow({ where: { personId: 'person-01' } })).toMatchObject({ kind: 'MESSAGE', foUserId: b.users.alisa.id });
  });

  it('follows the feed\'s nextCursor and reads the accounts list', async () => {
    vi.stubEnv('LINKEDIN_CONSOLE_URL', 'https://console.example');
    vi.stubEnv('LINKEDIN_CONSOLE_API_KEY', 'ext_test');
    resetEnvCache();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      const body = url.includes('/accounts') ? { accounts: [{ id: 'ab12cd34ef56', name: 'Acme Sales', invitesLast7Days: 12, inviteWeeklyLimit: 80 }] }
        : url.includes('after=0') ? { events: [consoleEvent(7, 'message.sent', 'jane-doe', { conversationId: 'c1' })], nextCursor: 7 }
        : { events: [], nextCursor: 7 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    expect(await pollFeed()).toEqual({ ran: true, stored: 1 });
    expect(calls[1]).toContain('after=7');
    expect(await prisma.linkedInAccount.findUniqueOrThrow({ where: { id: 'ab12cd34ef56' } })).toMatchObject({ invitesLast7Days: 12, inviteWeeklyLimit: 80 });
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: 'linkedinFeedCursor' } })).value).toMatchObject({ cursor: '7', error: null });
  });
});
