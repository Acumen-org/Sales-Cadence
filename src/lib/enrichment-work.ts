import type { CompanyCache, PersonCache, Prisma } from '@prisma/client';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { assertAllowed, canSeeAllPods, isAdmin } from './auth/rbac';
import { cachedPersonName } from './person-cache';
import { getSettings, getTwentyConnection, getTwentySchema } from './settings';
import { blockedCompanyIds } from './blocked-accounts';
import { externalPeopleWhere, isInternalCompany } from './internal-organizations';
import { isNotAccount } from './non-prospects';
import { podPeopleWhere } from './people-scope';
import { liveCampaignMemberIds } from './campaign-membership';
import { sortDirection } from './sorting';
import { twentyCompanyUrl, twentyPersonUrl } from './twenty/urls';
import { addDays, todayIn } from './dates';
import { workspaceTimezone } from './workspace';
import { canEnrich, enrichmentCompanyScope, enrichmentPeopleScope, normalizedHeader, type EnrichmentEntity } from './enrichment';

/**
 * Data quality as work. One definition of "missing" feeds three things: the queue (who needs
 * what), the scorecard (how complete each field is, by pod and by FO, against a nightly snapshot)
 * and the marks people leave on a gap - "X is researching this" or "not found". A mark lives only
 * while the field is still empty: the moment Twenty carries a value the gap is gone and the mark
 * goes with it, so a field that empties again comes straight back into the queue.
 *
 * **Critical** is what stops the work: without it you cannot reach the person, or you cannot tell
 * who they are. **Useful** is what makes the work better rather than possible.
 */
type PersonRecord = Pick<PersonCache, 'firstName' | 'lastName' | 'email' | 'phone' | 'badEmail' | 'badPhone' | 'emailMissing' | 'phoneMissing' | 'companyId' | 'linkedinUrl' | 'jobTitle' | 'tags'>;
type CompanyRecord = Pick<CompanyCache, 'domain' | 'linkedinUrl' | 'city' | 'employees' | 'aum' | 'ownerMemberId'> & { raw?: Prisma.JsonValue | null };
type GapContext = { enrichmentTags: Set<string>; addressField?: string };
export type GapSpec<R> = {
  field: string;
  label: string;
  priority: 'critical' | 'useful';
  /** A relation or an assignment, which an import cannot write - somebody links it in Twenty. */
  fixInTwenty?: boolean;
  /** Counted on the scorecard. Flags and name checks are not a field's completeness. */
  scorecard?: boolean;
  /** The gap's label when the record lacks it, or null when it is filled. */
  missing: (record: R, ctx: GapContext) => string | null;
};

const blank = (value: unknown) => value === null || value === undefined || value === '';
export const PERSON_GAPS: GapSpec<PersonRecord>[] = [
  { field: 'name', label: 'Name', priority: 'critical', fixInTwenty: true, missing: (p) => (!p.firstName?.trim() || !p.lastName?.trim() ? 'Name incomplete' : null) },
  { field: 'email', label: 'Email', priority: 'critical', scorecard: true, missing: (p) => (!p.email ? 'Email missing' : p.badEmail || p.emailMissing ? 'Email needs verification' : null) },
  { field: 'phone', label: 'Phone', priority: 'critical', scorecard: true, missing: (p) => (!p.phone ? 'Phone missing' : p.badPhone || p.phoneMissing ? 'Phone needs verification' : null) },
  { field: 'companyId', label: 'Company', priority: 'critical', fixInTwenty: true, scorecard: true, missing: (p) => (p.companyId ? null : 'Company not linked') },
  { field: 'linkedinUrl', label: 'LinkedIn', priority: 'critical', scorecard: true, missing: (p) => (p.linkedinUrl ? null : 'LinkedIn missing') },
  { field: 'jobTitle', label: 'Job title', priority: 'useful', scorecard: true, missing: (p) => (p.jobTitle ? null : 'Job title missing') },
  { field: 'tags', label: 'Flagged in CRM', priority: 'critical', missing: (p, ctx) => (p.tags.some((tag) => ctx.enrichmentTags.has(tag) || /enrichment[\s_-]*(required|needed)/i.test(tag)) ? 'Flagged in CRM' : null) },
];
export const COMPANY_GAPS: GapSpec<CompanyRecord>[] = [
  { field: 'domain', label: 'Website', priority: 'critical', scorecard: true, missing: (c) => (blank(c.domain) ? 'Website missing' : null) },
  { field: 'linkedinUrl', label: 'LinkedIn', priority: 'critical', scorecard: true, missing: (c) => (blank(c.linkedinUrl) ? 'LinkedIn missing' : null) },
  { field: 'address', label: 'Address', priority: 'useful', fixInTwenty: true, scorecard: true, missing: (c, ctx) => {
    const raw = c.raw && typeof c.raw === 'object' && !Array.isArray(c.raw) ? c.raw : {};
    const value = raw[ctx.addressField ?? 'address'];
    const address = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const street = String(address.addressStreet1 ?? address.addressStreet2 ?? '').trim();
    return street ? null : 'Street address missing';
  } },
  { field: 'employees', label: 'Employees', priority: 'useful', scorecard: true, missing: (c) => (blank(c.employees) ? 'Employees missing' : null) },
  { field: 'aum', label: 'AUM', priority: 'useful', scorecard: true, missing: (c) => (blank(c.aum) ? 'AUM missing' : null) },
  { field: 'ownerMemberId', label: 'Account owner', priority: 'useful', fixInTwenty: true, scorecard: true, missing: (c) => (blank(c.ownerMemberId) ? 'Account owner not assigned' : null) },
];
export const gapSpecs = (entity: EnrichmentEntity) => (entity === 'person' ? PERSON_GAPS : COMPANY_GAPS) as GapSpec<PersonRecord | CompanyRecord>[];

