'use server';

import { prisma } from '../db';
import { requireUser } from '../auth/current-user';
import { cachedPersonName } from '../person-cache';

export type SearchHit = {
  kind: 'person' | 'campaign' | 'sequence';
  id: string;
  title: string;
  sub: string | null;
  href: string;
};

/** Global search (the magnifier / Ctrl+K in the top bar): people, campaigns, sequences. */
export async function globalSearchAction(query: string): Promise<SearchHit[]> {
  await requireUser();
  const q = query.trim();
  if (q.length < 2) return [];
  const like = { contains: q, mode: 'insensitive' as const };
  const [people, campaigns, sequences] = await Promise.all([
    prisma.personCache.findMany({
      where: { deletedAt: null, OR: [{ firstName: like }, { lastName: like }, { companyName: like }, { email: like }, { jobTitle: like }] },
      orderBy: [{ lastName: 'asc' }],
      take: 6,
    }),
    prisma.campaign.findMany({ where: { name: like }, select: { id: true, name: true, status: true }, take: 3 }),
    prisma.sequence.findMany({ where: { name: like, archived: false }, select: { id: true, name: true }, take: 3 }),
  ]);
  return [
    ...people.map<SearchHit>((p) => ({ kind: 'person', id: p.id, title: cachedPersonName(p), sub: [p.jobTitle, p.companyName].filter(Boolean).join(' · ') || null, href: `/people/${p.id}` })),
    ...campaigns.map<SearchHit>((c) => ({ kind: 'campaign', id: c.id, title: c.name, sub: c.status.toLowerCase(), href: `/campaigns/${c.id}` })),
    ...sequences.map<SearchHit>((s) => ({ kind: 'sequence', id: s.id, title: s.name, sub: 'sequence', href: `/sequences/${s.id}` })),
  ];
}
