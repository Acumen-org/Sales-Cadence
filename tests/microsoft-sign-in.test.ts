import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { getSettings, invalidateSettingsCache, isExternalEmail, saveSettingsSection } from '@/lib/settings';
import { microsoftUser, readIdToken, retirePasswords, signInMethods, SignInError, type MicrosoftIdentity } from '@/lib/auth/microsoft';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { missingMeetingTags, syncMeetingToCrm } from '@/lib/meetings/crm';

/**
 * Signing in with Microsoft (owner, 9 October 2026): the team signs in with their work accounts and
 * passwords go. Someone already on the team keeps their access; someone new joins as a Junior FO
 * with no title until an admin gives one; someone an admin removed stays out.
 */
const app = { clientId: '11111111-1111-4111-8111-111111111111', tenantId: '22222222-2222-4222-8222-222222222222', loginUrl: 'https://login.microsoftonline.com' };
const token = (claims: Record<string, unknown>) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const claims = (extra: Record<string, unknown> = {}) => ({
  aud: app.clientId, tid: app.tenantId, iss: `https://login.microsoftonline.com/${app.tenantId}/v2.0`, nonce: 'n-1',
  exp: Math.floor(Date.now() / 1000) + 600, oid: 'oid-1', name: 'Pat Example', preferred_username: 'Pat@Acumen-Strategy.com', ...extra,
});
const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (err) { return err instanceof SignInError ? err.code : String(err); } };
const identity = (addresses: string[], oid = 'oid-1', name: string | null = 'Pat Example'): MicrosoftIdentity => ({ oid, addresses, name });

describe('the id token Microsoft sends back', () => {
  it('names the account, its addresses and its name', () => {
    expect(readIdToken(token(claims({ email: 'pat@acumen-strategy.com' })), app, 'n-1')).toEqual({ oid: 'oid-1', addresses: ['pat@acumen-strategy.com'], name: 'Pat Example' });
  });

  it('is refused when it was meant for another app, tenant, issuer or attempt, or has expired', async () => {
    expect(await refusal((async () => readIdToken(token(claims({ aud: 'another-app' })), app, 'n-1'))())).toBe('microsoft');
    expect(await refusal((async () => readIdToken(token(claims({ tid: '33333333-3333-4333-8333-333333333333' })), app, 'n-1'))())).toBe('microsoft');
    expect(await refusal((async () => readIdToken(token(claims({ iss: 'https://evil.example/v2.0' })), app, 'n-1'))())).toBe('microsoft');
    expect(await refusal((async () => readIdToken(token(claims()), app, 'another-nonce'))())).toBe('microsoft');
    expect(await refusal((async () => readIdToken(token(claims({ exp: Math.floor(Date.now() / 1000) - 3600 })), app, 'n-1'))())).toBe('expired');
    expect(await refusal((async () => readIdToken('not-a-token', app, 'n-1'))())).toBe('microsoft');
  });
});

