import { prisma } from '../db';

export type MeetingAccount = { id: string | null; name: string | null };

/**
 * The account a meeting is with (owner, 9 Nov 2026): the one its prospects work at, only when they
 * all work at the same one. A prospect the CRM has no account for does not decide it either way;
 * prospects at different accounts leave the meeting with none.
 */
export function accountOf(people: { companyId: string | null; companyName: string | null }[]): { companyId: string | null; name: string | null } {
  const ids = [...new Set(people.map((p) => p.companyId).filter((id): id is string => Boolean(id)))];
  if (ids.length > 1) return { companyId: null, name: null };
  if (ids.length === 1) return { companyId: ids[0], name: people.find((p) => p.companyId === ids[0])?.companyName ?? null };
  // No prospect has an account in the CRM: the name they give, when they all give the same one.
  const names = new Map<string, string>();
  for (const p of people) {
    const name = p.companyName?.trim();
    if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  const [only] = names.values();
  return { companyId: null, name: names.size === 1 ? only : null };
}

/** The account for a meeting with these prospects, named as the CRM's account record names it. */
export async function meetingCompany(prospectIds: string[]): Promise<MeetingAccount> {
  const people = await prisma.personCache.findMany({ where: { id: { in: prospectIds } }, select: { companyId: true, companyName: true } });
  const found = accountOf(people);
  if (!found.companyId) return { id: null, name: found.name };
  const company = await prisma.companyCache.findFirst({ where: { id: found.companyId, deletedAt: null }, select: { id: true, name: true } });
  return company ? { id: company.id, name: company.name } : { id: null, name: found.name };
}

/**
 * Every meeting's account worked out again from its prospects as they are now, so meetings saved
 * before the rule, or before a prospect's account was known, get one too. Returns the meetings whose
 * account changed, which Twenty then needs to hear about.
 */
export async function refreshMeetingAccounts(): Promise<string[]> {
  const meetings = await prisma.meeting.findMany({ where: { attendees: { some: { prospect: true, personId: { not: null } } } }, select: { id: true, companyId: true, companyName: true, attendees: { where: { prospect: true, personId: { not: null } }, select: { personId: true } } } });
  if (!meetings.length) return [];
  const personIds = [...new Set(meetings.flatMap((m) => m.attendees.map((a) => a.personId!)))];
  const people = new Map((await prisma.personCache.findMany({ where: { id: { in: personIds } }, select: { id: true, companyId: true, companyName: true } })).map((p) => [p.id, p]));
  const companyIds = [...new Set([...people.values()].flatMap((p) => (p.companyId ? [p.companyId] : [])))];
  const companies = new Map((await prisma.companyCache.findMany({ where: { id: { in: companyIds }, deletedAt: null }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const changed: string[] = [];
  for (const m of meetings) {
    const found = accountOf(m.attendees.flatMap((a) => (people.has(a.personId!) ? [people.get(a.personId!)!] : [])));
    const live = found.companyId && companies.has(found.companyId) ? found.companyId : null;
    const next = { companyId: live, companyName: live ? companies.get(live)! : found.name };
    if (next.companyId === m.companyId && next.companyName === m.companyName) continue;
    await prisma.meeting.update({ where: { id: m.id }, data: next });
    changed.push(m.id);
  }
  return changed;
}
