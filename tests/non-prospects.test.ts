import { beforeEach, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { listAccounts } from '@/lib/accounts-query';
import { enrichmentQueue } from '@/lib/enrichment-work';
import { applyNeverProspectRule, exceptFromNeverProspectRule, isNeverProspect, isNotAccount, notAccountCompanyIds } from '@/lib/non-prospects';
import { unblockAccount } from '@/lib/blocked-accounts';
import { peopleScopeWhere } from '@/lib/people-scope';
import { getSettings } from '@/lib/settings';
import { userActor } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/current-user';
import { resetDb, seedBasics, type Basics } from './helpers/db';

let b: Basics;
const session = (user: Basics['users']['ria']): SessionUser => ({ ...user, pods: [], podIds: [] });

beforeEach(async () => {
  await resetDb();
  b = await seedBasics();
  await prisma.companyCache.createMany({ data: [
    { id: 'co-msft', name: 'Microsoft', sortName: 'microsoft', domain: 'microsoft.com' },
    { id: 'co-msft-sub', name: 'Some Team', sortName: 'some team', domain: 'teams.microsoft.com' },
    { id: 'co-gmail', name: 'gmail.com', sortName: 'gmail.com', domain: 'gmail.com' },
    { id: 'co-real', name: 'Real Capital', sortName: 'real capital', domain: 'realcapital.example' },
    { id: 'co-microsoftish', name: 'Microsoft Street Advisors', sortName: 'microsoft street advisors', domain: 'msadvisors.example' },
  ] });
  await prisma.personCache.createMany({ data: [
    { id: 'p-msft', firstName: 'Satya', lastName: 'Vendor', companyId: 'co-msft', companyName: 'Microsoft', podOwner: 'ALISA', ownerMemberId: 'wm-alisa' },
    { id: 'p-gmail', firstName: 'Gina', lastName: 'Personal', email: 'gina@gmail.com', companyId: 'co-gmail', companyName: 'gmail.com', podOwner: 'ALISA', ownerMemberId: 'wm-alisa' },
    { id: 'p-real', firstName: 'Rae', lastName: 'Prospect', companyId: 'co-real', companyName: 'Real Capital', podOwner: 'ALISA', ownerMemberId: 'wm-alisa' },
  ] });
});

it('recognises vendors by domain, subdomain or exact name, and never a look-alike', async () => {
  const { rules } = await getSettings();
  expect(isNeverProspect({ id: 'a', name: 'Anything', domain: 'microsoft.com' }, rules)).toBe(true);
  expect(isNeverProspect({ id: 'b', name: 'Some Team', domain: 'https://teams.microsoft.com/x' }, rules)).toBe(true);
  expect(isNeverProspect({ id: 'c', name: 'OpenAI', domain: null }, rules)).toBe(true);
  expect(isNeverProspect({ id: 'd', name: 'Microsoft Street Advisors', domain: 'msadvisors.example' }, rules)).toBe(false);
  expect(isNeverProspect({ id: 'e', name: 'Real Capital', domain: 'realcapital.example' }, rules)).toBe(false);
  expect(isNotAccount({ name: 'gmail.com', domain: 'gmail.com' }, rules)).toBe(true);
  expect(isNotAccount({ name: 'Real Capital', domain: 'realcapital.example' }, rules)).toBe(false);
});

it('blocks vendors with their people, and hides free-mail companies while keeping their people', async () => {
  const admin = session(b.users.ria);
  const applied = await applyNeverProspectRule();
  expect(applied.blocked.sort()).toEqual(['co-msft', 'co-msft-sub']);
  expect((await applyNeverProspectRule()).blocked).toEqual([]);

  const accounts = (await listAccounts(admin, {})).rows.map((r) => r.id);
  for (const gone of ['co-msft', 'co-msft-sub', 'co-gmail']) expect(accounts).not.toContain(gone);
  expect(accounts).toEqual(expect.arrayContaining(['co-real', 'co-microsoftish']));

  const people = (await prisma.personCache.findMany({ where: await peopleScopeWhere(admin), select: { id: true } })).map((p) => p.id);
  expect(people).not.toContain('p-msft');
  expect(people).toEqual(expect.arrayContaining(['p-gmail', 'p-real']));

  const queue = (await enrichmentQueue(admin)).map((item) => item.id);
  for (const gone of ['co-msft', 'co-gmail']) expect(queue).not.toContain(gone);
  expect(await notAccountCompanyIds()).toEqual(['co-gmail']);
});

it('an admin unblocking a rule-blocked account excepts it from the rule', async () => {
  await applyNeverProspectRule();
  const result = await unblockAccount('co-msft', { actor: userActor(b.users.ria) });
  expect(result).toMatchObject({ ok: true, reason: 'Known non-prospect' });
  await exceptFromNeverProspectRule('co-msft');
  expect((await applyNeverProspectRule()).blocked).toEqual([]);
  expect(await prisma.blockedAccount.count({ where: { companyId: 'co-msft' } })).toBe(0);
  const { rules } = await getSettings();
  expect(rules.neverProspectExceptions).toContain('co-msft');
});
