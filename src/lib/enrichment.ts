import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { assertAllowed, isAdmin, isJuniorFo, isPodLeader } from './auth/rbac';
import { cachedPersonName, upsertCompanyCache, upsertPersonCache } from './person-cache';
import { getTwentySchema } from './settings';
import type { TwentyClient } from './twenty/client';
import type { EnrichCompanyInput, EnrichPersonInput, TwentyCompany, TwentyPerson } from './twenty/types';

export type EnrichmentEntity = 'person' | 'company';
export type EnrichmentField = { key: string; label: string; identity?: boolean };
export const ENRICHMENT_FIELDS: Record<EnrichmentEntity, EnrichmentField[]> = {
  person: [
    { key: 'recordId', label: 'Twenty contact ID', identity: true }, { key: 'matchEmail', label: 'Existing email (match only)', identity: true },
    { key: 'firstName', label: 'First name' }, { key: 'lastName', label: 'Last name' }, { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' }, { key: 'jobTitle', label: 'Job title' }, { key: 'linkedinUrl', label: 'LinkedIn URL' }, { key: 'city', label: 'City' },
  ],
  company: [
    { key: 'recordId', label: 'Twenty account ID', identity: true }, { key: 'matchDomain', label: 'Existing domain (match only)', identity: true },
    { key: 'name', label: 'Account name' }, { key: 'domain', label: 'Website domain' }, { key: 'industry', label: 'Industry' }, { key: 'employees', label: 'Employees' },
    { key: 'aum', label: 'AUM (USD)' }, { key: 'city', label: 'City' }, { key: 'linkedinUrl', label: 'LinkedIn URL' },
  ],
};
/**
 * What counts as missing, and how badly.
 *
 * **Critical** is what stops the work: without it you cannot reach the person, or you cannot tell
 * who they are. An address and a number are obvious; so are the company they work for and their
 * LinkedIn, because a contact with neither cannot be researched, verified or approached on the
 * one channel that does not need an address.
 *
 * **Useful** is what makes the work better rather than possible: the qualifying detail an FO
 * wants before a first call, and the account facts a pod leader wants before committing a
 * campaign to it. AUM is the clearest example - nothing stops without it, and everything is
 * better aimed with it.
 */
const CONTACT_CRITICAL = [
  ['companyId', 'Company'],
  ['linkedinUrl', 'LinkedIn'],
] as const;
const CONTACT_USEFUL = [
  ['jobTitle', 'Job title'],
  ['city', 'City'],
] as const;
const ACCOUNT_CRITICAL = [
  ['domain', 'Website'],
  ['linkedinUrl', 'LinkedIn'],
] as const;
const ACCOUNT_USEFUL = [
  ['industry', 'Industry'],
  ['employees', 'Employees'],
  ['city', 'City'],
  ['aum', 'AUM'],
  ['ownerMemberId', 'Account owner'],
] as const;

export const canEnrich = (user: SessionUser) => isAdmin(user) || isPodLeader(user);
const MAX_ROWS = 5_000;
const MAX_BYTES = 4_000_000;
export type ParsedEnrichment = { headers: string[]; rows: Record<string, string>[] };
const normalizedHeader = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** CSV with escaped quotes, multiline cells and comma/semicolon/tab delimiters; JSON stays flat. */
export function parseEnrichmentUpload(text: string): ParsedEnrichment {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Files can contain up to 5,000 rows and 4 MB.');
  const source = text.replace(/^\uFEFF/, '').trim();
  if (!source) throw new Error('Choose a CSV or JSON file with a header and at least one row.');
  let headers: string[];
  let records: Record<string, string>[];
  if (source.startsWith('[') || source.startsWith('{')) {
    let parsed: unknown;
    try { parsed = JSON.parse(source); } catch { throw new Error('The JSON file is not valid.'); }
    if (!Array.isArray(parsed) || parsed.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Use a JSON array of flat record objects.');
    headers = [...new Set(parsed.flatMap((row) => Object.keys(row)))];
    records = parsed.map((row) => Object.fromEntries(headers.map((header) => {
      const value = row[header];
      if (value !== null && value !== undefined && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`Column "${header}" contains a nested value. Flatten it before importing.`);
      return [header, value == null ? '' : String(value).trim()];
    })));
  } else {
    let delimiter = ',';
    let quoted = false;
    const counts = new Map([[',', 0], [';', 0], ['\t', 0]]);
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (char === '"') { if (quoted && source[index + 1] === '"') index++; else quoted = !quoted; }
      if (!quoted && char === '\n') break;
      if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1);
    }
    delimiter = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const rows: string[][] = [];
    let cells: string[] = [];
    let cell = '';
    quoted = false;
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (char === '"') {
        if (quoted && source[index + 1] === '"') { cell += '"'; index++; }
        else if (quoted || !cell.trim()) quoted = !quoted;
        else throw new Error('A CSV quote appears inside an unquoted value.');
      } else if (!quoted && (char === delimiter || char === '\n')) {
        cells.push(cell.trim()); cell = '';
        if (char === '\n') { if (cells.some(Boolean)) rows.push(cells); cells = []; }
      } else if (char !== '\r' || quoted) cell += char;
    }
    if (quoted) throw new Error('A quoted CSV cell is not closed.');
    cells.push(cell.trim());
    if (cells.some(Boolean)) rows.push(cells);
    headers = rows.shift() ?? [];
    if (rows.some((row) => row.length !== headers.length)) throw new Error('Every CSV row must have the same number of columns as the header.');
    records = rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
  }
  if (!headers.length || headers.length > 50 || headers.some((header) => !header.trim() || header.length > 200)) throw new Error('Use between 1 and 50 named columns.');
  if (new Set(headers.map(normalizedHeader)).size !== headers.length) throw new Error('Column names must be unique.');
  if (!records.length || records.length > MAX_ROWS) throw new Error('Import between 1 and 5,000 rows at a time.');
  return { headers, rows: records };
}

