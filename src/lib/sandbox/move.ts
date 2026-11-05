import type { ActionType, Prisma, SandboxContact, SandboxMoveItem } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, SYSTEM_ACTOR, type AuditActor } from '../audit';
import { addDays, formatLocalDate, toLocalDate } from '../dates';
import { getSettings, type SandboxSettings } from '../settings';
import { getTwentyClient, type TwentyClient } from '../twenty';
import type { CreatePersonInput, TwentyCompany, TwentyIntrospection } from '../twenty/types';
import { markCompanyDeleted, markPersonDeleted, upsertCompanyCache, upsertPersonCache } from '../person-cache';
import { exitEnrollment, OCCUPYING_STATUSES } from '../engine/enrollment';
import { workspaceTimezone } from '../workspace';
import { canMoveToCrm, canUndoMove, type Actor } from '../auth/rbac';
import { crmMatch, internalOrBlocked, suppressionKeysOf } from './dedupe';
import { findSuppressed } from './suppression';
import { linkedinHref, normalizeDomain, normalizeEmail, normalizeFirmName, readExtraPhones } from './normalize';
import { checkReady, type ReadyItem } from './ready';
import { historyDrafts, writeNote } from './history-notes';
import { setSandboxNextAction } from './work';

/**
 * Move to CRM (plan section 8): one contact or up to 50. Preflight says, per contact, whether it is
 * ready, what it needs, whether Twenty already has the person, and which firm it lands on. The move
 * is queued; the worker creates the company when needed and the person, writes the history as
 * notes and hands every pointer to the new person. Each item can be undone for one year.
 */

export const MOVE_LIMIT = 50;

// ---------------------------------------------------------------------------
// Firm resolution (8.4)
// ---------------------------------------------------------------------------

export type FirmPlan =
  | { action: 'link'; companyId: string; name: string }
  | { action: 'create'; name: string }
  | { action: 'choose'; candidates: { id: string; name: string; domain: string | null }[] }
  | { action: 'blocked'; name: string }
  | { action: 'none' };

const FREE_MAIL = (domains: string[], d: string | null) => Boolean(d && domains.includes(d));

export async function resolveFirm(c: Pick<SandboxContact, 'companyName' | 'companyDomain' | 'companyWebsite' | 'companyCrd' | 'email'>, chosenCompanyId?: string | null): Promise<FirmPlan> {
  if (!c.companyName?.trim()) return { action: 'none' };
  const settings = await getSettings();
  const blocked = new Set((await prisma.blockedAccount.findMany({ select: { companyId: true } })).map((b) => b.companyId));
  const verdict = (co: { id: string; name: string }): FirmPlan => (blocked.has(co.id) ? { action: 'blocked', name: co.name } : { action: 'link', companyId: co.id, name: co.name });
  if (chosenCompanyId) {
    const chosen = await prisma.companyCache.findUnique({ where: { id: chosenCompanyId }, select: { id: true, name: true } });
    if (chosen) return verdict(chosen);
  }
  const live = { deletedAt: null };
  if (c.companyCrd) {
    const rows = await prisma.$queryRaw<{ id: string; name: string }[]>`SELECT id, name FROM "CompanyCache" WHERE "deletedAt" IS NULL AND raw->>'crd' = ${c.companyCrd} LIMIT 2`;
    if (rows.length === 1) return verdict(rows[0]);
  }
  const emailDomain = c.email ? normalizeDomain(c.email.slice(c.email.indexOf('@') + 1)) : null;
  const domain = normalizeDomain(c.companyDomain) ?? normalizeDomain(c.companyWebsite) ?? (FREE_MAIL(settings.rules.notAccountDomains, emailDomain) ? null : emailDomain);
  if (domain) {
    const byDomain = await prisma.companyCache.findMany({ where: { ...live, OR: [{ domain: { equals: domain, mode: 'insensitive' } }, { domain: { contains: `//${domain}`, mode: 'insensitive' } }, { domain: { contains: `www.${domain}`, mode: 'insensitive' } }] }, select: { id: true, name: true, domain: true } });
    const exact = byDomain.filter((co) => normalizeDomain(co.domain) === domain);
    if (exact.length === 1) return verdict(exact[0]);
    if (exact.length > 1) return { action: 'choose', candidates: exact };
  }
  const key = normalizeFirmName(c.companyName);
  const byName = (await prisma.companyCache.findMany({ where: { ...live, name: { contains: c.companyName.trim().split(/\s+/)[0], mode: 'insensitive' } }, select: { id: true, name: true, domain: true }, take: 200 }))
    .filter((co) => normalizeFirmName(co.name) === key);
  if (byName.length === 1) return verdict(byName[0]);
  if (byName.length > 1) return { action: 'choose', candidates: byName };
  return { action: 'create', name: c.companyName.trim() };
}