export type MarkKind = 'assigned' | 'not_found';
export type EnrichmentMarkInfo = { kind: MarkKind; assigneeId: string | null; assigneeName: string | null; byName: string | null; at: Date };
export type EnrichmentGap = {
  field: string;
  label: string;
  priority: 'critical' | 'useful';
  fixInTwenty?: boolean;
  /** Who is researching it. A "not found" mark moves the gap to `hidden` instead. */
  mark?: EnrichmentMarkInfo | null;
  /** A fact from the cache that would close the gap: the account whose domain the email carries. */
  suggestion?: { id: string; name: string } | null;
};
export type EnrichmentQueueItem = {
  id: string;
  label: string;
  company: string | null;
  companyId: string | null;
  entity: EnrichmentEntity;
  href: string;
  twentyUrl: string | null;
  owner: string | null;
  ownerMemberIds: string[];
  podOwners: string[];
  tier: string | null;
  contactType: string[];
  productInterest: string[];
  tags: string[];
  inCampaign: boolean;
  syncedAt: Date;
  /** Open gaps. */
  gaps: EnrichmentGap[];
  /** Gaps somebody marked not found; still missing, out of the queue until Twenty fills or the mark is lifted. */
  hidden: EnrichmentGap[];
};

const markKey = (entity: string, recordId: string, field: string) => `${entity}:${recordId}:${field}`;

/** The email's host, when it is one the workspace treats as a company rather than a free mailbox. */
function emailHost(email: string | null): string | null {
  const host = email?.split('@')[1]?.trim().toLowerCase();
  return host || null;
}