export function suggestEnrichmentMapping(headers: string[], entity: EnrichmentEntity): Record<string, string> {
  const aliases: Record<string, string[]> = {
    recordId: ['id', 'recordid', 'personid', 'companyid', 'twentyid', 'contactid', 'accountid'],
    matchEmail: ['existingemail', 'matchemail'], matchDomain: ['existingdomain', 'matchdomain'],
    firstName: ['firstname', 'givenname'], lastName: ['lastname', 'surname', 'familyname'], email: ['email', 'emailaddress', 'workemail', 'primaryemail'],
    phone: ['phone', 'phonenumber', 'telephone', 'mobile'], jobTitle: ['jobtitle', 'title', 'position'], linkedinUrl: ['linkedin', 'linkedinurl', 'linkedinprofile'],
    city: ['city', 'location'], domain: ['domain', 'website', 'websitedomain', 'url'], industry: ['industry', 'sector'], employees: ['employees', 'employeecount', 'headcount'], aum: ['aum', 'aumusd', 'assetsundermanagement'],
  };
  const used = new Set<string>();
  return Object.fromEntries(headers.map((header) => {
    const field = ENRICHMENT_FIELDS[entity].find((item) => !used.has(item.key) && aliases[item.key]?.includes(normalizedHeader(header)));
    if (field) used.add(field.key);
    return [header, field?.key ?? ''];
  }));
}

export function normalizeEnrichmentDomain(value: string): string {
  let url: URL;
  try { url = new URL(value.includes('://') ? value : `https://${value}`); } catch { throw new Error('Enter a valid website domain.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.') || url.port) throw new Error('Enter a valid website domain.');
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

export function validateEnrichmentValue(field: string, value: string): string | number {
  const text = value.trim();
  if (text.length > 500) throw new Error('Values must be 500 characters or shorter.');
  if (field === 'email' || field === 'matchEmail') return z.string().email('Enter a valid email address.').max(254).parse(text).toLowerCase();
  if (field === 'domain' || field === 'matchDomain') return normalizeEnrichmentDomain(text);
  if (field === 'phone') {
    const phone = text.replace(/[\s().-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('Phone numbers need an international calling code, such as +14155550123.');
    return phone;
  }
  if (field === 'linkedinUrl') {
    let url: URL;
    try { url = new URL(text); } catch { throw new Error('Enter a complete LinkedIn URL.'); }
    if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.username || url.password || url.pathname === '/') throw new Error('Enter a LinkedIn profile or company URL starting with https://.');
    return url.toString();
  }
  if (field === 'employees') {
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > 100_000_000) throw new Error('Employees must be a whole number between 0 and 100,000,000.');
    return Number(text);
  }
  if (field === 'aum') {
    const amount = text.replace(/^\$\s*/, '').replace(/,/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) > 90_000_000_000_000) throw new Error('AUM must be a USD amount with at most two decimal places; write the full amount without K/M/B suffixes.');
    const [whole, fraction = ''] = amount.split('.');
    return `${BigInt(whole).toString()}.${fraction.padEnd(2, '0')}`;
  }
  // A record's own name is the one free-text field that cannot be blanked: an account with no
  // name is unfindable, and an import row with an empty cell should say so rather than wipe it.
  if (field === 'name' && !text) throw new Error('An account name cannot be empty.');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error('Control characters are not accepted.');
  return text;
}