describe('who a Microsoft sign-in is', () => {
  let b: Basics;
  beforeEach(async () => { await resetDb(); b = await seedBasics(); });

  it('is the team member with that address, and stays them once their account is known', async () => {
    const alisa = b.users.alisa;
    const first = await microsoftUser(identity([alisa.email], 'oid-alisa'));
    expect(first).toMatchObject({ id: alisa.id, joined: false });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: alisa.id } })).microsoftId).toBe('oid-alisa');
    // Their Microsoft address changes; the account does not.
    expect(await microsoftUser(identity(['alisa.new@acumen-strategy.com'], 'oid-alisa'))).toMatchObject({ id: alisa.id, joined: false });
  });

  it('matches a team member by one of their aliases, and keeps their title', async () => {
    await prisma.user.update({ where: { id: b.users.karson.id }, data: { aliases: ['karson@acumen-strategy.com'] } });
    expect(await microsoftUser(identity(['karson@acumen-strategy.com'], 'oid-karson'))).toMatchObject({ id: b.users.karson.id, joined: false });
    const karson = await prisma.user.findUniqueOrThrow({ where: { id: b.users.karson.id } });
    expect(karson.role).toBe(b.users.karson.role);
    expect(karson.roleAssigned).toBe(true);
  });

  it('lets someone new at one of our domains join as a Junior FO with no title', async () => {
    for (const address of ['new.person@acumen-strategy.com', 'arjun@acumen-talent.com']) {
      const joined = await microsoftUser(identity([address], `oid-${address}`, 'New Person'));
      expect(joined.joined).toBe(true);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: joined.id } });
      expect(user).toMatchObject({ email: address, name: 'New Person', role: 'JUNIOR_FO', roleAssigned: false, active: true, microsoftId: `oid-${address}` });
      expect(await prisma.auditLog.count({ where: { entityType: 'user', entityId: user.id, action: 'joined' } })).toBe(1);
    }
  });

  it('keeps out an address outside our domains, and someone an admin removed', async () => {
    expect(await refusal(microsoftUser(identity(['someone@gmail.com'], 'oid-outsider')))).toBe('outsider');
    expect(await prisma.user.count({ where: { email: 'someone@gmail.com' } })).toBe(0);
    const leigh = b.users.leigh;
    await prisma.user.update({ where: { id: leigh.id }, data: { active: false } });
    await prisma.auditLog.create({ data: { entityType: 'user', entityId: leigh.id, action: 'removed', actorType: 'USER' } });
    expect(await refusal(microsoftUser(identity([leigh.email], 'oid-leigh')))).toBe('removed');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: leigh.id } })).active).toBe(false);
  });

  it('lets in someone the CRM sync found who never had access, untitled', async () => {
    const found = await prisma.user.create({ data: { email: 'found@acumen-strategy.com', name: 'Found Member', role: 'JUNIOR_FO', active: false, passwordHash: 'x', twentyMemberId: 'member-found' } });
    expect(await microsoftUser(identity(['found@acumen-strategy.com'], 'oid-found'))).toMatchObject({ id: found.id, joined: true });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: found.id } })).toMatchObject({ active: true, role: 'JUNIOR_FO', roleAssigned: false, twentyMemberId: 'member-found' });
  });
});

describe('which ways in the login page offers', () => {
  beforeEach(async () => { await resetDb(); await seedBasics(); invalidateSettingsCache(); });

  it('passwords alone until Microsoft is set up, both until Microsoft has worked once, then Microsoft alone', async () => {
    expect(await signInMethods()).toEqual({ microsoft: false, password: true });
    const { signIn } = await getSettings();
    await saveSettingsSection('signIn', { ...signIn, microsoftClientId: app.clientId, microsoftTenantId: app.tenantId, microsoftClientSecret: 'secret-value' });
    expect(await signInMethods()).toEqual({ microsoft: true, password: true });
    await retirePasswords();
    expect(await signInMethods()).toEqual({ microsoft: true, password: false });
  });
});

describe('our own domains', () => {
  it('include acumen-talent.com', async () => {
    await resetDb(); invalidateSettingsCache();
    expect(isExternalEmail('arjun@acumen-talent.com', (await getSettings()).rules.internalDomains)).toBe(false);
  });
});

describe('tags Twenty lacks', () => {
  let b: Basics;
  const mock = getMockTwentyClient();
  beforeEach(async () => { await resetDb(); b = await seedBasics(); mock.reset(); mock.writes = []; });

  it('are listed when Cadence cannot add them, and come off the list once set', async () => {
    const meeting = await prisma.meeting.create({ data: { title: 'Intro', sourceUrl: '', occurredAt: new Date('2027-03-04T17:00:00Z'), bookedById: b.users.karson.id, products: [], review: 'APPROVED' } });
    const refuse = vi.spyOn(mock, 'addSelectOption').mockResolvedValue(null as unknown as string);
    await syncMeetingToCrm(meeting.id);
    expect(await missingMeetingTags()).toEqual([{ field: 'Booked by', name: b.users.karson.name }]);
    refuse.mockRestore();
    await syncMeetingToCrm(meeting.id);
    expect(await missingMeetingTags()).toEqual([]);
  });
});