export async function enrichmentQueue(user: SessionUser, includeComplete = false): Promise<EnrichmentQueueItem[]> {
  const [{ rules }, blocked, schema, connection, members, marks, inCampaign] = await Promise.all([
    getSettings(),
    blockedCompanyIds(),
    getTwentySchema(),
    getTwentyConnection(),
    prisma.user.findMany({ where: { twentyMemberId: { not: null } }, select: { twentyMemberId: true, name: true } }),
    prisma.enrichmentMark.findMany({ include: { assignee: { select: { name: true } } } }),
    liveCampaignMemberIds(),
  ]);
  const [people, companies, allCompanies] = await Promise.all([
    prisma.personCache.findMany({ where: await enrichmentPeopleScope(user), select: { id: true, firstName: true, lastName: true, companyId: true, companyName: true, email: true, phone: true, jobTitle: true, linkedinUrl: true, city: true, tags: true, badEmail: true, badPhone: true, emailMissing: true, phoneMissing: true, ownerMemberId: true, podOwner: true, tier: true, contactType: true, productInterest: true, syncedAt: true }, orderBy: [{ sortName: { sort: 'asc', nulls: 'last' } }, { email: { sort: 'asc', nulls: 'last' } }] }),
    prisma.companyCache.findMany({ where: await enrichmentCompanyScope(user), select: { id: true, name: true, domain: true, industry: true, employees: true, city: true, raw: true, aum: true, linkedinUrl: true, ownerMemberId: true, syncedAt: true }, orderBy: [{ sortName: { sort: 'asc', nulls: 'last' } }, { domain: { sort: 'asc', nulls: 'last' } }] }),
    prisma.companyCache.findMany({ where: { deletedAt: null, domain: { not: null } }, select: { id: true, name: true, domain: true } }),
  ]);
  const byUsers = marks.some((m) => m.byId) ? await prisma.user.findMany({ where: { id: { in: [...new Set(marks.map((m) => m.byId).filter((id): id is string => !!id))] } }, select: { id: true, name: true } }) : [];
  const byIds = new Map(byUsers.map((u) => [u.id, u.name]));
  const memberName = new Map(members.map((m) => [m.twentyMemberId!, m.name]));
  const markBy = new Map(marks.map((m) => [markKey(m.entity, m.recordId, m.field), m]));
  const ctx: GapContext = { enrichmentTags: new Set(schema.personValues.needsEnrichmentTags), addressField: schema.company.address };
  const blockedIds = new Set(blocked);
  const domainToCompany = new Map<string, { id: string; name: string }>();
  for (const c of allCompanies) {
    if (!c.domain || isNotAccount(c, rules) || isInternalCompany(c, rules) || blockedIds.has(c.id)) continue;
    const host = c.domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    if (host && !domainToCompany.has(host)) domainToCompany.set(host, { id: c.id, name: c.name });
  }
  const stale: string[] = [];
  const marksOn = new Map<string, typeof marks>();
  for (const m of marks) { const key = `${m.entity}:${m.recordId}`; (marksOn.get(key) ?? marksOn.set(key, []).get(key)!).push(m); }
  /** Marks on fields the record now carries are history - checked for every record in scope, gaps or not. */
  const prune = (entity: EnrichmentEntity, id: string, open: Set<string>) => { for (const m of marksOn.get(`${entity}:${id}`) ?? []) if (!open.has(m.field)) stale.push(m.id); };
  const build = (entity: EnrichmentEntity, id: string, raw: { field: string; label: string; priority: 'critical' | 'useful'; fixInTwenty?: boolean; suggestion?: { id: string; name: string } | null }[]) => {
    const gaps: EnrichmentGap[] = [];
    const hidden: EnrichmentGap[] = [];
    for (const g of raw) {
      const m = markBy.get(markKey(entity, id, g.field));
      const mark: EnrichmentMarkInfo | null = m ? { kind: m.kind as MarkKind, assigneeId: m.assigneeId, assigneeName: m.assignee?.name ?? null, byName: m.byId ? byIds.get(m.byId) ?? null : null, at: m.createdAt } : null;
      if (mark?.kind === 'not_found') hidden.push({ ...g, mark });
      else gaps.push({ ...g, mark });
    }
    return { gaps, hidden };
  };

  const items: EnrichmentQueueItem[] = [];
  const companyPods = new Map<string, Set<string>>();
  const companyMembers = new Map<string, Set<string>>();
  for (const person of people) {
    if (person.companyId) {
      if (person.podOwner) (companyPods.get(person.companyId) ?? companyPods.set(person.companyId, new Set()).get(person.companyId)!).add(person.podOwner);
      if (person.ownerMemberId) (companyMembers.get(person.companyId) ?? companyMembers.set(person.companyId, new Set()).get(person.companyId)!).add(person.ownerMemberId);
    }
    const raw = PERSON_GAPS.flatMap((spec) => {
      const label = spec.missing(person, ctx);
      if (!label) return [];
      const host = spec.field === 'companyId' ? emailHost(person.email) : null;
      const suggestion = host ? domainToCompany.get(host) ?? null : null;
      return [{ field: spec.field, label, priority: spec.priority, fixInTwenty: spec.fixInTwenty, suggestion }];
    });
    prune('person', person.id, new Set(raw.map((g) => g.field)));
    if (!raw.length && !includeComplete) continue;
    const { gaps, hidden } = build('person', person.id, raw);
    items.push({ id: person.id, label: cachedPersonName(person), company: person.companyName, companyId: person.companyId, entity: 'person', href: `/people/${person.id}`, twentyUrl: twentyPersonUrl(connection.baseUrl, person.id), owner: person.ownerMemberId ? memberName.get(person.ownerMemberId) ?? null : null, ownerMemberIds: person.ownerMemberId ? [person.ownerMemberId] : [], podOwners: person.podOwner ? [person.podOwner] : [], tier: person.tier, contactType: person.contactType, productInterest: person.productInterest, tags: person.tags, inCampaign: inCampaign.has(person.id), syncedAt: person.syncedAt, gaps, hidden });
  }
  for (const company of companies) {
    if (isInternalCompany(company, rules) || blockedIds.has(company.id) || isNotAccount(company, rules)) continue;
    const raw = COMPANY_GAPS.flatMap((spec) => { const label = spec.missing(company, ctx); return label ? [{ field: spec.field, label, priority: spec.priority, fixInTwenty: spec.fixInTwenty }] : []; });
    prune('company', company.id, new Set(raw.map((g) => g.field)));
    if (!raw.length && !includeComplete) continue;
    const { gaps, hidden } = build('company', company.id, raw);
    const memberIds = new Set(companyMembers.get(company.id) ?? []);
    if (company.ownerMemberId) memberIds.add(company.ownerMemberId);
    items.push({ id: company.id, label: company.name, company: null, companyId: company.id, entity: 'company', href: `/accounts/${company.id}`, twentyUrl: twentyCompanyUrl(connection.baseUrl, company.id), owner: company.ownerMemberId ? memberName.get(company.ownerMemberId) ?? null : null, ownerMemberIds: [...memberIds], podOwners: [...(companyPods.get(company.id) ?? [])], tier: null, contactType: [], productInterest: [], tags: [], inCampaign: false, syncedAt: company.syncedAt, gaps, hidden });
  }
  // A mark on a field Twenty has since filled is history: drop it so the gap reopens if the field empties again.
  if (stale.length) await prisma.enrichmentMark.deleteMany({ where: { id: { in: stale } } });
  return items.sort((a, b) => Number(b.gaps.some((gap) => gap.priority === 'critical')) - Number(a.gaps.some((gap) => gap.priority === 'critical')) || a.label.localeCompare(b.label));
}