export async function enrichmentPeopleScope(user: SessionUser): Promise<Prisma.PersonCacheWhereInput> {
  if (isAdmin(user)) return { deletedAt: null };
  const pods = isJuniorFo(user) ? [] : await prisma.pod.findMany({ where: { id: { in: user.podIds } }, select: { podOwnerValue: true } });
  return { deletedAt: null, OR: [{ ownerMemberId: user.twentyMemberId ?? '__none__' }, { enrollments: { some: { foUserId: user.id } } }, ...(pods.length ? [{ podOwner: { in: pods.map((pod) => pod.podOwnerValue) } }] : [])] };
}

async function enrichmentCompanyScope(user: SessionUser): Promise<Prisma.CompanyCacheWhereInput> {
  if (isAdmin(user)) return { deletedAt: null };
  const people = await prisma.personCache.findMany({ where: await enrichmentPeopleScope(user), select: { companyId: true }, distinct: ['companyId'] });
  return { deletedAt: null, OR: [{ ownerMemberId: user.twentyMemberId ?? '__none__' }, { id: { in: people.map((person) => person.companyId).filter((id): id is string => !!id) } }] };
}

export type EnrichmentGap = { field: string; label: string; priority: 'critical' | 'useful' };
export type EnrichmentQueueItem = { id: string; label: string; company: string | null; entity: EnrichmentEntity; href: string; gaps: EnrichmentGap[] };
export async function enrichmentQueue(user: SessionUser) {
  const [people, companies, schema] = await Promise.all([
    prisma.personCache.findMany({ where: await enrichmentPeopleScope(user), select: { id: true, firstName: true, lastName: true, companyId: true, companyName: true, email: true, phone: true, jobTitle: true, linkedinUrl: true, city: true, tags: true, badEmail: true, badPhone: true, emailMissing: true, phoneMissing: true }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }] }),
    prisma.companyCache.findMany({ where: await enrichmentCompanyScope(user), select: { id: true, name: true, domain: true, industry: true, employees: true, city: true, aum: true, linkedinUrl: true, ownerMemberId: true }, orderBy: { name: 'asc' } }),
    getTwentySchema(),
  ]);
  const enrichmentTags = new Set(schema.personValues.needsEnrichmentTags);
  const items: EnrichmentQueueItem[] = [];
  for (const person of people) {
    const gaps: EnrichmentGap[] = [];
    if (!person.email || person.badEmail || person.emailMissing) gaps.push({ field: 'email', label: person.email ? 'Email needs verification' : 'Email missing', priority: 'critical' });
    if (!person.phone || person.badPhone || person.phoneMissing) gaps.push({ field: 'phone', label: person.phone ? 'Phone needs verification' : 'Phone missing', priority: 'critical' });
    for (const [field, label] of CONTACT_CRITICAL) if (!person[field]) gaps.push({ field, label: `${label} missing`, priority: 'critical' });
    for (const [field, label] of CONTACT_USEFUL) if (!person[field]) gaps.push({ field, label: `${label} missing`, priority: 'useful' });
    if (person.tags.some((tag) => enrichmentTags.has(tag) || /enrichment[\s_-]*(required|needed)/i.test(tag))) gaps.push({ field: 'tags', label: 'Flagged in CRM', priority: 'useful' });
    if (gaps.length) items.push({ id: person.id, label: cachedPersonName(person), company: person.companyName, entity: 'person', href: `/people/${person.id}`, gaps });
  }
  for (const company of companies) {
    const gaps: EnrichmentGap[] = [];
    for (const [field, label] of ACCOUNT_CRITICAL) if (company[field] === null || company[field] === '') gaps.push({ field, label: `${label} missing`, priority: 'critical' });
    for (const [field, label] of ACCOUNT_USEFUL) if (company[field] === null || company[field] === '') gaps.push({ field, label: `${label} missing`, priority: 'useful' });
    if (gaps.length) items.push({ id: company.id, label: company.name, company: null, entity: 'company', href: `/accounts/${company.id}`, gaps });
  }
  return items.sort((a, b) => Number(b.gaps.some((gap) => gap.priority === 'critical')) - Number(a.gaps.some((gap) => gap.priority === 'critical')) || a.label.localeCompare(b.label));
}

