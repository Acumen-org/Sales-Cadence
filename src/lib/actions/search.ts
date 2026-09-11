'use server';

import { prisma } from '../db';
import { personSearchWhere } from '@/lib/search-terms';
import { peopleScopeWhere } from '@/lib/people-scope';
import { campaignStatusLabel } from '@/lib/campaign-status';
import { requireUser } from '../auth/current-user';
import { cachedPersonName } from '../person-cache';
import { campaignScope } from '../campaigns-query';

export type SearchHit = {
  kind: 'person' | 'campaign' | 'sequence';
  id: string;
  title: string;
  sub: string | null;
  href: string;
};

/** Global search (the magnifier / Ctrl+K in the top bar): people, campaigns, sequences. */
export async function globalSearchAction(query: string): Promise<SearchHit[]> {
  const user = await requireUser();
  const q = query.trim().slice(0, 200);
  if (q.length < 2) return [];
  const like = { contains: q, mode: 'insensitive' as const };
  const [people, campaigns, sequences] = await Promise.all([
    prisma.personCache.findMany({
      where: { AND: [await peopleScopeWhere(user), personSearchWhere(q) ?? {}] },
      orderBy: [{ lastName: 'asc' }],
      take: 6,
    }),
    prisma.campaign.findMany({ where: { AND: [campaignScope(user), { name: like }] }, select: { id: true, name: true, status: true }, orderBy: { name: 'asc' }, take: 3 }),
    prisma.sequence.findMany({ where: { name: like, archived: false }, select: { id: true, name: true }, take: 3 }),
  ]);
  return [
    ...people.map<SearchHit>((p) => ({ kind: 'person', id: p.id, title: cachedPersonName(p), sub: [p.jobTitle, p.companyName].filter(Boolean).join(' · ') || null, href: `/people/${p.id}` })),
    ...campaigns.map<SearchHit>((c) => ({ kind: 'campaign', id: c.id, title: c.name, sub: campaignStatusLabel(c.status), href: `/campaigns/${c.id}` })),
    ...sequences.map<SearchHit>((s) => ({ kind: 'sequence', id: s.id, title: s.name, sub: 'sequence', href: `/sequences/${s.id}` })),
  ];
}
