'use server';

import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { personSearchWhere } from '@/lib/search-terms';
import { peopleScopeWhere } from '@/lib/people-scope';
import { campaignStatusLabel } from '@/lib/campaign-status';
import { requireUser } from '../auth/current-user';
import { cachedPersonName } from '../person-cache';
import { campaignScope } from '../campaigns-query';
import { coldRef, subjectHref } from '../subject';
import { searchSql } from '../sandbox/query';
import { coldCues, type Cue } from '../sandbox/cues';
import { displayName } from '../sandbox/normalize';
import { todayIn } from '../dates';

export type SearchHit = {
  kind: 'person' | 'campaign' | 'sequence' | 'cold' | 'cold_campaign';
  id: string;
  title: string;
  sub: string | null;
  href: string;
  /** The chip that says what the hit is: "Person", "Campaign", "Cold contact", "Cold campaign" (B116). */
  chip: string;
  /** A cold contact's status badge, as every Cold outreach screen shows it (PLAN 4.0). */
  badge?: Cue | null;
};

/**
 * Global search (the magnifier / Ctrl+K in the top bar): CRM people and campaigns, and Cold outreach's
 * contacts and campaigns, each marked with what it is (D2, B116). A cold contact is found by name in
 * either order, firm, email or a phone of 7 or more digits, in every status, with its status badge.
 */
export async function globalSearchAction(query: string): Promise<SearchHit[]> {
  const user = await requireUser();
  const q = query.trim().slice(0, 200);
  if (q.length < 2) return [];
  const like = { contains: q, mode: 'insensitive' as const };
  const coldWhere = searchSql(q);
  const [people, campaigns, coldIds, coldCampaigns] = await Promise.all([
    prisma.personCache.findMany({
      where: { AND: [await peopleScopeWhere(user), personSearchWhere(q) ?? {}] },
      orderBy: [{ lastName: 'asc' }],
      take: 6,
    }),
    prisma.campaign.findMany({ where: { AND: [campaignScope(user), { name: like, audience: 'CRM' }] }, select: { id: true, name: true, status: true }, orderBy: { name: 'asc' }, take: 3 }),
    // Every cold contact may be seen by every user (PLAN 8.1); live ones first.
    coldWhere ? prisma.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT c.id FROM "SandboxContact" c WHERE ${coldWhere} ORDER BY (c.status = 'ACTIVE') DESC, c."sortName" ASC NULLS LAST, c.id ASC LIMIT 5`) : Promise.resolve([]),
    prisma.campaign.findMany({ where: { AND: [campaignScope(user), { name: like, audience: 'SANDBOX' }] }, select: { id: true, name: true, status: true }, orderBy: { name: 'asc' }, take: 3 }),
  ]);
  const ids = coldIds.map((r) => r.id);
  const [contacts, cues] = ids.length
    ? await Promise.all([
      prisma.sandboxContact.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, jobTitle: true, companyName: true } }),
      coldCues(ids, { today: todayIn(user.timezone) }),
    ])
    : [[], new Map()];
  const cold = ids.map((id) => contacts.find((c) => c.id === id)).filter((c): c is (typeof contacts)[number] => Boolean(c));
  return [
    ...people.map<SearchHit>((p) => ({ kind: 'person', id: p.id, title: cachedPersonName(p), sub: [p.jobTitle, p.companyName].filter(Boolean).join(' · ') || null, href: `/people/${p.id}`, chip: 'Person' })),
    ...cold.map<SearchHit>((c) => ({ kind: 'cold', id: c.id, title: displayName(c.firstName, c.lastName) || 'Removed contact', sub: [c.jobTitle, c.companyName].filter(Boolean).join(' · ') || null, href: subjectHref(coldRef(c.id)), chip: 'Cold contact', badge: cues.get(c.id)?.badge ?? null })),
    ...campaigns.map<SearchHit>((c) => ({ kind: 'campaign', id: c.id, title: c.name, sub: campaignStatusLabel(c.status), href: `/campaigns/${c.id}`, chip: 'Campaign' })),
    ...coldCampaigns.map<SearchHit>((c) => ({ kind: 'cold_campaign', id: c.id, title: c.name, sub: campaignStatusLabel(c.status), href: `/campaigns/${c.id}`, chip: 'Cold campaign' })),
  ];
}