type ChangeValue = string | number | null;
type Patch = Record<string, ChangeValue>;
type PreviewRow = { rowNumber: number; recordId: string | null; recordLabel: string | null; input: Record<string, string>; changes: Patch; original: Patch; status: string; error: string | null };
const fieldValue = (record: Record<string, unknown>, field: string): ChangeValue => {
  if (record[field] == null) return null;
  if (field === 'aum') { try { return validateEnrichmentValue('aum', String(record[field])); } catch { return String(record[field]); } }
  if (field === 'email') return String(record[field]).trim().toLowerCase();
  if (field === 'phone') return String(record[field]).replace(/[\s().-]/g, '');
  if (field === 'domain') { try { return normalizeEnrichmentDomain(String(record[field])); } catch { return String(record[field]); } }
  return typeof record[field] === 'number' ? record[field] as number : String(record[field]);
};
const equal = (a: ChangeValue | undefined, b: ChangeValue | undefined) => (a ?? '') === (b ?? '');
const errText = (error: unknown) => error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(' ') : error instanceof Error ? error.message : 'The enrichment operation failed.';

export async function previewEnrichment(user: SessionUser, entity: EnrichmentEntity, name: string, source: string, mapping: Record<string, string>) {
  assertAllowed(canEnrich(user), 'Only a pod leader or administrator can import enrichment.');
  if (!['person', 'company'].includes(entity)) throw new Error('Choose contacts or accounts.');
  const parsed = parseEnrichmentUpload(source);
  const targets = Object.entries(mapping).filter(([header, target]) => parsed.headers.includes(header) && target);
  const fields = ENRICHMENT_FIELDS[entity];
  if (!targets.length || targets.some(([, target]) => !fields.some((field) => field.key === target)) || new Set(targets.map(([, target]) => target)).size !== targets.length) throw new Error('Map each destination field once using the available fields.');
  if (!targets.some(([, target]) => ['recordId', entity === 'person' ? 'matchEmail' : 'matchDomain', entity === 'person' ? 'email' : 'domain'].includes(target))) throw new Error('Map a Twenty ID or an existing unique email/domain to identify each record.');
  const scope = entity === 'person' ? await enrichmentPeopleScope(user) : await enrichmentCompanyScope(user);
  const records = entity === 'person' ? await prisma.personCache.findMany({ where: scope as Prisma.PersonCacheWhereInput }) : await prisma.companyCache.findMany({ where: scope as Prisma.CompanyCacheWhereInput });
  const byId = new Map(records.map((record) => [record.id, record]));
  // Identity uniqueness is checked across the cache, not only the viewer's visible pod.
  const identities = entity === 'person' ? await prisma.personCache.findMany({ where: { deletedAt: null }, select: { id: true, email: true } }) : await prisma.companyCache.findMany({ where: { deletedAt: null }, select: { id: true, domain: true } });
  const byIdentity = new Map<string, string[]>();
  for (const record of identities) {
    const raw = entity === 'person' ? (record as { email: string | null }).email?.toLowerCase() : (record as { domain: string | null }).domain;
    if (!raw) continue;
    let identity = raw;
    if (entity === 'company') { try { identity = normalizeEnrichmentDomain(raw); } catch { continue; } }
    const group = byIdentity.get(identity) ?? [];
    group.push(record.id);
    byIdentity.set(identity, group);
  }
  const rows: PreviewRow[] = parsed.rows.map((input, index) => {
    const mapped = Object.fromEntries(targets.map(([header, target]) => [target, input[header]]));
    const row: PreviewRow = { rowNumber: index + 1, recordId: null, recordLabel: null, input: mapped, changes: {}, original: {}, status: 'READY', error: null };
    try {
      const identityField = entity === 'person' ? 'matchEmail' : 'matchDomain';
      const identity = mapped[identityField] || mapped[entity === 'person' ? 'email' : 'domain'];
      const matches = mapped.recordId ? [mapped.recordId] : identity ? byIdentity.get(String(validateEnrichmentValue(identityField, identity))) ?? [] : [];
      if (matches.length > 1) throw new Error('Ambiguous match. Supply the exact Twenty record ID.');
      const record = matches.length === 1 ? byId.get(matches[0]) : null;
      if (!record) throw new Error('No matching record in your scope. Supply an existing Twenty ID or matching email/domain.');
      row.recordId = record.id;
      row.recordLabel = entity === 'person' ? cachedPersonName(record as { firstName: string; lastName: string }) : (record as { name: string }).name;
      if (mapped.recordId && mapped[identityField]) {
        const recordIdentity = entity === 'person' ? (record as { email: string | null }).email : (record as { domain: string | null }).domain;
        if (!recordIdentity || validateEnrichmentValue(identityField, recordIdentity) !== validateEnrichmentValue(identityField, mapped[identityField])) throw new Error('The supplied ID and existing email/domain identify different records.');
      }
      let conflicts = false;
      for (const field of fields.filter((item) => !item.identity)) {
        if (!mapped[field.key]?.trim()) continue; // Blank cells never erase CRM data.
        const next = validateEnrichmentValue(field.key, mapped[field.key]);
        if (field.key === (entity === 'person' ? 'email' : 'domain') && byIdentity.get(String(next))?.some((id) => id !== record.id)) throw new Error('The proposed email/domain already belongs to another CRM record.');
        const previous = fieldValue(record as unknown as Record<string, unknown>, field.key);
        if (equal(previous, next)) continue;
        row.changes[field.key] = next;
        row.original[field.key] = previous;
        if (previous !== null && previous !== '') conflicts = true;
      }
      if (!Object.keys(row.changes).length) row.status = 'NO_CHANGE';
      else if (conflicts) { row.status = 'CONFLICT'; row.error = 'Existing CRM values need review before replacement.'; }
    } catch (error) { row.status = 'INVALID'; row.error = errText(error); }
    return row;
  });
  const counts = new Map<string, number>();
  for (const row of rows) if (row.recordId) counts.set(row.recordId, (counts.get(row.recordId) ?? 0) + 1);
  for (const row of rows) if (row.recordId && counts.get(row.recordId)! > 1) { row.status = 'INVALID'; row.error = 'This record occurs more than once in the file. Merge its data into one row and import again.'; }
  const batch = await prisma.enrichmentBatch.create({ data: { entity, name: name.trim().slice(0, 200) || 'Enrichment import', createdById: user.id, rows: { createMany: { data: rows } } } });
  return batch.id;
}