// ---------------------------------------------------------------------------
// Preflight (8.6 step 1)
// ---------------------------------------------------------------------------

export type PreflightItem = {
  contactId: string;
  name: string;
  state: 'ready' | 'needs' | 'attach' | 'refused';
  missing: ReadyItem[];
  reason: string | null;
  firm: FirmPlan;
  crmPerson: { id: string; name: string } | null;
  /** The contact's open next action, offered as the move's next step. */
  nextStep: MoveNextStep | null;
};

/** What happens after the move. It becomes the person's next action: in Tasks, and in Twenty. */
export type MoveNextStep = { label: string; action: ActionType; dueDate: string };

const contactInclude = { owner: { select: { id: true, name: true, twentyMemberId: true } }, pod: { select: { id: true, name: true, podOwnerValue: true } } } satisfies Prisma.SandboxContactInclude;
type MoveContact = Prisma.SandboxContactGetPayload<{ include: typeof contactInclude }>;

/**
 * The person Twenty has for this contact now. Cadence's copy is asked first, but it can still hold
 * someone Twenty no longer has: deleted or merged there since the last sync, removed by the sandbox
 * CRM cleanup, or (with the built-in fake) held by one process only. A cached hit is therefore read
 * live before the dialog offers to attach to it; a gone person is marked deleted in the copy and the
 * next match is tried. Only when Twenty cannot be reached does the copy answer on its own.
 */
export async function liveCrmPerson(client: TwentyClient | null, c: SandboxContact): Promise<{ id: string; name: string } | null> {
  const input = { bellwetherContactId: c.bellwetherContactId, firstName: c.firstName, lastName: c.lastName, email: c.email, additionalEmails: c.additionalEmails, phone: c.phone, phoneType: c.phoneType ?? 'unknown', additionalPhones: readExtraPhones(c.additionalPhones), linkedinUrl: c.linkedinUrl, individualCrd: c.individualCrd, companyName: c.companyName, companyDomain: c.companyDomain, companyCrd: c.companyCrd, companyPhone: c.companyPhone };
  for (let tries = 0; tries < 3; tries++) {
    const local = await crmMatch(input);
    if (!local) break;
    const cached = { id: local.person.id, name: `${local.person.firstName} ${local.person.lastName}`.trim() };
    if (!client) return cached;
    let live: Awaited<ReturnType<TwentyClient['getPerson']>>;
    try { live = await client.getPerson(local.person.id); } catch { return cached; }
    if (live && !live.deletedAt) return { id: live.id, name: `${live.firstName} ${live.lastName}`.trim() || cached.name };
    await markPersonDeleted(local.person.id, live?.deletedAt ? new Date(live.deletedAt) : new Date());
  }
  if (!client) return null;
  const phones = [c.phone, ...readExtraPhones(c.additionalPhones).filter((p) => p.type === 'direct' || p.type === 'mobile').map((p) => p.number)].filter((p): p is string => Boolean(p));
  const found = await client.findPeople({ emails: [c.email, ...c.additionalEmails].filter((e): e is string => Boolean(e)), phones: c.phoneType === 'direct' || c.phoneType === 'mobile' ? phones : phones.slice(1), linkedinUrls: c.linkedinUrl ? [c.linkedinUrl] : [] }).catch(() => []);
  const hit = found.find((p) => !p.deletedAt);
  return hit ? { id: hit.id, name: `${hit.firstName} ${hit.lastName}`.trim() } : null;
}

