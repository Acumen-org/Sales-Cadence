'use server';

import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { requireUser } from '../auth/current-user';
import { canEnroll, canManageCampaigns, needsPod, visiblePodIds } from '../auth/rbac';
import { foPeopleWhere, peopleScopeWhere } from '../people-scope';
import { personSearchWhere } from '../search-terms';
import { cachedPersonName } from '../person-cache';
import { campaignAudienceIssues } from '../campaign-audience';
import { valuePriorityGroups } from '../campaign-planner';
import { defaultTwentySchema } from '../twenty/twenty-schema';

/**
 * The directory, filtered, for choosing a campaign's people. The same scope and the same filters
 * as People, ordered the same way (nameless last), and "never enrolled" on by default because
 * that is who a campaign is usually for.
 */
const Filters = z.object({
  campaignPodId: z.string().optional(),
  campaignFoIds: z.array(z.string()).max(100).optional(),
  campaignId: z.string().optional(),
  withinIds: z.array(z.string()).max(10000).optional(),
  q: z.string().trim().max(200).default(''),
  pod: z.string().trim().max(100).default(''),
  fo: z.string().trim().max(100).default(''),
  product: z.string().trim().max(100).default(''),
  tier: z.string().trim().max(100).default(''),
  type: z.string().trim().max(100).default(''),
  tag: z.string().trim().max(100).default(''),
  account: z.string().trim().max(200).default(''),
  state: z.enum(['any', 'cold', 'enrolled', 'finished']).default('cold'),
  /** Planner priority groups (0 Clients ... 5 Unclassified); a contact in any of them matches. */
  priority: z.array(z.number().int().min(0).max(5)).max(6).default([]),
  page: z.number().int().min(1).max(100000).default(1),
});
export type PickerFilters = z.infer<typeof Filters>;
export type PickerRow = { ineligibleReason?: string; id: string; name: string; company: string | null; title: string | null; pod: string | null; tier: string | null; state: 'In a campaign' | 'Replied' | 'Finished' | 'Never in a campaign' | 'Do not contact' };

/** A page of the picker. Not exported: a "use server" module may only export async functions; the response carries it. */
const PICKER_PAGE = 100;

async function campaignContext(f: PickerFilters, user: Awaited<ReturnType<typeof requireUser>>) {
  if (!f.campaignPodId) return undefined;
  if (!canManageCampaigns(user, f.campaignPodId)) throw new Error('You cannot select an audience for this pod.');
  const pod = await prisma.pod.findUniqueOrThrow({ where: { id: f.campaignPodId } });
  const fos = await prisma.user.findMany({ where: { id: { in: f.campaignFoIds ?? [] }, active: true, pods: { some: { podId: pod.id } } }, select: { twentyMemberId: true } });
  // Owners are only checked once the team is chosen; before that nobody would be selectable.
  return { podId: pod.id, podOwnerValue: pod.podOwnerValue, podName: pod.name, ownerMemberIds: fos.flatMap(f => f.twentyMemberId ? [f.twentyMemberId] : []), campaignId: f.campaignId, checkOwners: fos.length > 0 };
}

/** The planner's priority groups as a directory filter, matched on the same normalised CRM labels as `priorityGroups`. */
async function priorityWhere(groups: number[]): Promise<Prisma.PersonCacheWhereInput | null> {
  if (!groups.length) return null;
  const [tags, types, tiers] = await Promise.all([
    prisma.$queryRaw<{ v: string }[]>`SELECT DISTINCT unnest(tags) AS v FROM "PersonCache"`,
    prisma.$queryRaw<{ v: string }[]>`SELECT DISTINCT unnest("contactType") AS v FROM "PersonCache"`,
    prisma.$queryRaw<{ v: string }[]>`SELECT DISTINCT tier AS v FROM "PersonCache" WHERE tier IS NOT NULL`,
  ]);
  const member = (g: number): Prisma.PersonCacheWhereInput[] => {
    const tagValues = tags.map(r => r.v).filter(v => valuePriorityGroups(v, 'tag').includes(g));
    const typeValues = types.map(r => r.v).filter(v => valuePriorityGroups(v, 'contactType').includes(g));
    const tierValues = tiers.map(r => r.v).filter(v => valuePriorityGroups(v, 'tier').includes(g));
    return [
      ...(tagValues.length ? [{ tags: { hasSome: tagValues } }] : []),
      ...(typeValues.length ? [{ contactType: { hasSome: typeValues } }] : []),
      // Written so a missing tier is false rather than unknown inside the Unclassified NOT.
      ...(tierValues.length ? [{ AND: [{ tier: { not: null } }, { tier: { in: tierValues } }] }] : []),
    ];
  };
  const classified = [0, 1, 2, 3, 4].flatMap(member);
  const any = groups.flatMap(g => g === 5 ? [classified.length ? { NOT: { OR: classified } } : {}] : member(g));
  return any.length ? { OR: any } : { id: '__none__' };
}

