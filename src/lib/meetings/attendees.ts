import { prisma } from '../db';
import { getSettings, isExternalEmail } from '../settings';

export type AttendeeSelection = { personId?: string | null; userId?: string | null; name: string | null; email: string | null };

/** Match attendees to Twenty people and Cadence users, and mark who is external. */
export async function resolveAttendees(entries: AttendeeSelection[], hostUserId: string | null) {
  const settings = await getSettings();
  const emails = entries.map((e) => e.email).filter((e): e is string => Boolean(e));
  const [people, users] = await Promise.all([
    prisma.personCache.findMany({ where: { deletedAt: null, OR: [{ id: { in: entries.flatMap((e) => e.personId ? [e.personId] : []) } }, { email: { in: emails, mode: 'insensitive' } }] }, select: { id: true, email: true, firstName: true, lastName: true } }),
    // A colleague's mailbox address is often not their Cadence login, so aliases count too.
    prisma.user.findMany({ where: { OR: [{ id: { in: entries.flatMap((e) => e.userId ? [e.userId] : []) } }, { email: { in: emails, mode: 'insensitive' } }, { aliases: { hasSome: emails } }] }, select: { id: true, email: true, name: true, aliases: true } }),
  ]);
  const personByEmail = new Map(people.map((p) => [p.email?.toLowerCase(), p]));
  const userByEmail = new Map<string, { id: string; name: string }>();
  for (const u of users) {
    for (const key of [u.email, ...u.aliases]) {
      const k = key.toLowerCase();
      if (k.includes('@') && !userByEmail.has(k)) userByEmail.set(k, { id: u.id, name: u.name });
    }
  }
  const seen = new Set<string>();
  return entries.map((e) => {
    const key = e.email?.toLowerCase();
    const person = e.personId ? people.find((p) => p.id === e.personId) : key ? personByEmail.get(key) : undefined;
    const user = e.userId ? users.find((u) => u.id === e.userId) : key ? userByEmail.get(key) : undefined;
    if (e.personId && !person) throw new Error('A selected contact no longer exists. Remove them and try again.');
    if (e.userId && !user) throw new Error('A selected team member no longer exists. Remove them and try again.');
    const canonicalUser = user ? users.find((u) => u.id === user.id) : undefined;
    const email = canonicalUser ? canonicalUser.email : person ? person.email : e.email?.toLowerCase() ?? null;
    return {
      name: user?.name ?? (person ? `${person.firstName} ${person.lastName}`.trim() : e.name),
      email,
      personId: person?.id ?? null,
      userId: user?.id ?? null,
      // The domain decides. A colleague is also a person in Twenty (the mailbox sync makes them
      // one), so "known to the CRM" cannot mean external: Alisa was marked external on her own call.
      external: user ? false : email ? isExternalEmail(email, settings.rules.internalDomains) : Boolean(person),
      host: Boolean(user && user.id === hostUserId),
    };
  }).filter((entry) => {
    const keys = [entry.userId ? `user:${entry.userId}` : null, entry.personId ? `person:${entry.personId}` : null, entry.email ? `email:${entry.email.toLowerCase()}` : null].filter((key): key is string => Boolean(key));
    if (!keys.length) keys.push(`name:${entry.name?.toLowerCase()}`);
    if (keys.some((key) => seen.has(key))) return false;
    keys.forEach((key) => seen.add(key));
    return true;
  });
}