export async function preflightMove(contactIds: string[], actor: Actor): Promise<{ items: PreflightItem[]; limit: number; refused: string | null }> {
  const settings = await getSettings();
  const limit = Math.min(MOVE_LIMIT, settings.sandbox.moveBatchLimit);
  const ids = [...new Set(contactIds)];
  if (ids.length > limit) return { items: [], limit, refused: `You selected ${ids.length} contacts. Move at most ${limit} at a time.` };
  const contacts = await prisma.sandboxContact.findMany({ where: { id: { in: ids } }, include: { ...contactInclude, nextActions: { where: { personId: null, state: 'OPEN' }, select: { label: true, action: true, dueDate: true }, take: 1 } } });
  let client: TwentyClient | null = null;
  try { client = await getTwentyClient(); } catch { client = null; }
  const items: PreflightItem[] = [];
  for (const c of contacts) {
    const name = `${c.firstName} ${c.lastName}`.trim();
    const ready = checkReady(c, { owner: c.owner, podName: c.pod?.name ?? null, settings: settings.sandbox });
    const base = { contactId: c.id, name, missing: ready.missing, reason: null, firm: { action: 'none' } as FirmPlan, crmPerson: null, nextStep: c.nextActions[0] ?? null };
    if (!canMoveToCrm(actor, c)) { items.push({ ...base, state: 'refused', reason: 'Not yours to move' }); continue; }
    if (c.status !== 'ACTIVE') { items.push({ ...base, state: 'refused', reason: c.status === 'MOVED' ? 'Already in the CRM' : 'No longer in the sandbox' }); continue; }
    const dedupeInput = { bellwetherContactId: c.bellwetherContactId, firstName: c.firstName, lastName: c.lastName, email: c.email, additionalEmails: c.additionalEmails, phone: c.phone, phoneType: c.phoneType ?? 'unknown', additionalPhones: readExtraPhones(c.additionalPhones), linkedinUrl: c.linkedinUrl, individualCrd: c.individualCrd, companyName: c.companyName, companyDomain: c.companyDomain, companyCrd: c.companyCrd, companyPhone: c.companyPhone };
    if (await findSuppressed(suppressionKeysOf(dedupeInput))) { items.push({ ...base, state: 'refused', reason: 'On the suppression list' }); continue; }
    const blocked = await internalOrBlocked(dedupeInput, settings.rules);
    if (blocked) { items.push({ ...base, state: 'refused', reason: blocked.kind === 'blocked_account' ? blocked.detail : 'One of our own addresses or firms' }); continue; }
    const crmPerson = await liveCrmPerson(client, c);
    if (crmPerson) { items.push({ ...base, state: 'attach', crmPerson, missing: [] }); continue; }
    const firm = await resolveFirm(c);
    if (firm.action === 'blocked') { items.push({ ...base, firm, state: 'refused', reason: `${firm.name} is a blocked account` }); continue; }
    items.push({ ...base, firm, state: ready.ready ? 'ready' : 'needs' });
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  items.sort((a, b) => (order.get(a.contactId) ?? 0) - (order.get(b.contactId) ?? 0));
  return { items, limit, refused: null };
}

// ---------------------------------------------------------------------------
// Queue (8.6 step 2)
// ---------------------------------------------------------------------------

export type MoveSelection = { contactId: string; mode: 'create' | 'attach'; attachPersonId?: string | null; companyId?: string | null };

/**
 * The next step, when given, replaces each moved contact's open next action, for the contact's owner.
 * The move hands that next action to the person, so it shows in Tasks and is written to Twenty. A
 * person already in Twenty with an open next action keeps theirs (handOver).
 */
export async function queueMove(selection: MoveSelection[], actor: Actor, audit: AuditActor, nextStep?: MoveNextStep): Promise<{ ok: true; moveId: string; queued: number; left: { name: string; reason: string }[] } | { ok: false; error: string }> {
  const preflight = await preflightMove(selection.map((s) => s.contactId), actor);
  if (preflight.refused) return { ok: false, error: preflight.refused };
  const byId = new Map(preflight.items.map((i) => [i.contactId, i]));
  const accepted: { sel: MoveSelection; item: PreflightItem }[] = [];
  const left: { name: string; reason: string }[] = [];
  for (const sel of selection) {
    const item = byId.get(sel.contactId);
    if (!item) continue;
    if (item.state === 'refused') { left.push({ name: item.name, reason: item.reason ?? 'Cannot move' }); continue; }
    // This check, made now, decides: the dialog's answer may be minutes old, and the person it
    // offered may have left Twenty since (the cleanup, a merge). Attach goes to whoever Twenty has now.
    if (item.state === 'attach' && item.crmPerson) {
      accepted.push({ sel: { ...sel, mode: 'attach', attachPersonId: item.crmPerson.id }, item });
      continue;
    }
    if (item.state === 'needs') { left.push({ name: item.name, reason: item.missing.map((m) => m.text).join(', ') }); continue; }
    if (item.firm.action === 'choose' && !sel.companyId) { left.push({ name: item.name, reason: 'Choose which firm in Twenty' }); continue; }
    accepted.push({ sel: { ...sel, mode: 'create', attachPersonId: null }, item });
  }
  if (!accepted.length) return { ok: false, error: left.length ? `Nothing to move. ${left.map((l) => `${l.name}: ${l.reason}`).join('; ')}.` : 'Select contacts to move.' };
  const contacts = await prisma.sandboxContact.findMany({ where: { id: { in: accepted.map((a) => a.sel.contactId) } } });
  if (nextStep) for (const c of contacts) await setSandboxNextAction(c.id, { ...nextStep, foUserId: c.ownerId ?? actor.id }, { ...audit, id: actor.id });
  const snapshotOf = new Map(contacts.map((c) => [c.id, c]));
  const move = await prisma.sandboxMove.create({
    data: {
      createdById: actor.id, count: accepted.length, state: 'QUEUED',
      items: { create: accepted.map(({ sel }) => ({ sandboxContactId: sel.contactId, state: 'QUEUED', mode: sel.mode, attachPersonId: sel.mode === 'attach' ? sel.attachPersonId ?? null : null, chosenCompanyId: sel.companyId ?? null, snapshot: JSON.parse(JSON.stringify(snapshotOf.get(sel.contactId) ?? {})) })) },
    },
  });
  await logAudit({ entityType: 'sandbox_move', entityId: move.id, action: 'move_queued', actor: audit, details: { count: accepted.length, left: left.length } });
  return { ok: true, moveId: move.id, queued: accepted.length, left };
}

// ---------------------------------------------------------------------------
// The worker (8.6 step 3)
// ---------------------------------------------------------------------------

const US_STATES: Record<string, string> = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
/** "Chicago, Illinois", the form this workspace keeps its city in. */
export function cityLine(city: string | null, state: string | null): string | null {
  const s = state ? US_STATES[state.trim().toUpperCase()] ?? state.trim() : null;
  return [city?.trim(), s].filter(Boolean).join(', ') || null;
}

/** Values a select field in Twenty can hold: only options that exist; a text field takes any. */
function optionFilter(schema: TwentyIntrospection | null) {
  const person = schema?.objects.find((o) => o.nameSingular === 'person');
  return (field: string, values: string[]): string[] => {
    const info = person?.fields.find((f) => f.name === field);
    if (!info || !info.options?.length) return values;
    return values.filter((v) => info.options!.includes(v));
  };
}

export function personInput(c: MoveContact, companyId: string | null, settings: SandboxSettings, allowed: (field: string, values: string[]) => string[], fields: { leadSource: string; productInterest: string; tags: string; contactType: string; listCategory: string; pipelineStageField: string }): CreatePersonInput {
  const extra = readExtraPhones(c.additionalPhones);
  const lead = allowed(fields.leadSource, [settings.leadSource]);
  const notes = [
    `Source: ${c.source === 'BELLWETHER' ? 'Bellwether' : c.source === 'MANUAL' ? 'Cadence sandbox' : c.source.toLowerCase()}${c.sourceNote ? ` (${c.sourceNote})` : ''}`,
    ...(c.bellwetherUrl ? [`Bellwether: ${c.bellwetherUrl}`] : []),
    ...(c.individualCrd ? [`Individual CRD: ${c.individualCrd}`] : []),
    ...(c.designations.length ? [`Designations: ${c.designations.join(', ')}`] : []),
    `In the Cadence sandbox from ${formatLocalDate(toLocalDate(c.createdAt, workspaceTimezone()), 'long')}${c.pushedByEmail ? `, pushed by ${c.pushedByEmail}` : ''}`,
  ];
  return {
    firstName: c.firstName, lastName: c.lastName, email: c.email, additionalEmails: c.additionalEmails, phone: c.phone,
    additionalPhone: extra[0]?.number ?? null, linkedinUrl: linkedinHref(c.linkedinUrl), jobTitle: c.jobTitle, city: cityLine(c.city, c.state),
    companyId, assignedToMemberId: c.owner?.twentyMemberId ?? null, podOwner: c.pod?.podOwnerValue ?? null,
    leadSource: lead.length ? lead : allowed(fields.leadSource, [settings.leadSourceFallback]), leadSourceNotes: notes.join('\n'),
    productInterest: allowed(fields.productInterest, c.productInterest), tags: allowed(fields.tags, c.tags).filter((t) => t !== '' && !t.startsWith('list:')),
    contactType: allowed(fields.contactType, settings.contactType), listCategory: allowed(fields.listCategory, [settings.listCategory])[0] ?? null,
    pipelineStage: allowed(fields.pipelineStageField, [settings.pipelineStage])[0] ?? null, cadenceSandboxId: c.id,
  };
}

async function fail(item: SandboxMoveItem, error: string) {
  await prisma.sandboxMoveItem.update({ where: { id: item.id }, data: { state: 'FAILED', error: error.slice(0, 1000), attempts: { increment: 1 } } });
}

/** Hand every row of the contact to the person: touches, calls, next actions and its ended sequences. */
async function handOver(contactId: string, personId: string, actor: AuditActor, now: Date) {
  const running = await prisma.enrollment.findMany({ where: { sandboxContactId: contactId, personId: null, status: { in: OCCUPYING_STATUSES } }, select: { id: true } });
  for (const e of running) await exitEnrollment(e.id, { reason: 'moved_to_crm', actor, now });
  const personOpen = await prisma.nextAction.count({ where: { personId, state: 'OPEN' } });
  await prisma.$transaction(async (tx) => {
    await tx.touch.updateMany({ where: { sandboxContactId: contactId, personId: null }, data: { personId } });
    await tx.callLog.updateMany({ where: { sandboxContactId: contactId, personId: null }, data: { personId } });
    await tx.enrollment.updateMany({ where: { sandboxContactId: contactId, personId: null }, data: { personId } });
    // One open next action per person, as Twenty has one: the contact's goes across unless the person has one.
    if (personOpen) await tx.nextAction.updateMany({ where: { sandboxContactId: contactId, personId: null, state: 'OPEN' }, data: { state: 'CANCELLED', closedAt: now } });
    await tx.nextAction.updateMany({ where: { sandboxContactId: contactId, personId: null }, data: { personId, crmPending: true } });
  });
}

/** A claim older than this belongs to a process that died mid-item; the queue takes the item back. */
export const MOVE_CLAIM_STALE_MS = 10 * 60_000;

/**
 * Take the item for this process. The dialog's own request moves up to three at once while the
 * worker works the queue; without a claim both took the same item, each with its own Twenty client.
 */
async function claimItem(itemId: string): Promise<boolean> {
  const at = new Date();
  const stale = new Date(at.getTime() - MOVE_CLAIM_STALE_MS);
  const r = await prisma.sandboxMoveItem.updateMany({ where: { id: itemId, OR: [{ state: { in: ['QUEUED', 'FAILED'] } }, { state: 'RUNNING', claimedAt: { lt: stale } }] }, data: { state: 'RUNNING', claimedAt: at } });
  return r.count === 1;
}

/**
 * What one call of processMoveItem did. CLAIMED_ELSEWHERE: another process held the item or had
 * already finished it, so this call did nothing and counts nothing (B190). Reading the item's state
 * instead said RUNNING or DONE depending on how far the other process had got.
 */
export type MoveItemOutcome = 'DONE' | 'FAILED' | 'DRY_RUN' | 'CLAIMED_ELSEWHERE';

/** One item: idempotent, so a retry after a crash finds what the first attempt created. */
export async function processMoveItem(itemId: string, now = new Date()): Promise<MoveItemOutcome> {
  if (!(await claimItem(itemId))) return 'CLAIMED_ELSEWHERE';
  const item = await prisma.sandboxMoveItem.findUniqueOrThrow({ where: { id: itemId }, include: { move: true } });
  const contact = await prisma.sandboxContact.findUnique({ where: { id: item.sandboxContactId }, include: contactInclude });
  if (!contact || contact.status !== 'ACTIVE') { await fail(item, 'This contact is no longer in the sandbox.'); return 'FAILED'; }
  const settings = await getSettings();
  const mover = await prisma.user.findUnique({ where: { id: item.move.createdById }, select: { id: true, name: true } });
  const actor: AuditActor = mover ? { type: 'USER', id: mover.id, label: mover.name } : SYSTEM_ACTOR;
  let client: TwentyClient;
  try { client = await getTwentyClient(); } catch (err) { await fail(item, err instanceof Error ? err.message : String(err)); return 'FAILED'; }
  const dryRun = client.kind === 'dry-run';
  try {
    let personId = item.twentyPersonId;
    let companyId = item.twentyCompanyId;
    let companyAction = item.companyAction;
    let personUpdatedAt = item.personUpdatedAt;
    let mode = item.mode;
    if (mode === 'attach') {
      let person = item.attachPersonId ? await client.getPerson(item.attachPersonId) : null;
      if (!person || person.deletedAt) {
        // The person chosen at queue time has left Twenty since: whoever Twenty has for this contact
        // now, or else the move creates them, as it would have if the dialog had found nobody.
        if (item.attachPersonId) await markPersonDeleted(item.attachPersonId, person?.deletedAt ? new Date(person.deletedAt) : now);
        const other = await liveCrmPerson(client, contact);
        person = other ? await client.getPerson(other.id) : null;
      }
      if (person && !person.deletedAt) {
        personId = person.id; companyId = person.companyId; companyAction = 'none'; personUpdatedAt = person.updatedAt;
        if (person.id !== item.attachPersonId) await prisma.sandboxMoveItem.update({ where: { id: item.id }, data: { attachPersonId: person.id } });
        if (!dryRun) await upsertPersonCache(person);
      } else {
        const ready = checkReady(contact, { owner: contact.owner, podName: contact.pod?.name ?? null, settings: settings.sandbox });
        if (!ready.ready) { await fail(item, `The CRM person to attach to is no longer in Twenty, and Cadence cannot create them until the contact has ${ready.missing.map((m) => m.text.toLowerCase()).join(', ')}.`); return 'FAILED'; }
        mode = 'create';
        await prisma.sandboxMoveItem.update({ where: { id: item.id }, data: { mode, attachPersonId: null } });
      }
    }
    if (mode === 'create' && !personId) {
      // A retry first looks for the person an earlier attempt created.
      const earlier = await client.findPeople({ emails: contact.email ? [contact.email] : [], cadenceSandboxId: contact.id });
      const ours = earlier.find((p) => (p.raw as Record<string, unknown> | undefined)?.cadenceSandboxId === contact.id || (p.createdBySource === 'API' && new Date(p.createdAt) >= item.move.createdAt && normalizeEmail(p.email) === contact.email));
      const theirs = earlier.find((p) => p !== ours && !p.deletedAt);
      if (!ours && theirs) { await fail(item, `${theirs.firstName} ${theirs.lastName} is already in Twenty with this email. Attach the history to that person instead.`); return 'FAILED'; }
      if (ours) {
        personId = ours.id; companyId = ours.companyId; personUpdatedAt = ours.updatedAt; companyAction = companyAction ?? (ours.companyId ? 'linked' : 'none');
      } else {
        const firm = await resolveFirm(contact, item.chosenCompanyId);
        if (firm.action === 'blocked') { await fail(item, `${firm.name} is a blocked account.`); return 'FAILED'; }
        if (firm.action === 'choose') { await fail(item, 'Several firms in Twenty match. Choose one and retry.'); return 'FAILED'; }
        if (firm.action === 'link') { companyId = firm.companyId; companyAction = 'linked'; }
        if (firm.action === 'create') {
          const liveCo: TwentyCompany | undefined = (await client.findCompanies({ domain: contact.companyDomain, name: contact.companyName })).find((co) => !co.deletedAt);
          if (liveCo) { companyId = liveCo.id; companyAction = 'linked'; if (!dryRun) await upsertCompanyCache(liveCo); }
          else {
            const created = await client.createCompany({ name: firm.name, domain: contact.companyDomain, city: contact.companyCity ?? contact.city, state: contact.companyState ?? contact.state, employees: contact.companyEmployees, aum: contact.companyAumUsd ? contact.companyAumUsd.toFixed(0) : null, linkedinUrl: null, crd: contact.companyCrd });
            companyId = created.id; companyAction = 'created';
            if (!dryRun) await upsertCompanyCache(created);
            await prisma.sandboxMoveItem.update({ where: { id: item.id }, data: { twentyCompanyId: companyId, companyAction } });
          }
        }
        if (firm.action === 'none') companyAction = 'none';
        const schema = await client.introspect().catch(() => null);
        const p = (await import('../twenty/twenty-schema')).defaultTwentySchema.person;
        const created = await client.createPerson(personInput(contact, companyId, settings.sandbox, optionFilter(schema), { leadSource: p.leadSource, productInterest: p.productInterest, tags: p.tags, contactType: p.contactType, listCategory: p.listCategory, pipelineStageField: p.pipelineStageField }));
        personId = created.id; personUpdatedAt = created.updatedAt;
        // Stored at once, so a crash after this point retries without a second person.
        await prisma.sandboxMoveItem.update({ where: { id: item.id }, data: { twentyPersonId: personId, twentyCompanyId: companyId, companyAction, personUpdatedAt } });
        if (!dryRun) await upsertPersonCache(created);
      }
    }
    if (dryRun) {
      await prisma.sandboxMoveItem.update({ where: { id: item.id }, data: { state: 'DRY_RUN', twentyPersonId: null, twentyCompanyId: null, companyAction, error: 'Dry run: nothing was written to Twenty and the contact stays in the sandbox.', doneAt: now, attempts: { increment: 1 } } });
      return 'DRY_RUN';
    }
    await handOver(contact.id, personId!, actor, now);
    const notes: string[] = [...item.notesWritten];
    if (!notes.length) {
      for (const d of await historyDrafts(contact.id)) {
        const id = await writeNote(client, { title: d.title, bodyMarkdown: d.bodyMarkdown, personId, companyId }, { moveItemId: item.id });
        if (id) notes.push(id);
      }
      await prisma.sandboxNote.updateMany({ where: { sandboxContactId: contact.id }, data: { twentyNoteId: 'moved' } });
    }
    await prisma.sandboxContact.update({ where: { id: contact.id }, data: { status: 'MOVED', movedAt: now, movedById: item.move.createdById, twentyPersonId: personId, twentyCompanyId: companyId, statusChangedAt: now } });
    await prisma.sandboxMoveItem.update({ where: { id: item.id }, data: { state: 'DONE', twentyPersonId: personId, twentyCompanyId: companyId, companyAction, notesWritten: notes, personUpdatedAt, error: null, doneAt: now, undoUntil: new Date(now.getTime() + settings.sandbox.undoDays * 86_400_000), attempts: { increment: 1 } } });
    await logAudit({ entityType: 'sandbox_contact', entityId: contact.id, action: 'sandbox_moved', actor, details: { moveId: item.moveId, personId, companyId, companyAction, mode, notes: notes.length } });
    return 'DONE';
  } catch (err) {
    await fail(item, err instanceof Error ? err.message : String(err));
    return 'FAILED';
  }
}

/** Every tick: queued items one at a time, paced under Twenty's 100 requests a minute. */
export async function runMoveQueue(opts: { now?: Date; maxItems?: number; pauseMs?: number } = {}): Promise<{ done: number; failed: number; dryRun: number }> {
  const stats = { done: 0, failed: 0, dryRun: 0 };
  const stale = new Date(Date.now() - MOVE_CLAIM_STALE_MS);
  const items = await prisma.sandboxMoveItem.findMany({ where: { OR: [{ state: 'QUEUED' }, { state: 'RUNNING', claimedAt: { lt: stale } }] }, orderBy: [{ move: { createdAt: 'asc' } }, { id: 'asc' }], take: opts.maxItems ?? 12, select: { id: true, moveId: true } });
  const moves = new Set(items.map((i) => i.moveId));
  if (moves.size) await prisma.sandboxMove.updateMany({ where: { id: { in: [...moves] }, state: 'QUEUED' }, data: { state: 'RUNNING' } });
  for (const i of items) {
    const state = await processMoveItem(i.id, opts.now);
    // Another process holds it (the dialog's own request) and counts it there.
    if (state === 'CLAIMED_ELSEWHERE') continue;
    if (state === 'DONE') stats.done++; else if (state === 'DRY_RUN') stats.dryRun++; else stats.failed++;
    if (opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs));
  }
  for (const id of moves) await finishMoveIfSettled(id, opts.now ?? new Date());
  return stats;
}

