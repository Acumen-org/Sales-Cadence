import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from './db';
import type { TwentyClient } from './twenty/client';
import { paginate } from './twenty/client';
import type { TwentyCompany, TwentyPerson } from './twenty/types';

export function personToCacheData(p: TwentyPerson): Prisma.PersonCacheUncheckedCreateInput {
  return {
    id: p.id,
    firstName: p.firstName ?? '',
    lastName: p.lastName ?? '',
    email: p.email,
    phone: p.phone,
    linkedinUrl: p.linkedinUrl,
    jobTitle: p.jobTitle,
    city: p.city,
    companyId: p.companyId,
    companyName: p.companyName,
    dnd: Boolean(p.dnd),
    podOwner: p.podOwner,
    ownerMemberId: p.ownerMemberId,
    tags: p.tags ?? [],
    eventSource: p.eventSource,
    statusOfMeeting: p.statusOfMeeting,
    raw: (p.raw ?? undefined) as Prisma.InputJsonValue | undefined,
    twentyUpdatedAt: p.updatedAt ? new Date(p.updatedAt) : null,
    deletedAt: p.deletedAt ? new Date(p.deletedAt) : null,
    syncedAt: new Date(),
  };
}

export async function upsertPersonCache(p: TwentyPerson, tx: Tx | typeof prisma = prisma) {
  const data = personToCacheData(p);
  const { id, ...rest } = data;
  return tx.personCache.upsert({ where: { id }, create: data, update: rest });
}

export async function upsertCompanyCache(c: TwentyCompany, tx: Tx | typeof prisma = prisma) {
  return tx.companyCache.upsert({
    where: { id: c.id },
    create: { id: c.id, name: c.name, domain: c.domain, syncedAt: new Date() },
    update: { name: c.name, domain: c.domain, syncedAt: new Date() },
  });
}

export async function markPersonDeleted(personId: string, tx: Tx | typeof prisma = prisma) {
  await tx.personCache.updateMany({ where: { id: personId }, data: { deletedAt: new Date(), syncedAt: new Date() } });
}

/**
 * Pull people (and companies) from Twenty into the cache.
 * `since` limits to records updated at/after that ISO instant; omit for a full refresh.
 */
export async function refreshPersonCache(client: TwentyClient, opts: { since?: string } = {}) {
  let people = 0;
  let companies = 0;
  for await (const person of paginate((after) => client.listPeople({ updatedSince: opts.since, after, limit: 100, includeDeleted: true }))) {
    await upsertPersonCache(person);
    people += 1;
  }
  for await (const company of paginate((after) => client.listCompanies({ updatedSince: opts.since, after, limit: 100 }))) {
    await upsertCompanyCache(company);
    companies += 1;
  }
  return { people, companies };
}

/** Make sure the given person ids are cached, fetching missing ones from Twenty. */
export async function ensurePeopleCached(client: TwentyClient, ids: string[]): Promise<{ found: string[]; missing: string[] }> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return { found: [], missing: [] };
  const cached = await prisma.personCache.findMany({ where: { id: { in: unique } }, select: { id: true } });
  const cachedSet = new Set(cached.map((c) => c.id));
  const toFetch = unique.filter((id) => !cachedSet.has(id));
  const missing: string[] = [];
  for (let i = 0; i < toFetch.length; i += 50) {
    const batch = toFetch.slice(i, i + 50);
    const fetched = await client.getPeopleByIds(batch);
    const fetchedSet = new Set(fetched.map((p) => p.id));
    for (const p of fetched) await upsertPersonCache(p);
    for (const id of batch) if (!fetchedSet.has(id)) missing.push(id);
  }
  const missingSet = new Set(missing);
  return { found: unique.filter((id) => !missingSet.has(id)), missing };
}

export function cachedPersonName(p: { firstName: string; lastName: string }): string {
  return [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || '(no name)';
}