export type EnrichmentFilters = {
  q?: string;
  includeComplete?: boolean;
  /** Kinds of missing information; a record shows when it lacks any of them. */
  fields?: string[];
  /** A pod's Twenty value. */
  pod?: string;
  /** An FO's Twenty member id. */
  fo?: string;
  tier?: string;
  type?: string;
  product?: string;
  /** A company id: the account and its people. */
  account?: string;
  priority?: 'critical' | 'useful' | '';
  campaign?: 'any' | 'none' | '';
  tag?: string;
  sort?: string;
  dir?: string;
  /** Show the gaps marked not found instead of the open ones. */
  notFound?: boolean;
};
export const ENRICHMENT_SORTS = ['name', 'company', 'gaps', 'synced'] as const;
export const defaultEnrichmentDirection = (sort: string) => (sort === 'gaps' || sort === 'synced' ? 'desc' : 'asc');

/** Every filter narrows; the result carries the gaps the view is about (open, or marked not found). */
export function filterEnrichmentQueue(items: EnrichmentQueueItem[], f: EnrichmentFilters = {}): EnrichmentQueueItem[] {
  const terms = (f.q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const fields = f.fields ?? [];
  const view = (item: EnrichmentQueueItem) => (f.notFound ? item.hidden : item.gaps);
  const kept = items.flatMap((item) => {
    const gaps = view(item);
    if (!gaps.length && !f.includeComplete) return [];
    if (terms.length && !terms.every((term) => `${item.label} ${item.company ?? ''}`.toLowerCase().includes(term))) return [];
    if (fields.length && !gaps.some((gap) => fields.includes(gap.field))) return [];
    if (f.pod && !item.podOwners.includes(f.pod)) return [];
    if (f.fo && !item.ownerMemberIds.includes(f.fo)) return [];
    if (f.tier && item.tier !== f.tier) return [];
    if (f.type && !item.contactType.includes(f.type)) return [];
    if (f.product && !item.productInterest.includes(f.product)) return [];
    if (f.account && item.companyId !== f.account) return [];
    if (f.tag && !item.tags.includes(f.tag)) return [];
    const critical = gaps.some((gap) => gap.priority === 'critical');
    if (f.priority === 'critical' && !critical) return [];
    if (f.priority === 'useful' && critical) return [];
    if (f.campaign === 'any' && !item.inCampaign) return [];
    if (f.campaign === 'none' && item.inCampaign) return [];
    return [{ ...item, gaps }];
  });
  const sort = f.sort ?? 'name';
  const sign = sortDirection(f.dir, defaultEnrichmentDirection(sort)) === 'desc' ? -1 : 1;
  const compare = (a: EnrichmentQueueItem, b: EnrichmentQueueItem) => {
    if (sort === 'gaps') return a.gaps.length - b.gaps.length || a.label.localeCompare(b.label);
    if (sort === 'company') return (a.company ?? a.label).localeCompare(b.company ?? b.label) || a.label.localeCompare(b.label);
    if (sort === 'synced') return a.syncedAt.getTime() - b.syncedAt.getTime() || a.label.localeCompare(b.label);
    return a.label.localeCompare(b.label);
  };
  return kept.sort((a, b) => sign * compare(a, b) || a.id.localeCompare(b.id));
}

/** The filter choices present in a queue, so the bar offers only values that select something. */
export function enrichmentFilterOptions(items: EnrichmentQueueItem[]) {
  const set = (values: string[]) => [...new Set(values)].sort();
  return {
    tiers: set(items.flatMap((i) => (i.tier ? [i.tier] : []))),
    types: set(items.flatMap((i) => i.contactType)),
    products: set(items.flatMap((i) => i.productInterest)),
    tags: set(items.flatMap((i) => i.tags)),
    accounts: [...new Map(items.flatMap((i) => (i.companyId ? [[i.companyId, i.entity === 'company' ? i.label : i.company ?? i.companyId] as const] : []))).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    fields: [...new Map(items.flatMap((i) => [...i.gaps, ...i.hidden].map((g) => [g.field, gapSpecs(i.entity).find((s) => s.field === g.field)?.label ?? g.field] as const))).entries()].map(([field, label]) => ({ field, label })),
  };
}

/* -------------------------------------------------------------------------- */
/* By account                                                                 */
/* -------------------------------------------------------------------------- */

export type AccountGroup = {
  companyId: string | null;
  name: string;
  href: string | null;
  owner: string | null;
  /** What the account itself lacks. */
  accountGaps: EnrichmentGap[];
  /** People at it with something missing, and how many gaps between them. */
  contacts: number;
  contactGaps: number;
  /** The kinds of missing information, most common first. */
  fields: { field: string; label: string; count: number }[];
  /** Every record in the group, for export or a mark. */
  records: { entity: EnrichmentEntity; id: string }[];
};

/** The queue folded under the firm, so a whole account can go to research at once. */
export function groupByAccount(items: EnrichmentQueueItem[]): AccountGroup[] {
  const groups = new Map<string, AccountGroup>();
  const get = (key: string, name: string, companyId: string | null) => {
    let g = groups.get(key);
    if (!g) { g = { companyId, name, href: companyId ? `/accounts/${companyId}` : null, owner: null, accountGaps: [], contacts: 0, contactGaps: 0, fields: [], records: [] }; groups.set(key, g); }
    return g;
  };
  const counts = new Map<string, Map<string, { label: string; count: number }>>();
  for (const item of items) {
    const key = item.companyId ?? '';
    const g = get(key, item.entity === 'company' ? item.label : item.company ?? 'No account', item.companyId);
    if (item.entity === 'company') { g.name = item.label; g.accountGaps = item.gaps; g.owner = g.owner ?? item.owner; } else { g.contacts += 1; g.contactGaps += item.gaps.length; if (!g.owner) g.owner = item.owner; }
    g.records.push({ entity: item.entity, id: item.id });
    const tally = counts.get(key) ?? counts.set(key, new Map()).get(key)!;
    for (const gap of item.gaps) { const label = gapSpecs(item.entity).find((s) => s.field === gap.field)?.label ?? gap.label; const row = tally.get(`${item.entity}:${gap.field}`) ?? { label: item.entity === 'company' ? `${label} (account)` : label, count: 0 }; row.count += 1; tally.set(`${item.entity}:${gap.field}`, row); }
  }
  for (const [key, g] of groups) g.fields = [...(counts.get(key) ?? new Map()).entries()].map(([k, v]) => ({ field: k, label: v.label, count: v.count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return [...groups.values()].sort((a, b) => (b.accountGaps.length + b.contactGaps) - (a.accountGaps.length + a.contactGaps) || a.name.localeCompare(b.name));
}

/* -------------------------------------------------------------------------- */
/* Marks                                                                      */
/* -------------------------------------------------------------------------- */

export type MarkRequest = { entity: EnrichmentEntity; ids: string[]; /** null: every open gap on the record (or every hidden one, when lifting "not found"). */ fields: string[] | null };

async function markableIds(user: SessionUser, entity: EnrichmentEntity, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)].slice(0, 2000);
  if (!unique.length) return [];
  if (isAdmin(user)) return unique;
  // A leader marks inside their pods; reading is universal, leaving a note on the record is not.
  if (entity === 'person') return (await prisma.personCache.findMany({ where: { AND: [await podPeopleWhere(user), { id: { in: unique } }] }, select: { id: true } })).map((r) => r.id);
  const people = await prisma.personCache.findMany({ where: { AND: [await podPeopleWhere(user), { companyId: { in: unique } }] }, select: { companyId: true }, distinct: ['companyId'] });
  const allowed = new Set([...people.map((p) => p.companyId!), ...(await prisma.companyCache.findMany({ where: { id: { in: unique }, ownerMemberId: user.twentyMemberId ?? '__none__' }, select: { id: true } })).map((c) => c.id)]);
  return unique.filter((id) => allowed.has(id));
}

/** Leave a mark on gaps: who is researching them, or that they could not be found. */
export async function markEnrichmentGaps(user: SessionUser, req: MarkRequest, mark: { kind: MarkKind; assigneeId?: string | null }): Promise<{ marked: number }> {
  assertAllowed(canEnrich(user), 'Only a pod leader or administrator can mark gaps.');
  if (mark.kind === 'assigned' && !mark.assigneeId) throw new Error('Choose who researches it.');
  if (mark.kind === 'assigned') assertAllowed(Boolean(await prisma.user.findFirst({ where: { id: mark.assigneeId!, active: true }, select: { id: true } })), 'Choose an active team member.');
  const ids = await markableIds(user, req.entity, req.ids);
  if (!ids.length) throw new Error('None of the chosen records is in your pods.');
  const queue = new Map((await enrichmentQueue(user)).filter((i) => i.entity === req.entity).map((i) => [i.id, i]));
  const writes: Prisma.EnrichmentMarkUpsertArgs[] = [];
  for (const id of ids) {
    const item = queue.get(id);
    if (!item) continue;
    const fields = req.fields ? item.gaps.filter((g) => req.fields!.includes(g.field)).map((g) => g.field) : item.gaps.map((g) => g.field);
    for (const field of fields) writes.push({ where: { entity_recordId_field: { entity: req.entity, recordId: id, field } }, create: { entity: req.entity, recordId: id, field, kind: mark.kind, assigneeId: mark.kind === 'assigned' ? mark.assigneeId! : null, byId: user.id }, update: { kind: mark.kind, assigneeId: mark.kind === 'assigned' ? mark.assigneeId! : null, byId: user.id, createdAt: new Date() } });
  }
  if (!writes.length) throw new Error('Nothing is missing on the chosen records.');
  await prisma.$transaction(writes.map((w) => prisma.enrichmentMark.upsert(w)));
  return { marked: writes.length };
}

/** Lift marks: take a gap back from research, or reopen one marked not found. */
export async function clearEnrichmentMarks(user: SessionUser, req: MarkRequest, kind: MarkKind): Promise<{ cleared: number }> {
  assertAllowed(canEnrich(user), 'Only a pod leader or administrator can change marks.');
  const ids = await markableIds(user, req.entity, req.ids);
  if (!ids.length) throw new Error('None of the chosen records is in your pods.');
  const result = await prisma.enrichmentMark.deleteMany({ where: { entity: req.entity, recordId: { in: ids }, kind, ...(req.fields ? { field: { in: req.fields } } : {}) } });
  return { cleared: result.count };
}

/* -------------------------------------------------------------------------- */
/* Scorecard                                                                  */
/* -------------------------------------------------------------------------- */

export type ScorecardCell = { field: string; label: string; filled: number; total: number; previous: { filled: number; total: number } | null };
export type ScorecardGroup = { kind: 'all' | 'pod' | 'fo'; id: string; name: string; total: number; cells: ScorecardCell[] };
export type Scorecard = { contacts: ScorecardGroup[]; accounts: ScorecardGroup[]; since: string | null; today: string };

type Tally = Map<string, { total: number; filled: Map<string, number> }>; // group key -> counts
const groupKey = (kind: string, id: string) => `${kind}\u0000${id}`;

async function scorecardTallies(user: SessionUser | null): Promise<{ contacts: Tally; accounts: Tally; names: Map<string, string> }> {
  const [{ rules }, blocked, schema, pods, members] = await Promise.all([getSettings(), blockedCompanyIds(), getTwentySchema(), prisma.pod.findMany({ select: { podOwnerValue: true, name: true } }), prisma.user.findMany({ where: { twentyMemberId: { not: null } }, select: { twentyMemberId: true, name: true } })]);
  const [people, companies] = await Promise.all([
    prisma.personCache.findMany({ where: user ? await enrichmentPeopleScope(user) : { deletedAt: null, AND: [await externalPeopleWhere()] }, select: { id: true, firstName: true, lastName: true, email: true, phone: true, badEmail: true, badPhone: true, emailMissing: true, phoneMissing: true, companyId: true, linkedinUrl: true, jobTitle: true, tags: true, ownerMemberId: true, podOwner: true } }),
    prisma.companyCache.findMany({ where: user ? await enrichmentCompanyScope(user) : { deletedAt: null }, select: { id: true, name: true, domain: true, linkedinUrl: true, city: true, raw: true, employees: true, aum: true, ownerMemberId: true } }),
  ]);
  const ctx: GapContext = { enrichmentTags: new Set(schema.personValues.needsEnrichmentTags), addressField: schema.company.address };
  const names = new Map<string, string>([[groupKey('all', ''), 'Everyone']]);
  for (const p of pods) names.set(groupKey('pod', p.podOwnerValue), p.name);
  for (const m of members) names.set(groupKey('fo', m.twentyMemberId!), m.name);
  const count = <R,>(tally: Tally, specs: GapSpec<R>[], record: R, keys: string[]) => {
    for (const key of keys) {
      const row = tally.get(key) ?? tally.set(key, { total: 0, filled: new Map() }).get(key)!;
      row.total += 1;
      for (const spec of specs) if (spec.scorecard && !spec.missing(record, ctx)) row.filled.set(spec.field, (row.filled.get(spec.field) ?? 0) + 1);
    }
  };
  const contacts: Tally = new Map();
  const accounts: Tally = new Map();
  const blockedIds = new Set(blocked);
  const companyPods = new Map<string, Set<string>>();
  const companyMembers = new Map<string, Set<string>>();
  for (const p of people) {
    if (p.companyId && p.ownerMemberId) (companyMembers.get(p.companyId) ?? companyMembers.set(p.companyId, new Set()).get(p.companyId)!).add(p.ownerMemberId);
    count(contacts, PERSON_GAPS, p, [groupKey('all', ''), ...(p.podOwner ? [groupKey('pod', p.podOwner)] : []), ...(p.ownerMemberId && names.has(groupKey('fo', p.ownerMemberId)) ? [groupKey('fo', p.ownerMemberId)] : [])]);
    if (p.companyId && p.podOwner) (companyPods.get(p.companyId) ?? companyPods.set(p.companyId, new Set()).get(p.companyId)!).add(p.podOwner);
  }
  for (const c of companies) {
    if (isInternalCompany(c, rules) || blockedIds.has(c.id) || isNotAccount(c, rules)) continue;
    count(accounts, COMPANY_GAPS, c, [groupKey('all', ''), ...[...(companyPods.get(c.id) ?? [])].map((pod) => groupKey('pod', pod)), ...[...new Set([...(companyMembers.get(c.id) ?? []), ...(c.ownerMemberId ? [c.ownerMemberId] : [])])].filter(id => names.has(groupKey('fo', id))).map(id => groupKey('fo', id))]);
  }
  return { contacts, accounts, names };
}

const toGroups = (tally: Tally, names: Map<string, string>, specs: GapSpec<PersonRecord | CompanyRecord>[], previous: Map<string, { total: number; filled: number }>, entity: EnrichmentEntity): ScorecardGroup[] =>
  [...tally.entries()].map(([key, row]) => {
    const [kind, id] = key.split('\u0000') as ['all' | 'pod' | 'fo', string];
    return {
      kind, id, name: names.get(key) ?? id, total: row.total,
      cells: specs.filter((s) => s.scorecard).map((s) => ({ field: s.field, label: s.label, filled: row.filled.get(s.field) ?? 0, total: row.total, previous: previous.get(`${entity}\u0000${kind}\u0000${id}\u0000${s.field}`) ?? null })),
    };
  }).sort((a, b) => ({ all: 0, pod: 1, fo: 2 }[a.kind] - { all: 0, pod: 1, fo: 2 }[b.kind]) || a.name.localeCompare(b.name));

/** Completeness by field, for everyone, each pod and each FO, beside the snapshot from about a week ago. */
export async function enrichmentScorecard(user: SessionUser, now = new Date()): Promise<Scorecard> {
  const today = todayIn(workspaceTimezone(), now);
  await ensureScorecardSnapshot(now);
  const { contacts, accounts, names } = await scorecardTallies(canSeeAllPods(user) ? null : user);
  // The comparison day: the newest snapshot at least a week old, else the oldest one before today.
  const anchor = (await prisma.enrichmentSnapshot.findFirst({ where: { day: { lte: addDays(today, -7) } }, orderBy: { day: 'desc' }, select: { day: true } })) ?? (await prisma.enrichmentSnapshot.findFirst({ where: { day: { lt: today } }, orderBy: { day: 'asc' }, select: { day: true } }));
  const previous = new Map<string, { total: number; filled: number }>();
  if (anchor) for (const s of await prisma.enrichmentSnapshot.findMany({ where: { day: anchor.day } })) previous.set(`${s.entity}\u0000${s.groupKind}\u0000${s.groupId}\u0000${s.field}`, { total: s.total, filled: s.filled });
  return { contacts: toGroups(contacts, names, gapSpecs('person'), previous, 'person'), accounts: toGroups(accounts, names, gapSpecs('company'), previous, 'company'), since: anchor?.day ?? null, today };
}

/** Write today's completeness for every group, once a day; the worker calls it nightly and the scorecard view fills a missed day. */
export async function ensureScorecardSnapshot(now = new Date()): Promise<{ day: string; rows: number; written: boolean }> {
  const day = todayIn(workspaceTimezone(), now);
  if (await prisma.enrichmentSnapshot.count({ where: { day } })) return { day, rows: 0, written: false };
  return snapshotScorecard(now);
}

export async function snapshotScorecard(now = new Date()): Promise<{ day: string; rows: number; written: boolean }> {
  const day = todayIn(workspaceTimezone(), now);
  const { contacts, accounts } = await scorecardTallies(null);
  const rows: Prisma.EnrichmentSnapshotCreateManyInput[] = [];
  const push = (entity: EnrichmentEntity, tally: Tally, specs: GapSpec<PersonRecord | CompanyRecord>[]) => {
    for (const [key, row] of tally) {
      const [groupKind, groupId] = key.split('\u0000');
      for (const s of specs) if (s.scorecard) rows.push({ day, entity, groupKind, groupId, field: s.field, total: row.total, filled: row.filled.get(s.field) ?? 0 });
    }
  };
  push('person', contacts, gapSpecs('person'));
  push('company', accounts, gapSpecs('company'));
  await prisma.$transaction([prisma.enrichmentSnapshot.deleteMany({ where: { day } }), ...(rows.length ? [prisma.enrichmentSnapshot.createMany({ data: rows })] : [])]);
  return { day, rows: rows.length, written: true };
}

/* -------------------------------------------------------------------------- */
/* Mapping memory                                                             */
/* -------------------------------------------------------------------------- */

/** The same columns in any order are the same file shape. */
export const mappingSignature = (entity: EnrichmentEntity, headers: string[]) => `${entity}:${headers.map(normalizedHeader).filter(Boolean).sort().join('|')}`;

export async function rememberedMapping(entity: EnrichmentEntity, headers: string[]): Promise<{ mapping: Record<string, string>; name: string } | null> {
  const row = await prisma.enrichmentMapping.findUnique({ where: { signature: mappingSignature(entity, headers) } });
  if (!row || row.entity !== entity) return null;
  const stored = row.mapping as Record<string, string>;
  // Headers are matched by their normalised form, so "Work Email" and "work_email" find the same memory.
  const byNormal = new Map(Object.entries(stored).map(([header, target]) => [normalizedHeader(header), target]));
  return { mapping: Object.fromEntries(headers.map((h) => [h, byNormal.get(normalizedHeader(h)) ?? ''])), name: row.name };
}

export async function rememberMapping(entity: EnrichmentEntity, headers: string[], mapping: Record<string, string>, name: string): Promise<void> {
  const kept = Object.fromEntries(Object.entries(mapping).filter(([header, target]) => headers.includes(header) && target));
  if (!Object.keys(kept).length) return;
  const signature = mappingSignature(entity, headers);
  await prisma.enrichmentMapping.upsert({ where: { signature }, create: { signature, entity, mapping: kept, name: name.slice(0, 200) }, update: { mapping: kept, name: name.slice(0, 200) } });
}
