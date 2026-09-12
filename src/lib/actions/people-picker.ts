'use server';

import { needsPod } from '@/lib/auth/rbac';

import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { requireUser } from '../auth/current-user';
import { canEnroll, visiblePodIds } from '../auth/rbac';
import { peopleScopeWhere } from '../people-scope';
import { personSearchWhere } from '../search-terms';
import { cachedPersonName } from '../person-cache';
import { defaultTwentySchema } from '../twenty/twenty-schema';

/**
 * The directory, filtered, for adding people to a campaign. The same scope as People, the same
 * filters, and "never enrolled" on by default because that is who a campaign is usually for.
 */
const Filters = z.object({
  q: z.string().trim().max(200).default(''),
  pod: z.string().trim().max(100).default(''),
  fo: z.string().trim().max(100).default(''),
  product: z.string().trim().max(100).default(''),
  tier: z.string().trim().max(100).default(''),
  type: z.string().trim().max(100).default(''),
  state: z.enum(['any', 'cold', 'enrolled', 'finished']).default('cold'),
  page: z.number().int().min(1).max(100000).default(1),
});
export type PickerFilters = z.infer<typeof Filters>;
export type PickerRow = { id: string; name: string; company: string | null; title: string | null; pod: string | null; state: 'In a sequence' | 'Replied' | 'Finished' | 'Never enrolled' | 'Do not contact' };

const LIMIT = 300;
const MAX_IDS = 5000;

export async function pickPeopleAction(input: unknown): Promise<{ ok: true; rows: PickerRow[]; total: number; ids: string[] } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!canEnroll(user)) return { ok: false, error: 'You cannot create campaigns.' };
  const parsed = Filters.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, error: 'Invalid filters.' };
  const f = parsed.data;
  const values = defaultTwentySchema.personValues;
  const and: Prisma.PersonCacheWhereInput[] = [await peopleScopeWhere(user)];
  const search = personSearchWhere(f.q);
  if (search) and.push(search);
  if (f.pod) and.push({ podOwner: f.pod });
  if (f.fo) and.push({ OR: [{ enrollments: { some: { foUserId: f.fo, status: { in: ['ACTIVE', 'PAUSED'] } } } }, { ownerMemberId: (await prisma.user.findUnique({ where: { id: f.fo }, select: { twentyMemberId: true } }))?.twentyMemberId ?? '__none__' }] });
  if (f.product && (values.productInterest as readonly string[]).includes(f.product)) and.push({ productInterest: { has: f.product } });
  if (f.tier && (values.tier as readonly string[]).includes(f.tier)) and.push({ tier: f.tier });
  if (f.type && (values.contactType as readonly string[]).includes(f.type)) and.push({ contactType: { has: f.type } });
  if (f.state === 'cold') and.push({ enrollments: { none: {} }, dnd: false, optedOut: false });
  if (f.state === 'enrolled') and.push({ enrollments: { some: { status: { in: ['ACTIVE', 'PAUSED'] } } } });
  if (f.state === 'finished') and.push({ enrollments: { some: {} }, NOT: { enrollments: { some: { status: { in: ['ACTIVE', 'PAUSED'] } } } } });
  const where: Prisma.PersonCacheWhereInput = { AND: and };
  const [people, total, ids, pods] = await Promise.all([
    prisma.personCache.findMany({
      where,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: LIMIT,
      skip: (f.page - 1) * LIMIT,
      select: { id: true, firstName: true, lastName: true, companyName: true, jobTitle: true, podOwner: true, dnd: true, optedOut: true, enrollments: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } } },
    }),
    prisma.personCache.count({ where }),
    prisma.personCache.findMany({ where, select: { id: true }, take: MAX_IDS, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }] }),
    prisma.pod.findMany({ select: { podOwnerValue: true, name: true } }),
  ]);
  const podName = new Map(pods.map((p) => [p.podOwnerValue, p.name]));
  const rows: PickerRow[] = people.map((p) => {
    const e = p.enrollments[0];
    const state: PickerRow['state'] = p.dnd || p.optedOut ? 'Do not contact' : !e ? 'Never enrolled' : e.status === 'ACTIVE' || e.status === 'PAUSED' ? 'In a sequence' : e.status === 'REPLIED' || e.status === 'MEETING' ? 'Replied' : 'Finished';
    return { id: p.id, name: cachedPersonName(p), company: p.companyName, title: p.jobTitle, pod: p.podOwner ? podName.get(p.podOwner) ?? p.podOwner : null, state };
  });
  return { ok: true, rows, total, ids: ids.map((r) => r.id) };
}

export type PickerOptions = { pods: { value: string; name: string }[]; fos: { id: string; name: string }[]; tiers: string[]; types: string[]; products: string[] };

export async function pickerOptionsAction(): Promise<PickerOptions> {
  const user = await requireUser();
  const visible = visiblePodIds(user);
  const pods = await prisma.pod.findMany({ where: { archived: false, ...(visible === null ? {} : { id: { in: visible } }) }, orderBy: { name: 'asc' }, include: { users: { include: { user: { select: { id: true, name: true, active: true, role: true } } } } } });
  const fos = [...new Map(pods.flatMap((p) => p.users.filter((u) => u.user.active && needsPod(u.user.role)).map((u) => [u.user.id, { id: u.user.id, name: u.user.name }] as const))).values()].sort((a, b) => a.name.localeCompare(b.name));
  const v = defaultTwentySchema.personValues;
  return { pods: pods.map((p) => ({ value: p.podOwnerValue, name: p.name })), fos, tiers: [...v.tier], types: [...v.contactType], products: [...v.productInterest] };
}
