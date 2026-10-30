import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { externalPeopleWhere } from '../internal-organizations';
import { upsertPersonCache } from '../person-cache';
import { likeSafe, searchTerms } from '../search-terms';
import { getTwentyClient } from '../twenty';
import { ROLE_LABELS } from '../auth/rbac';

/**
 * Finding the prospect a meeting was with (owner, 29 October 2026: "under no circumstances should
 * someone who is in Twenty not show up"). Everyone in Twenty is searched, whatever pod they sit in
 * or account they belong to; only our own team is left out, since they are picked separately.
 *
 * Two places are asked at once. Cadence's copy of Twenty answers instantly and knows every field
 * (company, additional addresses, phone); Twenty itself is asked too, so someone added there a
 * moment ago, or missed by a sync, is found anyway and copied in on the spot. A few letters are
 * enough: the best matches come first (an exact name or address, then names and addresses that
 * start with what was typed, then the rest).
 */

export type ProspectOption = { personId: string; name: string; email: string | null; companyName: string | null; jobTitle: string | null };

type Found = { id: string; firstName: string; lastName: string; email: string | null; additionalEmails: string[]; companyName: string | null; jobTitle: string | null };

const LIVE_TIMEOUT_MS = 3500;
const fullName = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();

/** Lower is better: how closely a person matches what was typed. */
export function matchRank(p: Found, q: string): number {
  const typed = q.trim().toLowerCase();
  const name = fullName(p).toLowerCase();
  const emails = [p.email, ...p.additionalEmails].filter((e): e is string => Boolean(e)).map((e) => e.toLowerCase());
  if (name === typed || emails.includes(typed)) return 0;
  if (name.startsWith(typed) || p.lastName.toLowerCase().startsWith(typed) || emails.some((e) => e.startsWith(typed))) return 1;
  if (name.split(/\s+/).some((w) => w.startsWith(typed)) || searchTerms(typed).every((t) => name.split(/\s+/).some((w) => w.startsWith(t)))) return 2;
  if (p.companyName?.toLowerCase().startsWith(typed)) return 3;
  return 4;
}

const byRank = (q: string) => (a: Found, b: Found) => matchRank(a, q) - matchRank(b, q) || (fullName(a) || a.email || '~').localeCompare(fullName(b) || b.email || '~');

/** The best matches in Cadence's copy: every word somewhere, ranked in the database across everyone. */
async function fromCache(q: string, take: number): Promise<string[]> {
  const terms = searchTerms(q);
  if (!terms.length) return [];
  const typed = q.trim().toLowerCase();
  const starts = `${likeSafe(typed)}%`;
  const words = terms.map((term) => {
    const like = `%${likeSafe(term)}%`;
    return Prisma.sql`(p."firstName" || ' ' || p."lastName" ILIKE ${like} OR p."email" ILIKE ${like} OR array_to_string(p."additionalEmails", ' ') ILIKE ${like} OR p."companyName" ILIKE ${like} OR p."jobTitle" ILIKE ${like} OR p."phone" ILIKE ${like})`;
  });
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT p."id" FROM "PersonCache" p
    WHERE p."deletedAt" IS NULL AND ${Prisma.join(words, ' AND ')}
    ORDER BY
      CASE
        WHEN lower(trim(p."firstName" || ' ' || p."lastName")) = ${typed} OR lower(p."email") = ${typed} THEN 0
        WHEN lower(trim(p."firstName" || ' ' || p."lastName")) LIKE ${starts} OR lower(p."lastName") LIKE ${starts} OR lower(p."email") LIKE ${starts} THEN 1
        WHEN lower(p."firstName" || ' ' || p."lastName") LIKE ${`% ${likeSafe(typed)}%`} THEN 2
        WHEN lower(p."companyName") LIKE ${starts} THEN 3
        ELSE 4
      END,
      p."sortName" NULLS LAST
    LIMIT ${take}`;
  return rows.map((r) => r.id);
}

/** Twenty itself, for anyone the copy does not have yet. Quietly nothing when Twenty is slow or away. */
async function fromTwenty(q: string): Promise<string[]> {
  try {
    const client = await getTwentyClient();
    const page = await Promise.race([
      client.listPeople({ search: q, limit: 20 }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LIVE_TIMEOUT_MS)),
    ]);
    if (!page) return [];
    const known = new Set((await prisma.personCache.findMany({ where: { id: { in: page.items.map((p) => p.id) }, deletedAt: null }, select: { id: true } })).map((p) => p.id));
    // Copied in, so the meeting can link them and the next search finds them here.
    for (const person of page.items) if (!known.has(person.id) && !person.deletedAt) await upsertPersonCache(person).catch(() => undefined);
    return page.items.filter((p) => !p.deletedAt).map((p) => p.id);
  } catch {
    return [];
  }
}

export async function findProspects(query: string, limit = 12): Promise<ProspectOption[]> {
  const q = query.trim().slice(0, 120);
  if (!q) return [];
  const [cached, live, notTeam] = await Promise.all([fromCache(q, 60), fromTwenty(q), externalPeopleWhere({ keepBlocked: true })]);
  const ids = [...new Set([...cached, ...live])];
  if (!ids.length) return [];
  const people = await prisma.personCache.findMany({
    where: { AND: [{ id: { in: ids }, deletedAt: null }, notTeam] },
    select: { id: true, firstName: true, lastName: true, email: true, additionalEmails: true, companyName: true, jobTitle: true },
  });
  return people.sort(byRank(q)).slice(0, limit).map((p) => ({ personId: p.id, name: fullName(p) || p.email || 'Unnamed contact', email: p.email, companyName: p.companyName, jobTitle: p.jobTitle }));
}

export type TeamOption = { userId: string; name: string; email: string; title: string | null };

/** Our own people, active ones only: by name, login or any of their mailbox addresses. */
export async function findTeam(query: string): Promise<TeamOption[]> {
  const q = query.trim().slice(0, 120).toLowerCase();
  const users = await prisma.user.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, email: true, aliases: true, role: true, roleAssigned: true } });
  const hits = q ? users.filter((u) => searchTerms(q).every((t) => [u.name, u.email, ...u.aliases].some((v) => v.toLowerCase().includes(t)))) : users;
  const rank = (u: (typeof users)[number]) => (u.name.toLowerCase().startsWith(q) || u.email.toLowerCase().startsWith(q) ? 0 : u.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) ? 1 : 2);
  return hits.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, 30).map((u) => ({ userId: u.id, name: u.name, email: u.email, title: u.roleAssigned ? ROLE_LABELS[u.role] : null }));
}

/** The team members with these ids, as the form shows them, in the order given. */
export async function teamOptions(userIds: string[]): Promise<TeamOption[]> {
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true, role: true, roleAssigned: true } });
  return userIds.flatMap((id) => users.filter((u) => u.id === id)).map((u) => ({ userId: u.id, name: u.name, email: u.email, title: u.roleAssigned ? ROLE_LABELS[u.role] : null }));
}

/** The prospects with these ids, as the form shows them, in the order given. */
export async function prospectOptions(personIds: string[]): Promise<ProspectOption[]> {
  const people = await prisma.personCache.findMany({ where: { id: { in: personIds } }, select: { id: true, firstName: true, lastName: true, email: true, companyName: true, jobTitle: true } });
  return personIds.flatMap((id) => people.filter((p) => p.id === id)).map((p) => ({ personId: p.id, name: fullName(p) || p.email || 'Unnamed contact', email: p.email, companyName: p.companyName, jobTitle: p.jobTitle }));
}
