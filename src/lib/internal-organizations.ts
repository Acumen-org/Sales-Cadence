import type { Prisma } from '@prisma/client';
import { blockedCompanyIds } from './blocked-accounts';
import { prisma } from './db';
import { getSettings } from './settings';

function hostname(value: string): string | null {
  try { return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase().replace(/\.$/, ''); }
  catch { return null; }
}

/**
 * A firm name as the internal list compares it: any alphabet, no punctuation, spaces or case, and no
 * legal suffix, so "Acumen Strategy LLC" and "Acumen Strategy Group" are both "acumenstrategy" (B170).
 */
const nameKey = (name: string) => name.normalize('NFC').toLowerCase()
  .replace(/(?<![\p{L}\p{N}])(llc|l\.l\.c\.?|inc|incorporated|ltd|limited|group|corp|corporation|co|company|lp|llp|plc|pllc|the)\.?(?![\p{L}\p{N}])/gu, ' ')
  .replace(/[^\p{L}\p{N}]/gu, '');

export function isInternalCompany(company: { name: string; domain: string | null }, rules: { internalDomains: string[]; internalCompanyNames: string[] }): boolean {
  const firm = nameKey(company.name);
  if (firm && rules.internalCompanyNames.some((name) => nameKey(name) === firm)) return true;
  const host = company.domain ? hostname(company.domain) : null;
  return Boolean(host && rules.internalDomains.some((domain) => {
    const own = hostname(domain);
    return own && (host === own || host.endsWith(`.${own}`));
  }));
}

/**
 * Who a prospect directory leaves out: our own team, our own organisations, and the accounts an
 * admin has blocked. Directory exclusions never remove CRM cache records needed to match mailbox
 * activity.
 */
export async function externalPeopleWhere(options: { keepBlocked?: boolean } = {}): Promise<Prisma.PersonCacheWhereInput> {
  const [users, settings, companies, blocked] = await Promise.all([
    prisma.user.findMany({ select: { email: true, aliases: true, twentyMemberId: true } }),
    getSettings(),
    prisma.companyCache.findMany({ select: { id: true, name: true, domain: true } }),
    // A meeting happened whatever an admin thinks of the account since: its prospects stay findable.
    options.keepBlocked ? Promise.resolve([] as string[]) : blockedCompanyIds(),
  ]);
  const emails = [...new Set(users.flatMap((u) => [u.email, ...u.aliases]).filter((email) => email.includes('@')).map((email) => email.trim().toLowerCase()))];
  const excludedIds = [...new Set([...companies.filter((c) => isInternalCompany(c, settings.rules)).map((c) => c.id), ...blocked])];
  return { AND: [
    { OR: [{ email: null }, { AND: [
      ...(emails.length ? [{ email: { notIn: emails, mode: 'insensitive' as const } }] : []),
      ...settings.rules.internalDomains.map((domain) => ({ NOT: { OR: [
        { email: { endsWith: `@${domain}`, mode: 'insensitive' as const } },
        { email: { endsWith: `.${domain}`, mode: 'insensitive' as const } },
      ] } })),
    ] }] },
    ...(excludedIds.length ? [{ OR: [{ companyId: null }, { companyId: { notIn: excludedIds } }] }] : []),
  ] };
}