/** A move is done when none of its items waits or runs. */
export async function finishMoveIfSettled(moveId: string, now = new Date()): Promise<void> {
  if (await prisma.sandboxMoveItem.count({ where: { moveId, state: { in: ['QUEUED', 'RUNNING'] } } })) return;
  await prisma.sandboxMove.updateMany({ where: { id: moveId, state: { not: 'DONE' } }, data: { state: 'DONE', finishedAt: now } });
}

export async function retryFailedItems(moveId: string): Promise<number> {
  const r = await prisma.sandboxMoveItem.updateMany({ where: { moveId, state: 'FAILED' }, data: { state: 'QUEUED' } });
  if (r.count) await prisma.sandboxMove.update({ where: { id: moveId }, data: { state: 'QUEUED', finishedAt: null } });
  return r.count;
}

// ---------------------------------------------------------------------------
// Undo (8.7)
// ---------------------------------------------------------------------------

export type UndoResult = { ok: true; message: string } | { ok: false; error: string };

export function undoClosesOn(item: Pick<SandboxMoveItem, 'doneAt'>, settings: SandboxSettings): Date | null {
  return item.doneAt ? new Date(item.doneAt.getTime() + settings.undoDays * 86_400_000) : null;
}

export async function undoMoveItem(itemId: string, actor: Actor, audit: AuditActor, now = new Date()): Promise<UndoResult> {
  const settings = await getSettings();
  const item = await prisma.sandboxMoveItem.findUnique({ where: { id: itemId }, include: { move: true } });
  if (!item) return { ok: false, error: 'Move not found.' };
  if (item.state !== 'DONE') return { ok: false, error: item.state === 'UNDONE' ? 'This move was already undone.' : 'Only a finished move can be undone.' };
  const closes = undoClosesOn(item, settings.sandbox);
  if (closes && now > closes) return { ok: false, error: `This move can no longer be undone: the one-year window closed on ${formatLocalDate(toLocalDate(closes, workspaceTimezone()), 'long')}.` };
  const contact = await prisma.sandboxContact.findUnique({ where: { id: item.sandboxContactId } });
  if (!contact || contact.status !== 'MOVED' || contact.piiClearedAt) return { ok: false, error: 'This contact can no longer be restored to the sandbox.' };
  if (!canUndoMove(actor, { movedById: contact.movedById, podId: contact.podId })) return { ok: false, error: 'Only the person who moved it, the Senior FOs, Sales Leaders and Pod Managers of its pod, and admins can undo this move.' };
  const personId = item.twentyPersonId!;
  const client = await getTwentyClient();
  const person = await client.getPerson(personId);
  if (item.mode === 'create' && person && !person.deletedAt) {
    if (item.personUpdatedAt && person.updatedAt !== item.personUpdatedAt) return { ok: false, error: `Someone changed this person in Twenty on ${formatLocalDate(toLocalDate(new Date(person.updatedAt), workspaceTimezone()), 'long')}, so the move is kept. Change it back in Twenty, or keep the person there.` };
    const ours = new Set([...item.notesWritten.map((id) => `note:${id}`)]);
    const newer = await prisma.touch.findFirst({ where: { personId, sandboxContactId: null, createdAt: { gt: item.doneAt! }, NOT: { externalId: { in: [...ours] } } }, select: { summary: true, occurredAt: true } });
    if (newer) return { ok: false, error: `This person has activity in the CRM since the move (${newer.summary}), so the move is kept.` };
    if (await prisma.enrollment.count({ where: { personId, sandboxContactId: null } })) return { ok: false, error: 'This person has been put in a CRM campaign since the move, so the move is kept.' };
  }
  const retried = await prisma.$queryRaw<{ twentyId: string }[]>`SELECT "twentyId" FROM "TwentyWrite" WHERE operation = 'createNote' AND "twentyId" IS NOT NULL AND payload->>'cadenceMoveItemId' = ${item.id}`;
  const noteIds = [...new Set([...item.notesWritten, ...retried.map((r) => r.twentyId)])];
  for (const id of noteIds) await client.deleteNote(id).catch(() => undefined);
  if (item.mode === 'create') {
    if (person && !person.deletedAt) await client.deletePerson(personId);
    await markPersonDeleted(personId, now);
    if (item.companyAction === 'created' && item.twentyCompanyId) {
      const others = (await client.listPeople({ companyId: item.twentyCompanyId, limit: 5 })).items.filter((p) => p.id !== personId && !p.deletedAt);
      if (!others.length) { await client.deleteCompany(item.twentyCompanyId); await markCompanyDeleted(item.twentyCompanyId, now); }
    }
  }
  await prisma.$transaction(async (tx) => {
    // Only the rows that came from this contact go back; the person's own CRM rows stay.
    const fromContact = { sandboxContactId: contact.id, personId };
    await tx.touch.updateMany({ where: fromContact, data: { personId: null } });
    await tx.callLog.updateMany({ where: fromContact, data: { personId: null } });
    await tx.enrollment.updateMany({ where: fromContact, data: { personId: null } });
    await tx.nextAction.updateMany({ where: fromContact, data: { personId: null, crmPending: false } });
    // An opt-out made while the person was in the CRM holds in the sandbox too.
    await tx.sandboxContact.update({ where: { id: contact.id }, data: { status: contact.optedOutAt ? 'OPTED_OUT' : 'ACTIVE', movedAt: null, movedById: null, twentyPersonId: null, twentyCompanyId: null, statusChangedAt: now } });
    await tx.sandboxNote.updateMany({ where: { sandboxContactId: contact.id }, data: { twentyNoteId: null } });
    await tx.sandboxMoveItem.update({ where: { id: item.id }, data: { state: 'UNDONE', undoneAt: now, undoneById: actor.id } });
  });
  await logAudit({ entityType: 'sandbox_contact', entityId: contact.id, action: 'move_undone', actor: audit, details: { moveId: item.moveId, personId, mode: item.mode, notesDeleted: noteIds.length } });
  return { ok: true, message: item.mode === 'attach' ? 'Undone. The notes were taken off the CRM person and the contact is back in the sandbox.' : 'Undone. The person was removed from Twenty and the contact is back in the sandbox.' };
}

/** The last day a move made today can be undone, for the dialog. */
export const undoUntil = (today: string, settings: SandboxSettings) => addDays(today, settings.undoDays);