export async function getEnrichmentBatch(user: SessionUser, id: string) {
  return prisma.enrichmentBatch.findFirst({ where: { id, ...(isAdmin(user) ? {} : { createdById: user.id }) }, include: { rows: { orderBy: { rowNumber: 'asc' } } } });
}

export async function reviewEnrichmentRows(user: SessionUser, batchId: string, ids: string[], decision: 'approve' | 'skip' | 'retry') {
  assertAllowed(canEnrich(user));
  const batch = await getEnrichmentBatch(user, batchId);
  assertAllowed(!!batch, 'This import is not available to you.');
  const statuses = decision === 'approve' ? ['CONFLICT'] : decision === 'retry' ? ['FAILED', 'DRY_RUN'] : ['READY', 'CONFLICT', 'FAILED', 'DRY_RUN'];
  const result = await prisma.enrichmentRow.updateMany({ where: { batchId, id: { in: ids.slice(0, MAX_ROWS) }, OR: [{ status: { in: statuses } }, ...(decision === 'retry' ? [{ status: 'APPLYING', updatedAt: { lt: new Date(Date.now() - 10 * 60_000) } }] : [])] }, data: { status: decision === 'skip' ? 'SKIPPED' : 'READY', error: null } });
  if (!result.count) throw new Error('No selected rows are ready for this action. Interrupted processing can be retried after ten minutes.');
}