async function pickerWhere(f: PickerFilters, user: Awaited<ReturnType<typeof requireUser>>): Promise<Prisma.PersonCacheWhereInput> {
  const values = defaultTwentySchema.personValues;
  const and: Prisma.PersonCacheWhereInput[] = [await peopleScopeWhere(user)];
  const context = await campaignContext(f, user);
  if (context) and.push({ OR: [{ podOwner: context.podOwnerValue }, { ownerMemberId: { in: context.ownerMemberIds } }] });
  if (f.withinIds) and.push({ id: { in: f.withinIds } });
  const search = personSearchWhere(f.q);
  if (search) and.push(search);
  if (f.pod) and.push({ podOwner: f.pod });
  if (f.fo) and.push(foPeopleWhere(f.fo, (await prisma.user.findUnique({ where: { id: f.fo }, select: { twentyMemberId: true } }))?.twentyMemberId));
  if (f.product && (values.productInterest as readonly string[]).includes(f.product)) and.push({ productInterest: { has: f.product } });
  if (f.tier && (values.tier as readonly string[]).includes(f.tier)) and.push({ tier: f.tier });
  if (f.type && (values.contactType as readonly string[]).includes(f.type)) and.push({ contactType: { has: f.type } });
  if (f.tag) and.push({ tags: { has: f.tag } });
  const priority = await priorityWhere(f.priority);
  if (priority) and.push(priority);
  if (f.account) and.push({ companyName: { contains: f.account, mode: 'insensitive' } });
  if (f.state === 'cold') and.push({ enrollments: { none: {} }, dnd: false, optedOut: false });
  if (f.state === 'enrolled') and.push({ enrollments: { some: { status: { in: ['ACTIVE', 'PAUSED'] } } } });
  if (f.state === 'finished') and.push({ enrollments: { some: {} }, NOT: { enrollments: { some: { status: { in: ['ACTIVE', 'PAUSED'] } } } } });
  return { AND: and };
}

const ORDER: Prisma.PersonCacheOrderByWithRelationInput[] = [{ sortName: { sort: 'asc', nulls: 'last' } }, { email: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }];

export async function pickPeopleAction(input: unknown): Promise<{ ok: true; rows: PickerRow[]; total: number; page: number; pageSize: number } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!canEnroll(user)) return { ok: false, error: 'You cannot create campaigns.' };
  const parsed = Filters.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, error: 'Invalid filters.' };
  const f = parsed.data;
  const where = await pickerWhere(f, user);
  const [people, total, pods] = await Promise.all([
    prisma.personCache.findMany({
      where,
      orderBy: ORDER,
      take: PICKER_PAGE,
      skip: (f.page - 1) * PICKER_PAGE,
      select: { id: true, firstName: true, lastName: true, companyName: true, jobTitle: true, podOwner: true, tier: true, dnd: true, optedOut: true, enrollments: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } } },
    }),
    prisma.personCache.count({ where }),
    prisma.pod.findMany({ select: { podOwnerValue: true, name: true } }),
  ]);
  const issues = new Map((await campaignAudienceIssues(people.map(p => p.id), await campaignContext(f, user))).map(i => [i.id, i.reason]));
  const podName = new Map(pods.map((p) => [p.podOwnerValue, p.name]));
  const rows: PickerRow[] = people.map((p) => {
    const e = p.enrollments[0];
    const state: PickerRow['state'] = p.dnd || p.optedOut ? 'Do not contact' : !e ? 'Never in a campaign' : e.status === 'ACTIVE' || e.status === 'PAUSED' ? 'In a campaign' : e.status === 'REPLIED' || e.status === 'MEETING' ? 'Replied' : 'Finished';
    return { ineligibleReason: issues.get(p.id), id: p.id, name: cachedPersonName(p), company: p.companyName, title: p.jobTitle, pod: p.podOwner ? podName.get(p.podOwner) ?? p.podOwner : null, tier: p.tier, state };
  });
  return { ok: true, rows, total, page: f.page, pageSize: PICKER_PAGE };
}

/** Every id the current filters match - what "Select all N matching" means, with no ceiling. */
export async function pickAllIdsAction(input: unknown): Promise<{ ok: true; ids: string[]; skipped: number } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!canEnroll(user)) return { ok: false, error: 'You cannot create campaigns.' };
  const parsed = Filters.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, error: 'Invalid filters.' };
  const rows = await prisma.personCache.findMany({ where: await pickerWhere(parsed.data, user), select: { id: true }, orderBy: ORDER });
  const issues = new Set((await campaignAudienceIssues(rows.map(r => r.id), await campaignContext(parsed.data, user))).map(i => i.id));
  return { ok: true, ids: rows.map(r => r.id).filter(id => !issues.has(id)), skipped: issues.size };
}

export type PickerOptions = { pods: { value: string; name: string }[]; fos: { id: string; name: string }[]; tiers: string[]; types: string[]; products: string[]; tags: string[] };

export async function pickerOptionsAction(): Promise<PickerOptions> {
  const user = await requireUser();
  const visible = visiblePodIds(user);
  const [pods, tagRows] = await Promise.all([
    prisma.pod.findMany({ where: { archived: false, ...(visible === null ? {} : { id: { in: visible } }) }, orderBy: { name: 'asc' }, include: { users: { include: { user: { select: { id: true, name: true, active: true, role: true } } } } } }),
    prisma.personCache.findMany({ where: await peopleScopeWhere(user), select: { tags: true }, distinct: ['tags'], take: 500 }),
  ]);
  const fos = [...new Map(pods.flatMap((p) => p.users.filter((u) => u.user.active && needsPod(u.user.role)).map((u) => [u.user.id, { id: u.user.id, name: u.user.name }] as const))).values()].sort((a, b) => a.name.localeCompare(b.name));
  const v = defaultTwentySchema.personValues;
  const known = new Set<string>([...v.tier, ...v.contactType, ...v.productInterest, ...v.listCategory]);
  const tags = [...new Set(tagRows.flatMap((r) => r.tags))].filter((t) => !known.has(t)).sort();
  return { pods: pods.map((p) => ({ value: p.podOwnerValue, name: p.name })), fos, tiers: [...v.tier], types: [...v.contactType], products: [...v.productInterest], tags };
}
