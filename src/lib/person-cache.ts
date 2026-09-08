import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from './db';
import type { TwentyClient } from './twenty/client';
import { paginate } from './twenty/client';
import { optionLabel } from './twenty/labels';
import type { TwentyCompany, TwentyPerson } from './twenty/types';

/** An ISO string from Twenty, or null. Invalid dates are dropped rather than stored as 1970. */
function date(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

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

    meetingAt: date(p.meetingAt),
    meetingUrl: p.meetingUrl,
    recordingUrl: p.recordingUrl,
    bookingId: p.bookingId,

    createdBySource: p.createdBySource,
    createdByName: p.createdByName,

    raw: (p.raw ?? undefined) as Prisma.InputJsonValue | undefined,
    twentyUpdatedAt: p.updatedAt ? new Date(p.updatedAt) : null,
    deletedAt: p.deletedAt ? new Date(p.deletedAt) : null,
    syncedAt: new Date(),
  };
}

export async function upsertPersonCache(p: TwentyPerson, tx: Tx | typeof prisma = prisma) {
  const data = personToCacheData(p);
  const { id, ...rest } = data;
  const row = await tx.personCache.upsert({ where: { id }, create: data, update: rest });
  if (p.podOwner) await ensurePod(p.podOwner, null, tx);
  return row;
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

export async function upsertCompanyCache(c: TwentyCompany, tx: Tx | typeof prisma = prisma) {
  const data = {
    name: c.name,
    domain: c.domain,
    ownerMemberId: c.ownerMemberId ?? null,
    industry: c.industry ?? null,
    employees: c.employees ?? null,
    city: c.city ?? null,
    linkedinUrl: c.linkedinUrl ?? null,
    raw: (c.raw ?? undefined) as Prisma.InputJsonValue | undefined,
    twentyUpdatedAt: c.updatedAt ? new Date(c.updatedAt) : null,
    deletedAt: c.deletedAt ? new Date(c.deletedAt) : null,
    syncedAt: new Date(),
  };
  return tx.companyCache.upsert({ where: { id: c.id }, create: { id: c.id, ...data }, update: data });
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
  try {
    await syncPodsFromTwenty(client);
  } catch (err) {
    console.warn('[cache] pod sync skipped:', err instanceof Error ? err.message : String(err));
  }
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