/** Claim and process a small durable chunk. Closing the browser pauses between chunks. */
export async function applyEnrichmentChunk(user: SessionUser, batchId: string, client: TwentyClient) {
  assertAllowed(canEnrich(user));
  const batch = await prisma.enrichmentBatch.findFirst({ where: { id: batchId, ...(isAdmin(user) ? {} : { createdById: user.id }) } });
  assertAllowed(!!batch, 'This import is not available to you.');
  await prisma.enrichmentRow.updateMany({ where: { batchId, status: 'APPLYING', updatedAt: { lt: new Date(Date.now() - 10 * 60_000) } }, data: { status: 'FAILED', error: 'The previous attempt was interrupted. Retry to verify the CRM and resume.' } });
  const rows = await prisma.enrichmentRow.findMany({ where: { batchId, status: 'READY' }, orderBy: { rowNumber: 'asc' }, take: 10 });
  let applied = 0;
  let failed = 0;
  for (const row of rows) {
    const claimed = await prisma.enrichmentRow.updateMany({ where: { id: row.id, status: 'READY' }, data: { status: 'APPLYING', error: null } });
    if (!claimed.count) continue;
    try {
      await prisma.$transaction(async (transaction) => {
        // Serialize imports for the same CRM record, including separate batches/browser tabs.
        const locks = await transaction.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`enrichment:${batch.entity}:${row.recordId}`}, 0)) AS locked`;
        if (!locks[0]?.locked) throw new Error('Another import is updating this record. Retry after it finishes.');
        if (!row.recordId) throw new Error('The row has no matched CRM record.');
        const changes = row.changes as Patch;
        const original = row.original as Patch;
        const current = batch.entity === 'person' ? await client.getPerson(row.recordId) : (await client.listCompanies({ ids: [row.recordId], limit: 1 })).items[0];
        if (!current || current.deletedAt) throw new Error('The matched record was removed from Twenty.');
        if (batch.entity === 'person') await upsertPersonCache(current as TwentyPerson); else await upsertCompanyCache(current as TwentyCompany);
        const allowed = batch.entity === 'person' ? await prisma.personCache.count({ where: { AND: [await enrichmentPeopleScope(user), { id: row.recordId }] } }) : await prisma.companyCache.count({ where: { AND: [await enrichmentCompanyScope(user), { id: row.recordId }] } });
        assertAllowed(allowed > 0, 'This record has moved outside your scope.');
        const latest = Object.fromEntries(Object.keys(changes).map((field) => [field, fieldValue(current as unknown as Record<string, unknown>, field)]));
        const alreadyApplied = Object.keys(changes).every((field) => equal(latest[field], changes[field]));
        if (alreadyApplied && client.kind === 'dry-run') {
          await prisma.enrichmentRow.update({ where: { id: row.id }, data: { status: 'NO_CHANGE', error: null } });
          return;
        }
        if (!alreadyApplied && Object.keys(changes).some((field) => !equal(latest[field], original[field]) && !equal(latest[field], changes[field]))) {
          await prisma.enrichmentRow.update({ where: { id: row.id }, data: { status: 'CONFLICT', original: latest, error: 'CRM values changed after preview. Review the current values before replacing them.' } });
          return;
        }
        if (!alreadyApplied) {
          const updated = batch.entity === 'person' ? await client.enrichPerson(row.recordId, changes as EnrichPersonInput, current as TwentyPerson) : await client.enrichCompany(row.recordId, changes as EnrichCompanyInput, current as TwentyCompany);
          if (client.kind === 'dry-run') {
            await prisma.enrichmentRow.update({ where: { id: row.id }, data: { status: 'DRY_RUN', error: 'Write simulated. Twenty was not changed.' } });
            return;
          }
          const verified = Object.keys(changes).every((field) => equal(fieldValue(updated as unknown as Record<string, unknown>, field), changes[field]));
          if (!verified) throw new Error('Twenty returned a different value. Review the record before retrying.');
          if (batch.entity === 'person') await upsertPersonCache(updated as TwentyPerson); else await upsertCompanyCache(updated as TwentyCompany);
          await prisma.twentyWrite.create({ data: { operation: batch.entity === 'person' ? 'enrichPerson' : 'enrichCompany', objectType: batch.entity, twentyId: row.recordId, payload: { batchId, rowNumber: row.rowNumber, original, changes }, dryRun: false } });
        }
        await prisma.enrichmentRow.update({ where: { id: row.id }, data: { status: 'APPLIED', appliedAt: new Date(), error: null } });
        await prisma.auditLog.create({ data: { entityType: batch.entity, entityId: row.recordId, action: 'enriched', actorType: 'USER', actorId: user.id, actorLabel: user.name, details: { batchId, fields: Object.keys(changes) } } });
        applied++;
      }, { maxWait: 10_000, timeout: 300_000 });
    } catch (error) {
      await prisma.enrichmentRow.update({ where: { id: row.id }, data: { status: 'FAILED', error: errText(error).slice(0, 1500) } });
      failed++;
    }
    // Keep imports below Twenty's published request limit, leaving room for normal sync.
    if (client.kind === 'graphql') await new Promise((resolve) => setTimeout(resolve, 1_800));
  }
  const remaining = await prisma.enrichmentRow.count({ where: { batchId, status: 'READY' } });
  return { applied, failed, remaining };
}
