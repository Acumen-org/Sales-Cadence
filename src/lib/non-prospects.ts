import { prisma } from './db';
import { getSettings, saveSettingsSection } from './settings';
import { blockAccount } from './blocked-accounts';
import { SYSTEM_ACTOR } from './audit';

/**
 * Two kinds of company that are not prospects, decided on 18 September 2026.
 *
 * Never prospects are vendors and platforms - Microsoft, Google, OpenAI - that Twenty holds because
 * someone there once sent an email. They are blocked as accounts, with their people, so they are
 * gone from every prospect surface and no sequence can start there. An admin who unblocks one adds
 * it to the exceptions and the rule leaves it alone from then on.
 *
 * Not accounts are free-mail domains. Twenty makes a company out of every email domain it sees, so
 * "gmail.com" arrives as a firm with thousands of people. The firm is hidden from Accounts and
 * enrichment; its people stay in People with no account, because a prospect writing from a
 * personal address is still a prospect.
 */
export const NEVER_PROSPECT_REASON = 'Known non-prospect';

function hostname(value: string | null | undefined): string | null {
  if (!value) return null;
  try { return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''); }
  catch { return value.toLowerCase().replace(/^www\./, '') || null; }
}

const nameKey = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function domainMatches(host: string | null, domains: string[]): boolean {
  return Boolean(host && domains.some((d) => host === d || host.endsWith(`.${d}`)));
}

export type NonProspectRules = { neverProspectDomains: string[]; neverProspectNames: string[]; notAccountDomains: string[]; neverProspectExceptions: string[] };

export function isNeverProspect(company: { id: string; name: string; domain: string | null }, rules: NonProspectRules): boolean {
  if (rules.neverProspectExceptions.includes(company.id)) return false;
  if (domainMatches(hostname(company.domain), rules.neverProspectDomains)) return true;
  const key = nameKey(company.name);
  return Boolean(key) && rules.neverProspectNames.some((n) => nameKey(n) === key);
}

/** A company made from a personal email domain: not an account, though its people are real. */
export function isNotAccount(company: { name: string; domain: string | null }, rules: Pick<NonProspectRules, 'notAccountDomains'>): boolean {
  const host = hostname(company.domain) ?? hostname(company.name);
  return domainMatches(host, rules.notAccountDomains);
}

/** Ids of every cached company that is not an account, for the surfaces that list accounts. */
export async function notAccountCompanyIds(): Promise<string[]> {
  const { rules } = await getSettings();
  if (!rules.notAccountDomains.length) return [];
  const companies = await prisma.companyCache.findMany({ where: { deletedAt: null }, select: { id: true, name: true, domain: true } });
  return companies.filter((c) => isNotAccount(c, rules)).map((c) => c.id);
}

/**
 * Block every cached company the never-prospect rule matches and nobody has excepted. Runs after
 * each sync pass and once on demand from Settings; idempotent, so the second run blocks nothing.
 */
export async function applyNeverProspectRule(): Promise<{ blocked: string[] }> {
  const { rules } = await getSettings();
  const [companies, already] = await Promise.all([
    prisma.companyCache.findMany({ where: { deletedAt: null }, select: { id: true, name: true, domain: true } }),
    prisma.blockedAccount.findMany({ select: { companyId: true } }),
  ]);
  const done = new Set(already.map((b) => b.companyId));
  const blocked: string[] = [];
  for (const company of companies) {
    if (done.has(company.id) || !isNeverProspect(company, rules)) continue;
    const result = await blockAccount(company.id, { reason: NEVER_PROSPECT_REASON, actor: SYSTEM_ACTOR });
    if (result.ok) blocked.push(company.id);
  }
  return { blocked };
}

/** An admin unblocking a rule-blocked account means "this one is a prospect after all". */
export async function exceptFromNeverProspectRule(companyId: string): Promise<void> {
  const { rules } = await getSettings();
  if (rules.neverProspectExceptions.includes(companyId)) return;
  await saveSettingsSection('rules', { ...rules, neverProspectExceptions: [...rules.neverProspectExceptions, companyId] });
}
