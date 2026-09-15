import type { Prisma } from '@prisma/client';
import { blockedCompanyIds } from './blocked-accounts';
import { prisma } from './db';
import { getSettings } from './settings';

function hostname(value: string): string | null {
  try { return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase().replace(/\.$/, ''); }
  catch { return null; }
}

export function isInternalCompany(company: { name: string; domain: string | null }, rules: { internalDomains: string[]; internalCompanyNames: string[] }): boolean {
  const nameKey = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (rules.internalCompanyNames.some((name) => nameKey(name) === nameKey(company.name))) return true;
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
export async function externalPeopleWhere(): Promise<Prisma.PersonCacheWhereInput> {
  const [users, settings, companies, blocked] = await Promise.all([
    prisma.user.findMany({ select: { email: true, aliases: true, twentyMemberId: true } }),
    getSettings(),
    prisma.companyCache.findMany({ select: { id: true, name: true, domain: true } }),
    blockedCompanyIds(),
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
