import { isRoleEmail, normalizeEmail, normalizeLinkedin, toE164 } from './sandbox/normalize';
import { findSuppressed, type SuppressionKey } from './sandbox/suppression';
import { SYSTEM_ACTOR } from './audit';
import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from './db';
import type { TwentyClient } from './twenty/client';
import { paginate } from './twenty/client';
import type { Page } from './twenty/types';
import { optionLabel } from './twenty/labels';
import type { TwentyCompany, TwentyPerson } from './twenty/types';

/** An ISO string from Twenty, or null. Invalid dates are dropped rather than stored as 1970. */
function date(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** An ordering key, or null for a blank name so the nameless sort after everyone with one. */
export function sortKey(name: string | null | undefined): string | null {
  const key = (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return key || null;
}

export function personToCacheData(p: TwentyPerson): Prisma.PersonCacheUncheckedCreateInput {
  return {
    id: p.id,
    firstName: p.firstName ?? '',
    lastName: p.lastName ?? '',
    sortName: sortKey(`${p.firstName ?? ''} ${p.lastName ?? ''}`),
    email: p.email,
    // Every comparison goes through these, never the address as Twenty holds it (B011).
    emailNorm: normalizeEmail(p.email),
    additionalEmailsNorm: (p.additionalEmails ?? []).map(normalizeEmail).filter((e): e is string => Boolean(e)),
    phone: p.phone,
    phoneE164: toE164(p.phone),
    additionalPhoneE164: toE164(p.additionalPhone),
    linkedinUrl: p.linkedinUrl,
    linkedinKey: normalizeLinkedin(p.linkedinUrl),
    jobTitle: p.jobTitle,
    city: p.city,
    companyId: p.companyId,
    companyName: p.companyName,
    ownerMemberId: p.ownerMemberId,
    podOwner: p.podOwner,

    dnd: Boolean(p.dnd),
    dndReason: p.dndReason,
    tags: p.tags ?? [],

    additionalEmails: p.additionalEmails ?? [],
    additionalPhone: p.additionalPhone,
    xUrl: p.xUrl,

    leadSource: p.leadSource ?? [],
    leadSourceNotes: p.leadSourceNotes,
    tier: p.tier,
    contactType: p.contactType ?? [],
    listCategory: p.listCategory,
    previousCadence: p.previousCadence,
    pipelineStage: p.pipelineStage,
    productInterest: p.productInterest ?? [],
    primaryProduct: p.primaryProduct,
    campaigns: p.campaigns ?? [],
    onCallingList: Boolean(p.onCallingList),
    dealSignalStrength: p.dealSignalStrength,
    emailMissing: Boolean(p.emailMissing),
    phoneMissing: Boolean(p.phoneMissing),
    rotatedTo: p.rotatedTo,
    rotationChangedAt: date(p.rotationChangedAt),

    nextAction: p.nextAction,
    nextActionDueDate: p.nextActionDueDate,
    nextStep: p.nextStep,
    nextActionDueDatePoc: p.nextActionDueDatePoc,
    lastNote: p.lastNote,

    lastCallAt: date(p.lastCallAt),
    lastEmailAt: date(p.lastEmailAt),

    recordingUrl: p.recordingUrl,
    meetingUrl: p.meetingUrl,
    bookingId: p.bookingId,

    createdBySource: p.createdBySource,
    createdByName: p.createdByName,

    raw: (p.raw ?? undefined) as Prisma.InputJsonValue | undefined,
    twentyUpdatedAt: date(p.updatedAt),
    deletedAt: date(p.deletedAt),
    syncedAt: new Date(),
  };
}

/**
 * `fresh`: the snapshot was just read from a Twenty listing, so it states what Twenty holds now.
 * A deletion stamp Cadence set itself (a full pass that did not see the record) or one older
 * than a restore from the CRM's bin then gives way to it (N04), instead of hiding the person for good.
 */
export async function upsertPersonCache(p: TwentyPerson, tx: Tx | typeof prisma = prisma, opts: { fresh?: boolean } = {}) {
  const data = personToCacheData(p);
  const { id, ...rest } = data;
  // Mark the record as seen even when this listing/webhook carries an older snapshot.
  await tx.personCache.upsert({ where: { id }, create: data, update: { syncedAt: data.syncedAt } });
  await tx.personCache.updateMany({ where: { id, ...snapshotOrder(p.updatedAt, p.deletedAt, opts.fresh) }, data: rest });
  const row = await tx.personCache.findUniqueOrThrow({ where: { id } });
  if (row.podOwner) await ensurePod(row.podOwner, null, tx);
  if (tx === prisma) await optOutIfSuppressed(row);
  return row;
}

/**
 * B010: a person who enters or changes in Cadence's copy of the CRM is checked against the
 * suppression list, and opted out on a hit (in the CRM too, D6). Their own email or LinkedIn, or a
 * number someone asked us never to call, counts; a shared inbox (info@) never does, and neither does
 * an opted-out cold contact's office line, which protects only that contact. Also a cold contact who
 * opted out with the same personal email.
 */
export async function optOutIfSuppressed(row: Pick<Prisma.PersonCacheGetPayload<object>, 'id' | 'optedOut' | 'deletedAt' | 'emailNorm' | 'additionalEmailsNorm' | 'phoneE164' | 'additionalPhoneE164' | 'linkedinUrl'>): Promise<boolean> {
  if (row.optedOut || row.deletedAt) return false;
  const emails = [...new Set([row.emailNorm, ...row.additionalEmailsNorm].filter((e): e is string => Boolean(e) && !isRoleEmail(e)))];
  const keys: SuppressionKey[] = [
    ...emails.map((value) => ({ kind: 'email' as const, value })),
    ...[row.phoneE164, row.additionalPhoneE164].filter((n): n is string => Boolean(n)).map((value) => ({ kind: 'phone' as const, value })),
    ...(normalizeLinkedin(row.linkedinUrl) ? [{ kind: 'linkedin' as const, value: normalizeLinkedin(row.linkedinUrl)! }] : []),
  ];
  const hit = (await findSuppressed(keys)) ?? (emails.length && (await prisma.sandboxContact.findFirst({ where: { optedOutAt: { not: null }, OR: [{ email: { in: emails } }, { additionalEmails: { hasSome: emails } }] }, select: { id: true } })));
  if (!hit) return false;
  const { optOutPerson } = await import('./outreach/transitions');
  await optOutPerson(row.id, { source: 'suppression_list', actor: SYSTEM_ACTOR, reason: 'Their details are on the suppression list.' });
  return true;
}

/**
 * Deletions have their own clock in Twenty. Compare both clocks in the atomic write. A fresh read
 * from Twenty compares only Twenty's own edit clock: the cached deletion stamp may be one Cadence
 * set itself, which says nothing about Twenty's order of events (N04).
 */
function snapshotOrder(updatedAt?: string | null, deletedAt?: string | null, fresh = false) {
  const dates = [date(updatedAt), date(deletedAt)].filter((value): value is Date => value !== null);
  const version = dates.length ? new Date(Math.max(...dates.map((value) => value.getTime()))) : null;
  return { AND: [
    { OR: [{ twentyUpdatedAt: null }, ...(version ? [{ twentyUpdatedAt: { lte: version } }] : [])] },
    ...(fresh ? [] : [{ OR: [{ deletedAt: null }, ...(version ? [{ deletedAt: { lte: version } }] : [])] }]),
  ] };
}

/**
 * Pods follow Twenty: a person arriving with a podOwner value Cadence has never seen creates the
 * pod on the spot (marked as discovered) so nothing is lost. Admins then assign FOs to it.
 */
export async function ensurePod(podOwnerValue: string, label: string | null, tx: Tx | typeof prisma = prisma) {
  const value = podOwnerValue.trim();
  if (!value) return null;
  const existing = await tx.pod.findUnique({ where: { podOwnerValue: value } });
  if (existing) {
    // Follow a renamed option label from Twenty (labels only; the stored value is the key).
    if (label && label !== existing.name && !(await tx.pod.findFirst({ where: { name: label, NOT: { id: existing.id } } }))) {
      return tx.pod.update({ where: { id: existing.id }, data: { name: label } });
    }
    return existing;
  }
  // Twenty stores podOwner values upper-case (ALISA). Without a label from the field's
  // metadata, a readable form of the value is a better pod name than the constant itself.
  let name = label ?? optionLabel(value);
  if (await tx.pod.findUnique({ where: { name } })) name = `${name} (${value})`;
  const pod = await tx.pod.create({ data: { name, podOwnerValue: value, discoveredAt: label ? null : new Date() } });
  await tx.auditLog.create({ data: { entityType: 'pod', entityId: pod.id, action: label ? 'created_from_twenty_options' : 'discovered', actorType: 'SYSTEM', actorLabel: 'twenty-sync', details: { podOwnerValue: value, label } } });
  return pod;
}

/**
 * Create or rename pods from the podOwner select options in Twenty (labels become pod names,
 * values stay the key). Returns what changed. Never deletes: an option removed in Twenty leaves
 * its pod in place for the admin to retire.
 */
export async function syncPodsFromTwenty(client: TwentyClient, podOwnerField = 'podOwner'): Promise<{ created: string[]; renamed: string[]; options: number }> {
  const intro = await client.introspect();
  const person = intro.objects.find((o) => o.nameSingular === 'person' || o.namePlural === 'people');
  const field = person?.fields.find((f) => f.name === podOwnerField);
  const created: string[] = [];
  const renamed: string[] = [];
  if (!field?.options?.length) return { created, renamed, options: 0 };
  for (const value of field.options) {
    const label = field.optionLabels?.[value] ?? null;
    const before = await prisma.pod.findUnique({ where: { podOwnerValue: value } });
    const after = await ensurePod(value, label);
    if (!before && after) created.push(after.name);
    else if (before && after && before.name !== after.name) renamed.push(`${before.name} -> ${after.name}`);
  }
  return { created, renamed, options: field.options.length };
}

export async function upsertCompanyCache(c: TwentyCompany, tx: Tx | typeof prisma = prisma, opts: { fresh?: boolean } = {}) {
  const data = {
    name: c.name,
    sortName: sortKey(c.name),
    domain: c.domain,
    ownerMemberId: c.ownerMemberId ?? null,
    industry: c.industry ?? null,
    employees: c.employees ?? null,
    aum: c.aum ?? null,
    city: c.city ?? null,
    linkedinUrl: c.linkedinUrl ?? null,
    raw: (c.raw ?? undefined) as Prisma.InputJsonValue | undefined,
    twentyUpdatedAt: date(c.updatedAt),
    deletedAt: date(c.deletedAt),
    syncedAt: new Date(),
  };
  await tx.companyCache.upsert({ where: { id: c.id }, create: { id: c.id, ...data }, update: { syncedAt: data.syncedAt } });
  await tx.companyCache.updateMany({ where: { id: c.id, ...snapshotOrder(c.updatedAt, c.deletedAt, opts.fresh) }, data });
  return tx.companyCache.findUniqueOrThrow({ where: { id: c.id } });
}

export async function markPersonDeleted(personId: string, at = new Date(), tx: Tx | typeof prisma = prisma) {
  return tx.personCache.updateMany({ where: { id: personId, ...snapshotOrder(null, at.toISOString()) }, data: { deletedAt: at, syncedAt: new Date() } });
}

export async function markCompanyDeleted(companyId: string, at = new Date(), tx: Tx | typeof prisma = prisma) {
  return tx.companyCache.updateMany({ where: { id: companyId, ...snapshotOrder(null, at.toISOString()) }, data: { deletedAt: at, syncedAt: new Date() } });
}

export type RefreshStage = 'people' | 'companies' | 'deletedPeople' | 'deletedCompanies';

export type RefreshStats = {
  people: number;
  companies: number;
  deleted: number;
  /** Cached rows Twenty no longer returned after a full pass, now marked deleted here. */
  removed: number;
  /** Records Twenty returned that this side could not store, and the first reason. */
  failed: number;
  firstError: string | null;
  /** A listing that stopped part-way, by stage. The other stages still ran. */
  stageErrors: Partial<Record<RefreshStage, string>>;
  /** A full pass: where its listings got to. Both done means the pass is complete. */
  progress?: FullRefreshProgress;
  /** Why records Twenty did not return were not marked deleted (N04). */
  removalSkipped?: string;
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Pull people and companies from Twenty into the cache. A record Twenty returns that this side
 * cannot store (an option it has never seen, a value the schema refuses) is counted and logged
 * and the run goes on: one odd record used to abort the whole sync and leave the workspace with a
 * handful of contacts and no explanation. A listing that fails part-way (a rejected filter, a
 * permission the API key lacks, a timeout) is recorded against its stage and the next stage still
 * runs, so a problem with companies never costs the people. With `since`, records soft-deleted in
 * that window are fetched as well - Twenty does not bump updatedAt when it deletes, so an update
 * scan never sees them. Without `since` the pass is complete, so anything cached that Twenty did
 * not return no longer exists there and is marked deleted here.
 */
export async function refreshPersonCache(client: TwentyClient, opts: { since?: string; sinceByStage?: Partial<Record<RefreshStage, string>>; resume?: FullRefreshProgress; pageBudget?: number; /** N13: the people a change scan listed, kept for the caller so it need not list them again. */ collect?: { people: TwentyPerson[]; deletedPeople: TwentyPerson[] } } = {}): Promise<RefreshStats> {
  const stats: RefreshStats = { people: 0, companies: 0, deleted: 0, removed: 0, failed: 0, firstError: null, stageErrors: {} };
  const startedAt = new Date();
  const attempt = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      return true;
    } catch (err) {
      stats.failed += 1;
      const message = `${label}: ${errorText(err)}`;
      if (!stats.firstError) stats.firstError = message;
      console.warn(`[cache] ${message}`);
      return false;
    }
  };
  const stage = async (name: RefreshStage, fn: () => Promise<void>) => {
    try {
      await fn();
      return true;
    } catch (err) {
      stats.stageErrors[name] = errorText(err);
      console.warn(`[cache] ${name} listing stopped: ${stats.stageErrors[name]}`);
      return false;
    }
  };
  // N13: the whole data model is read for new pods once a day with the full listing, not every
  // minute; a person arriving with an unknown pod creates it on the spot all the same (ensurePod).
  if (!opts.since) {
    try {
      await syncPodsFromTwenty(client);
    } catch (err) {
      console.warn('[cache] pod sync skipped:', errorText(err));
    }
  }
  if (opts.since) {
    await stage('people', async () => {
      for await (const person of paginate((after) => client.listPeople({ updatedSince: opts.sinceByStage?.people ?? opts.since, after, limit: 100, includeDeleted: true }))) {
        opts.collect?.people.push(person);
        if (await attempt(`person ${person.id}`, () => upsertPersonCache(person, prisma, { fresh: true }))) stats.people += 1;
      }
    });
    await stage('companies', async () => {
      for await (const company of paginate((after) => client.listCompanies({ updatedSince: opts.sinceByStage?.companies ?? opts.since, after, limit: 100 }))) {
        if (await attempt(`company ${company.id}`, () => upsertCompanyCache(company, prisma, { fresh: true }))) stats.companies += 1;
      }
    });
    await stage('deletedPeople', async () => {
      for await (const person of paginate((after) => client.listPeople({ deletedSince: opts.sinceByStage?.deletedPeople ?? opts.since, after, limit: 100 }))) {
        opts.collect?.deletedPeople.push(person);
        if (await attempt(`deleted person ${person.id}`, () => upsertPersonCache(person, prisma, { fresh: true }))) stats.deleted += 1;
      }
    });
    await stage('deletedCompanies', async () => {
      for await (const company of paginate((after) => client.listCompanies({ deletedSince: opts.sinceByStage?.deletedCompanies ?? opts.since, after, limit: 100 }))) {
        if (await attempt(`deleted company ${company.id}`, () => upsertCompanyCache(company, prisma, { fresh: true }))) stats.deleted += 1;
      }
    });
    return stats;
  }
  // A full pass, possibly spread over several calls (N01): each listing resumes at the page where
  // the previous call stopped, within a page budget, instead of starting again from page one.
  const progress: FullRefreshProgress = opts.resume ? { ...opts.resume } : { startedAt: startedAt.toISOString(), peopleAfter: null, peopleDone: false, companiesAfter: null, companiesDone: false };
  stats.progress = progress;
  const since = new Date(progress.startedAt);
  const budget = { left: opts.pageBudget ?? MAX_FULL_PAGES };
  if (!progress.peopleDone && budget.left > 0) {
    await stage('people', async () => {
      progress.peopleDone = await walk((after) => client.listPeople({ after, limit: 100, includeDeleted: true }), budget, progress, 'peopleAfter', async (person) => {
        if (await attempt(`person ${person.id}`, () => upsertPersonCache(person, prisma, { fresh: true }))) stats.people += 1;
      });
    });
    // A full listing saw everything Twenty has. A row it did not touch was deleted there (or
    // merged away) and would otherwise stay on screen for good.
    if (progress.peopleDone) await sweepUnseen('person', client, since, stats);
  }
  if (!progress.companiesDone && budget.left > 0) {
    await stage('companies', async () => {
      progress.companiesDone = await walk((after) => client.listCompanies({ after, limit: 100 }), budget, progress, 'companiesAfter', async (company) => {
        if (await attempt(`company ${company.id}`, () => upsertCompanyCache(company, prisma, { fresh: true }))) stats.companies += 1;
      });
    });
    if (progress.companiesDone) await sweepUnseen('company', client, since, stats);
  }
  if (!opts.pageBudget && !(progress.peopleDone && progress.companiesDone)) {
    for (const name of ['people', 'companies'] as const) if (!progress[name === 'people' ? 'peopleDone' : 'companiesDone']) stats.stageErrors[name] ??= `CRM paging exceeded ${MAX_FULL_PAGES} pages; sync is incomplete.`;
  }
  return stats;
}

/** Where a full listing of Twenty got to, so the next call carries on from there (N01). */
export type FullRefreshProgress = { startedAt: string; peopleAfter: string | null; peopleDone: boolean; companiesAfter: string | null; companiesDone: boolean };

const MAX_FULL_PAGES = 1000;

/**
 * Walk pages from the saved cursor while the budget lasts. The cursor is saved after each page is
 * stored, so a failure part-way loses at most that page. True when the listing reached its end.
 */
async function walk<T>(fetchPage: (after: string | null) => Promise<Page<T>>, budget: { left: number }, progress: FullRefreshProgress, key: 'peopleAfter' | 'companiesAfter', each: (item: T) => Promise<void>): Promise<boolean> {
  const cursors = new Set<string>();
  while (budget.left > 0) {
    budget.left -= 1;
    const page = await fetchPage(progress[key]);
    for (const item of page.items) await each(item);
    if (!page.hasNextPage) {
      progress[key] = null;
      return true;
    }
    if (!page.endCursor || cursors.has(page.endCursor) || page.endCursor === progress[key]) throw new Error('CRM paging did not advance; sync is incomplete.');
    cursors.add(page.endCursor);
    progress[key] = page.endCursor;
  }
  return false;
}

/**
 * N04: mark deleted what a complete listing did not return, but only when the listing can be shown
 * to be complete. Twenty has ended a listing early without an error (530 of 8,369 people), so the
 * records it returned live must reach the number it says it holds; otherwise nothing is marked.
 */
async function sweepUnseen(kind: 'person' | 'company', client: TwentyClient, since: Date, stats: RefreshStats) {
  const expected = await client.countRecords(kind).catch(() => null);
  const where = { deletedAt: null, syncedAt: { gte: since } };
  const seen = kind === 'person' ? await prisma.personCache.count({ where }) : await prisma.companyCache.count({ where });
  if (expected === null || seen < expected) {
    const label = kind === 'person' ? 'people' : 'companies';
    const reason = expected === null ? `the CRM did not say how many ${label} it holds` : `the listing returned ${seen} of the ${expected} ${label} the CRM holds`;
    stats.removalSkipped = [stats.removalSkipped, `No ${label} were marked deleted: ${reason}.`].filter(Boolean).join(' ');
    console.warn(`[cache] ${stats.removalSkipped}`);
    return;
  }
  const stale = { where: { deletedAt: null, syncedAt: { lt: since } }, data: { deletedAt: since, syncedAt: since } };
  // N07: a person gone from the CRM leaves their sequences too, as the deletion webhook would have.
  const goneIds = kind === 'person' ? (await prisma.personCache.findMany({ where: stale.where, select: { id: true } })).map((p) => p.id) : [];
  const gone = kind === 'person' ? await prisma.personCache.updateMany(stale) : await prisma.companyCache.updateMany(stale);
  stats.removed += gone.count;
  if (!goneIds.length) return;
  const { applyPersonFlags } = await import('./engine/enrollment');
  const marked = await prisma.personCache.findMany({ where: { id: { in: goneIds }, deletedAt: since }, select: { id: true } });
  for (const { id } of marked) {
    await applyPersonFlags({ id, dnd: false, deletedAt: since.toISOString() }, { actor: SYSTEM_ACTOR }).catch((err) => console.warn(`[cache] person ${id} removed but not taken out of their sequence: ${errorText(err)}`));
  }
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

/**
 * A person as a list names them. Twenty holds hundreds of imported records with an email or a
 * phone and no name; the address is what a reader can recognise, so it stands in before the
 * placeholder does.
 */
export function cachedPersonName(p: { firstName: string; lastName: string; email?: string | null; phone?: string | null }): string {
  return [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || p.email?.trim() || p.phone?.trim() || '(no name)';
}
