import type { ActionType, NextActionKind, NextActionRepeat, Prisma, SandboxContact, SandboxMoveItem } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, SYSTEM_ACTOR, type AuditActor } from '../audit';
import { addDays, formatLocalDate, toLocalDate } from '../dates';
import { getSettings, type SandboxSettings } from '../settings';
import { getTwentyClient, type TwentyClient } from '../twenty';
import type { CreatePersonInput, TwentyCompany, TwentyIntrospection } from '../twenty/types';
import { markCompanyDeleted, markPersonDeleted, upsertCompanyCache, upsertPersonCache } from '../person-cache';
import { cancelOpenTasks, isUniqueViolation, syncCancelled } from '../engine/tasks';
import { afterResponse } from '../engine/sync-out';
import { pushNextAction } from '../next-actions';
import { workspaceTimezone } from '../workspace';
import { canUndoMove, whyNotUndoMove, type Actor } from '../auth/rbac';
import { ACTION_LABELS } from '../sequences/steps';
import { coldMoveHref, coldRef } from '../subject';
import { canAct, refuse, RefusedError, withSubjectLock, type ColdSubject } from '../outreach/guard';
import { contactability } from '../outreach/contactability';
import { optOutPerson, type OptOutSource } from '../outreach/transitions';
import { ownStamps } from '../twenty/own-writes';
import { crmMatches, internalOrBlocked, refreshCrmCopyFor, type DedupeInput } from './dedupe';
import { linkedinHref, normalizeDomain, normalizeEmail, normalizeFirmName, readExtraPhones } from './normalize';
import { checkReady, moveSignals, type ReadyItem } from './ready';
import { historyDrafts, writeNote } from './history-notes';

/**
 * Move to CRM (cold outreach PLAN 4.5 and 8.6, W5): one contact or up to 50. The order of work is
 * the fix:
 *   1. Preflight: one batched CRM lookup (B112); per contact, which group it is in (needs info,
 *      already in the CRM, ready, no conversation yet, left out) and one line per thing the move
 *      will do. A shared office line never attaches by itself (B006); a CRM person another contact
 *      already points to is refused; contactability runs for every contact (N003).
 *   2. Queue: the database keeps one move in flight per contact (B005). Nothing on the contact
 *      changes: the step it will get and its own next step are stored on the item (B034).
 *   3. Worker: the checks again (active, owner still here N017, not suppressed or Do not contact,
 *      the person not taken); the CRM firm, then the person, idempotent on cadenceSandboxId; then
 *      one local transaction that completes only if the contact is still ACTIVE (N001); history
 *      notes last, each once, by key.
 *   4. Failures are transient or permanent, in plain words (B100); Retry runs the checks again and
 *      leaves permanent ones (B036, B105).
 *   5. Undo: the person first, then the notes; the CRM person's own Next Action and the contact's
 *      own next step come back (B097, B034); campaigns are offered back (B101); a firm the move
 *      created goes with its last person (B111); a partial undo says what is left (B113).
 * Reports never change: every row keeps the audience it was stamped with (8.4).
 */

export const MOVE_LIMIT = 50;

/** Item states of a move still to happen. At most one per contact (SandboxMoveItem_one_in_flight_per_contact, B005). */
export const IN_FLIGHT = ['QUEUED', 'RUNNING'] as const;

const day = (d: Date) => formatLocalDate(toLocalDate(d, workspaceTimezone()), 'year');

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

/** Where a contact sits in the Move dialog (4.5). */
export type MoveGroup = 'needs' | 'in_crm' | 'ready' | 'no_conversation' | 'left_out';

/** What happens after the move: it becomes the person's next action, in Tasks and in the CRM. */
export type MoveNextStep = { label: string; action: ActionType; dueDate: string; repeat?: NextActionRepeat; kind?: NextActionKind; meetingAt?: string | null };

/** The CRM person a contact matched, as the dialog's card shows them (B107). */
export type CrmCard = {
  id: string; name: string; email: string | null; company: string | null; ownerName: string | null; podName: string | null;
  nextAction: string | null; nextActionDueDate: string | null;
  /** What matched: "email", "LinkedIn" or "phone". */
  matchedOn: string;
  /** Matched only on an office or unknown line, which colleagues share: never attached by itself (B006). */
  sharedLine: boolean;
};

export type PreflightItem = {
  contactId: string;
  name: string;
  group: MoveGroup;
  /** Needs info: what is missing, an owner who has left included (N017). */
  missing: ReadyItem[];
  /** Readiness warnings (B104): no title, LinkedIn, city, risky email, product. */
  warnings: ReadyItem[];
  /** Left out: why, in plain words; who may do it when it is a permission (B106). */
  reason: string | null;
  firm: FirmPlan;
  crmPerson: CrmCard | null;
  /** The contact's own open next step, which the move keeps (B034). */
  ownStep: MoveNextStep | null;
  /** The running campaigns the move ends, by name (B110). */
  endsCampaigns: string[];
  /** The email bounced: it goes to the CRM flagged (N018). */
  bouncedOn: string | null;
  /** One line per thing the move will do: "Creates firm Harbor Light (for 2 contacts)", "Ends Q4 Harbor", "Keeps Call Thu, 5 Nov 2026". */
  plan: string[];
  /** D3: the positive outcome behind "Ready to move", in words. */
  signal: string | null;
  ownerId: string | null;
  ownerName: string | null;
  podId: string | null;
};

export type MoveCounts = Record<MoveGroup, number>;
export type Preflight = { items: PreflightItem[]; limit: number; refused: string | null; counts: MoveCounts };

const contactInclude = {
  owner: { select: { id: true, name: true, active: true, twentyMemberId: true } },
  pod: { select: { id: true, name: true, podOwnerValue: true } },
} satisfies Prisma.SandboxContactInclude;
type MoveContact = Prisma.SandboxContactGetPayload<{ include: typeof contactInclude }>;

export const dedupeInputOf = (c: SandboxContact): DedupeInput => ({
  bellwetherContactId: c.bellwetherContactId, firstName: c.firstName, lastName: c.lastName, email: c.email, additionalEmails: c.additionalEmails, phone: c.phone,
  phoneType: c.phoneType ?? 'unknown', additionalPhones: readExtraPhones(c.additionalPhones), linkedinUrl: c.linkedinUrl, individualCrd: c.individualCrd,
  companyName: c.companyName, companyDomain: c.companyDomain, companyCrd: c.companyCrd, companyPhone: c.companyPhone,
});

const subjectOf = (c: MoveContact, moving: boolean): ColdSubject => ({
  kind: 'cold', id: c.id, status: c.status, name: `${c.firstName} ${c.lastName}`.trim(), ownerId: c.ownerId, ownerName: c.owner?.name ?? null, ownerActive: c.owner?.active ?? false,
  podId: c.podId, podName: c.pod?.name ?? null, twentyPersonId: c.twentyPersonId, movedById: c.movedById, optedOutAt: c.optedOutAt, optOutSource: c.optOutSource,
  crmMatchPersonId: c.crmMatchPersonId, crmAutoPersonId: c.crmAutoPersonId, moving,
});

/**
 * B112: the dialog's batched CRM lookup is reused by the queue a moment later instead of asking the
 * CRM again; a contact edited since (its updatedAt) is asked again. Two minutes, in this process.
 */
const LOOKUP_TTL_MS = 2 * 60_000;
const lookedUp = new Map<string, number>();
const lookupKey = (c: SandboxContact) => `${c.id}:${c.updatedAt.getTime()}`;

/** Ask the CRM itself about these contacts, in one batched lookup, unless it was asked a moment ago. False when it did not answer. */
async function refreshCrm(client: TwentyClient | null, contacts: SandboxContact[]): Promise<boolean> {
  const now = Date.now();
  for (const [k, at] of lookedUp) if (now - at > LOOKUP_TTL_MS) lookedUp.delete(k);
  const stale = contacts.filter((c) => !lookedUp.has(lookupKey(c)));
  if (!client || !stale.length) return true;
  const r = await refreshCrmCopyFor(stale.map(dedupeInputOf), client);
  if (!r) return false;
  for (const c of stale) lookedUp.set(lookupKey(c), now);
  return true;
}

/** The CRM person this contact is, as the move may use them: never one on a shared line by itself, nor one another contact already points to. */
async function crmCandidates(c: SandboxContact): Promise<{ card: CrmCard | null; taken: { name: string; by: string } | null; dnc: string | null }> {
  const matches = await crmMatches(dedupeInputOf(c));
  if (!matches.length) return { card: null, taken: null, dnc: null };
  const own = matches.find((m) => !m.sharedLine) ?? null;
  const pick = own ?? matches[0];
  const p = await prisma.personCache.findUnique({ where: { id: pick.person.id } });
  if (!p) return { card: null, taken: null, dnc: null };
  const name = `${p.firstName} ${p.lastName}`.trim() || p.email || 'This person';
  // N003: the same person is Do not contact in the CRM: never moved onto, never created again.
  if (own && (p.dnd || p.optedOut)) return { card: null, taken: null, dnc: `${name} is marked Do not contact in the CRM` };
  const other = await prisma.sandboxContact.findFirst({ where: { twentyPersonId: p.id, id: { not: c.id } }, select: { firstName: true, lastName: true } });
  if (other) {
    // B006: one CRM person, one contact. On a shared line that is simply someone else: create.
    if (!own) return { card: null, taken: null, dnc: null };
    return { card: null, taken: { name, by: `${other.firstName} ${other.lastName}`.trim() }, dnc: null };
  }
  const [owner, pod] = await Promise.all([
    p.ownerMemberId ? prisma.user.findFirst({ where: { twentyMemberId: p.ownerMemberId }, select: { name: true } }) : null,
    p.podOwner ? prisma.pod.findFirst({ where: { podOwnerValue: p.podOwner }, select: { name: true } }) : null,
  ]);
  return {
    card: { id: p.id, name, email: p.email, company: p.companyName, ownerName: owner?.name ?? null, podName: pod?.name ?? null, nextAction: p.nextAction, nextActionDueDate: p.nextActionDueDate, matchedOn: pick.matchedOn === 'linkedin_url' ? 'LinkedIn' : pick.matchedOn, sharedLine: !own },
    taken: null, dnc: null,
  };
}

const LEFT_WORDS: Partial<Record<string, string>> = { opted_out: 'Opted out', removed: 'Removed', moved: 'Already in the CRM', moving: 'Being moved already', already_opted_out: 'Opted out' };

/** "Call Thu, 5 Nov 2026". */
const stepWords = (s: MoveNextStep) => `${ACTION_LABELS[s.action] ?? s.action} ${formatLocalDate(s.dueDate, 'long')}`;

export async function preflightMove(contactIds: string[], actor: Actor): Promise<Preflight> {
  const settings = await getSettings();
  const limit = Math.min(MOVE_LIMIT, settings.sandbox.moveBatchLimit);
  const ids = [...new Set(contactIds)];
  const counts: MoveCounts = { needs: 0, in_crm: 0, ready: 0, no_conversation: 0, left_out: 0 };
  if (ids.length > limit) return { items: [], limit, refused: `You selected ${ids.length} contacts. Move at most ${limit} at a time.`, counts };
  const contacts = await prisma.sandboxContact.findMany({
    where: { id: { in: ids } },
    include: {
      ...contactInclude,
      nextActions: { where: { personId: null, state: 'OPEN' }, select: { label: true, action: true, dueDate: true, repeat: true, kind: true, meetingAt: true }, take: 1 },
      enrollments: { where: { personId: null, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { campaign: { select: { name: true } }, sequence: { select: { name: true } } } },
      emails: { where: { kind: 'BOUNCE' }, orderBy: { at: 'desc' }, take: 1, select: { at: true } },
      calls: { where: { formDueAt: { not: null }, formDoneAt: null, discardedAt: null }, orderBy: { startedAt: 'asc' }, take: 1, select: { startedAt: true, createdAt: true, user: { select: { name: true } } } },
    },
  });
  const inFlight = new Set((await prisma.sandboxMoveItem.findMany({ where: { sandboxContactId: { in: ids }, state: { in: [...IN_FLIGHT] } }, select: { sandboxContactId: true } })).map((i) => i.sandboxContactId));
  let client: TwentyClient | null = null;
  try { client = await getTwentyClient(); } catch { client = null; }
  // B112: one batched lookup for every contact that could move, not one per contact; a failure is
  // never read as "not in the CRM".
  const live = contacts.filter((c) => c.status === 'ACTIVE' && !inFlight.has(c.id));
  if (!(await refreshCrm(client, live))) return { items: [], limit, refused: 'The CRM did not answer, so Cadence cannot tell who is in it already. Nothing was moved; try again in a minute.', counts };
  const signals = await moveSignals(live.map((c) => c.id));
  const items: PreflightItem[] = [];
  for (const c of contacts) {
    const name = `${c.firstName} ${c.lastName}`.trim() || 'Removed contact';
    const ready = checkReady(c, { owner: c.owner, podName: c.pod?.name ?? null, settings: settings.sandbox });
    const own = c.nextActions[0];
    const base: PreflightItem = {
      contactId: c.id, name, group: 'left_out', missing: [], warnings: ready.warnings, reason: null, firm: { action: 'none' }, crmPerson: null,
      ownStep: own ? { label: own.label, action: own.action, dueDate: own.dueDate, repeat: own.repeat, kind: own.kind, meetingAt: own.meetingAt?.toISOString() ?? null } : null,
      endsCampaigns: c.enrollments.map((e) => e.campaign?.name ?? e.sequence.name), bouncedOn: c.badEmail ? (c.emails[0] ? day(c.emails[0].at) : '') : null,
      plan: [], signal: signals.get(c.id)?.positive ?? null, ownerId: c.ownerId, ownerName: c.owner?.name ?? null, podId: c.podId,
    };
    const leave = (reason: string) => items.push({ ...base, group: 'left_out', reason });
    // The guard: status, a move in flight (B005), role and ownership, with who may do it (B106).
    const verdict = canAct(actor, subjectOf(c, inFlight.has(c.id)), 'move');
    if (!verdict.ok) { leave(LEFT_WORDS[verdict.code] ?? verdict.reason); continue; }
    // Contactability for a move (8.2): suppressed or Do not contact are left out (N003).
    const check = await contactability({ kind: 'cold', row: c }, { act: 'move' });
    if (!check.ok) { leave(check.reason.replace(/\.$/, '')); continue; }
    // B103: a call whose form is waiting goes to the CRM only once the form is in.
    const call = c.calls[0];
    if (call) { leave(`${call.user?.name ?? 'A rep'}'s call on ${day(call.startedAt ?? call.createdAt)} is waiting for its form. Fill it in first, so the call goes to the CRM`); continue; }
    const blocked = await internalOrBlocked(dedupeInputOf(c), settings.rules);
    if (blocked) { leave(blocked.kind === 'blocked_account' ? blocked.detail.replace(/\.$/, '') : 'One of our own addresses or firms'); continue; }
    const crm = await crmCandidates(c);
    if (crm.dnc) { leave(crm.dnc); continue; }
    if (crm.taken) { leave(`${crm.taken.name} in the CRM is already linked to ${crm.taken.by}. Two contacts cannot both move onto one person; ask an admin`); continue; }
    if (crm.card && !crm.card.sharedLine) {
      // Already in the CRM: the history goes to them, whatever details are missing here; only an
      // owner is needed, one still at Cadence (N017), whose step the person gets.
      const owner = ready.missing.filter((m) => m.key === 'owner');
      items.push(owner.length ? { ...base, group: 'needs', missing: owner, crmPerson: crm.card } : { ...base, group: 'in_crm', crmPerson: crm.card });
      continue;
    }
    const firm = await resolveFirm(c);
    if (firm.action === 'blocked') { leave(`${firm.name} is a blocked account`); continue; }
    const group: MoveGroup = !ready.ready ? 'needs' : base.signal ? 'ready' : 'no_conversation';
    items.push({ ...base, group, missing: ready.missing, firm, crmPerson: crm.card });
  }
  // B111: firms created for several contacts of this move are named once, with how many.
  const creates = new Map<string, number>();
  for (const i of items) if ((i.group === 'ready' || i.group === 'no_conversation') && i.firm.action === 'create') creates.set(normalizeFirmName(i.firm.name) ?? i.firm.name, (creates.get(normalizeFirmName(i.firm.name) ?? i.firm.name) ?? 0) + 1);
  for (const i of items) {
    counts[i.group]++;
    if (i.group === 'left_out' || i.group === 'needs') continue;
    const n = i.firm.action === 'create' ? creates.get(normalizeFirmName(i.firm.name) ?? i.firm.name) ?? 1 : 0;
    i.plan = [
      i.group === 'in_crm' && i.crmPerson ? `Adds history to ${i.crmPerson.name}, who is in the CRM` : i.firm.action === 'link' ? `Links to firm ${i.firm.name}` : i.firm.action === 'create' ? `Creates firm ${i.firm.name}${n > 1 ? ` (for ${n} contacts)` : ''}` : i.firm.action === 'choose' ? 'Several firms in the CRM match: choose one' : 'No firm',
      ...(i.endsCampaigns.length ? [`Ends ${i.endsCampaigns.join(', ')}`] : []),
      i.group === 'in_crm' && i.crmPerson?.nextAction ? `Keeps ${i.crmPerson.name}'s own Next Action` : i.ownStep ? `Keeps ${stepWords(i.ownStep)}` : 'Gets the next step below',
      ...(i.bouncedOn !== null ? [`Email bounced${i.bouncedOn ? ` on ${i.bouncedOn}` : ''}: it goes to the CRM flagged`] : []),
    ];
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { items, limit, refused: null, counts };
}

// ---------------------------------------------------------------------------
// Queue (8.6 step 2)
// ---------------------------------------------------------------------------

export type MoveSelection = {
  contactId: string;
  /** "attach" to the dialog's CRM person; "create" a new one ("Not the same person", or a shared line declined). */
  mode?: 'create' | 'attach';
  attachPersonId?: string | null;
  /** The firm chosen when several in the CRM match. */
  companyId?: string | null;
  /** D3: moved with no conversation yet, after the dialog's one extra confirm. */
  noConversation?: boolean;
};

export type LeftOut = { contactId: string; name: string; reason: string };
export type QueueResult = { ok: true; moveId: string; queued: number; left: LeftOut[] } | { ok: false; error: string };

/**
 * Queue the move. Nothing on the contact changes here (B034): the step it will get (its own, or the
 * dialog's when it has none) and its own open next step are stored on the item, and applied or put
 * back by the worker and Undo. The checks run again now, on the batched lookup the dialog made.
 */
export async function queueMove(selection: MoveSelection[], actor: Actor, audit: AuditActor, nextStep?: MoveNextStep | null, opts: { /** The dialog's rule (4.0, no dead ends): a contact with no step of its own needs the dialog's. */ requireStep?: boolean } = {}): Promise<QueueResult> {
  const pre = await preflightMove(selection.map((s) => s.contactId), actor);
  if (pre.refused) return { ok: false, error: pre.refused };
  const byId = new Map(pre.items.map((i) => [i.contactId, i]));
  const accepted: { sel: Required<Pick<MoveSelection, 'contactId' | 'mode'>> & { attachPersonId: string | null; companyId: string | null; declined: string | null }; item: PreflightItem; step: MoveNextStep | null }[] = [];
  const left: LeftOut[] = [];
  const own = new Map((await prisma.nextAction.findMany({ where: { sandboxContactId: { in: selection.map((s) => s.contactId) }, personId: null, state: 'OPEN' } })).map((n) => [n.sandboxContactId!, n]));
  const contacts = new Map((await prisma.sandboxContact.findMany({ where: { id: { in: selection.map((s) => s.contactId) } } })).map((c) => [c.id, c]));
  for (const sel of selection) {
    const item = byId.get(sel.contactId);
    if (!item) continue;
    const out = (reason: string) => left.push({ contactId: item.contactId, name: item.name, reason });
    if (item.group === 'left_out') { out(item.reason ?? 'Cannot move'); continue; }
    if (item.group === 'needs') { out(`Needs ${item.missing.map((m) => m.text.toLowerCase()).join(', ')}`); continue; }
    if (item.group === 'no_conversation' && !sel.noConversation) { out('No conversation yet: tick it in the dialog to move it anyway'); continue; }
    let mode: 'create' | 'attach' = 'create';
    let attachPersonId: string | null = null;
    let declined: string | null = null;
    if (item.crmPerson) {
      const choseAttach = sel.mode === 'attach' && (!sel.attachPersonId || sel.attachPersonId === item.crmPerson.id);
      // B006: a shared line attaches only when the dialog said so; a real match unless "Not the same person".
      if (item.crmPerson.sharedLine ? choseAttach : sel.mode !== 'create') { mode = 'attach'; attachPersonId = item.crmPerson.id; } else declined = item.crmPerson.id;
    }
    if (mode === 'create' && item.group === 'in_crm') {
      // "Not the same person": created as a new person, so the contact's own details must be complete.
      const ready = checkReady(contacts.get(item.contactId)!, { owner: item.ownerId ? await prisma.user.findUnique({ where: { id: item.ownerId }, select: { name: true, active: true, twentyMemberId: true } }) : null, podName: null, settings: (await getSettings()).sandbox });
      if (!ready.ready) { out(`Needs ${ready.missing.map((m) => m.text.toLowerCase()).join(', ')} before it can be created as a new person`); continue; }
      item.firm = await resolveFirm(contacts.get(item.contactId)!);
    }
    if (mode === 'create' && item.firm.action === 'choose' && !sel.companyId) { out('Choose which firm in the CRM'); continue; }
    const mine = own.get(item.contactId);
    const step: MoveNextStep | null = mine ? { label: mine.label, action: mine.action, dueDate: mine.dueDate, repeat: mine.repeat, kind: mine.kind, meetingAt: mine.meetingAt?.toISOString() ?? null } : nextStep ?? null;
    if (!step && opts.requireStep && !(mode === 'attach' && item.crmPerson?.nextAction)) { out('It has no next step of its own: give one in the dialog'); continue; }
    // N018: no Email step to an address that bounced.
    if (step?.action === 'EMAIL' && contacts.get(item.contactId)?.badEmail) { out('Its email bounced: choose another way for the next step'); continue; }
    accepted.push({ sel: { contactId: item.contactId, mode, attachPersonId, companyId: sel.companyId ?? null, declined }, item, step });
  }
  if (!accepted.length) return { ok: false, error: left.length ? `Nothing to move. ${left.map((l) => `${l.name}: ${l.reason}`).join('; ')}.` : 'Select contacts to move.' };
  let move: { id: string };
  try {
    move = await prisma.sandboxMove.create({
      data: {
        createdById: actor.id, count: accepted.length, state: 'QUEUED', leftOut: left as unknown as Prisma.InputJsonValue, nextStep: nextStep ? (nextStep as unknown as Prisma.InputJsonValue) : undefined,
        items: {
          create: accepted.map(({ sel, step }) => {
            const prior = own.get(sel.contactId);
            const snapshot = { ...JSON.parse(JSON.stringify(contacts.get(sel.contactId) ?? {})), ...(sel.declined ? { notSamePersonAs: sel.declined } : {}) };
            return {
              sandboxContactId: sel.contactId, state: 'QUEUED', mode: sel.mode, attachPersonId: sel.attachPersonId, chosenCompanyId: sel.companyId, snapshot,
              nextStep: step ? (step as unknown as Prisma.InputJsonValue) : undefined,
              priorNextAction: prior ? ({ id: prior.id, label: prior.label, action: prior.action, dueDate: prior.dueDate, repeat: prior.repeat, kind: prior.kind, meetingAt: prior.meetingAt?.toISOString() ?? null, foUserId: prior.foUserId } as Prisma.InputJsonValue) : undefined,
            };
          }),
        },
      },
    });
  } catch (err) {
    // Another tab queued one of these contacts a moment ago: the database keeps one move in flight
    // per contact, so this whole request is refused and the other move runs alone (B005).
    if (isUniqueViolation(err)) return { ok: false, error: 'One of these contacts is already being moved, so nothing was queued. Check Moves to CRM, then try again.' };
    throw err;
  }
  await logAudit({ entityType: 'sandbox_move', entityId: move.id, action: 'move_queued', actor: audit, details: { count: accepted.length, left: left.length } });
  for (const a of accepted) await logAudit({ entityType: 'sandbox_contact', entityId: a.sel.contactId, action: 'move_queued', actor: audit, details: { moveId: move.id, mode: a.sel.mode } });
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
  // B018: the CRM person gets their own lines only, never the firm's switchboard or a toll-free number.
  const ownLine = (number: string | null | undefined, type: string | null | undefined) => Boolean(number) && type !== 'main' && type !== 'toll_free' && number !== c.companyPhone;
  const extra = readExtraPhones(c.additionalPhones).filter((p) => ownLine(p.number, p.type));
  const phone = ownLine(c.phone, c.phoneType) ? c.phone : extra.shift()?.number ?? null;
  const lead = allowed(fields.leadSource, [settings.leadSource]);
  const pusher = c.pushedByName ?? c.pushedByEmail;
  // B189: each lead-source line on its own line, the year on every date, "Cold outreach" in words.
  const notes = [
    `Source: ${c.source === 'BELLWETHER' ? 'Bellwether' : c.source === 'MANUAL' ? 'added in Cadence' : c.source.toLowerCase()}${c.sourceNote ? ` (${c.sourceNote})` : ''}`,
    ...(c.bellwetherUrl ? [`Bellwether: ${c.bellwetherUrl}`] : []),
    ...(c.individualCrd ? [`Individual CRD: ${c.individualCrd}`] : []),
    ...(c.designations.length ? [`Designations: ${c.designations.join(', ')}`] : []),
    `In Cold outreach from ${day(c.createdAt)}${pusher ? `, ${c.source === 'BELLWETHER' ? 'pushed from Bellwether' : 'added'} by ${pusher}` : ''}`,
    ...(c.badEmail ? [`Email bounced: ${c.email ?? 'the address'} is flagged in Cadence`] : []),
  ];
  return {
    firstName: c.firstName, lastName: c.lastName, email: c.email, additionalEmails: c.additionalEmails, phone,
    additionalPhone: extra[0]?.number ?? null, linkedinUrl: linkedinHref(c.linkedinUrl), jobTitle: c.jobTitle, city: cityLine(c.city, c.state),
    companyId, assignedToMemberId: c.owner?.twentyMemberId ?? null, podOwner: c.pod?.podOwnerValue ?? null,
    leadSource: lead.length ? lead : allowed(fields.leadSource, [settings.leadSourceFallback]), leadSourceNotes: notes.join('\n'),
    productInterest: allowed(fields.productInterest, c.productInterest), tags: allowed(fields.tags, c.tags).filter((t) => t !== '' && !t.startsWith('list:') && t !== 'bounce:check'),
    contactType: allowed(fields.contactType, settings.contactType), listCategory: allowed(fields.listCategory, [settings.listCategory])[0] ?? null,
    pipelineStage: allowed(fields.pipelineStageField, [settings.pipelineStage])[0] ?? null, cadenceSandboxId: c.id,
  };
}

export type FailureKind = 'transient' | 'permanent';

/** B100: an error as the mover reads it. The raw text goes to the audit log only. */
export function failureWords(err: unknown): { text: string; failure: FailureKind } {
  const raw = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (isUniqueViolation(err) || /P2002|Unique constraint/i.test(raw)) return { text: 'This contact\'s CRM person is already linked to another contact in Cold outreach, so both cannot move onto it. Ask an admin to check the two.', failure: 'permanent' };
  if (/not configured|TWENTY_API|api key/i.test(raw)) return { text: 'The CRM is not connected. An admin can connect it in Settings; then Retry.', failure: 'transient' };
  if (/Twenty|fetch|network|timeout|timed out|ECONN|ETIMEDOUT|socket|429|5\d\d|rate/i.test(raw)) return { text: 'The CRM did not answer. Retry in a few minutes.', failure: 'transient' };
  return { text: 'Something went wrong moving this contact. Retry, and tell an admin if it happens again.', failure: 'transient' };
}

async function fail(item: Pick<SandboxMoveItem, 'id' | 'sandboxContactId' | 'moveId'>, text: string, failure: FailureKind, raw?: unknown) {
  await prisma.sandboxMoveItem.update({ where: { id: item.id }, data: { state: 'FAILED', error: text.slice(0, 1000), failure, attempts: { increment: 1 } } });
  await logAudit({ entityType: 'sandbox_contact', entityId: item.sandboxContactId, action: 'move_failed', actor: SYSTEM_ACTOR, details: { moveId: item.moveId, itemId: item.id, failure, reason: text.slice(0, 300), ...(raw !== undefined ? { error: (raw instanceof Error ? raw.message : String(raw)).slice(0, 1000) } : {}) } });
}

const STATUS_WORDS: Record<string, string> = { OPTED_OUT: 'opted out', REMOVED: 'removed', MOVED: 'already moved to the CRM' };

/** "Not moved: opted out on 3 Nov 2026" (B105): a contact that is no longer active never moves, and Retry leaves it. */
function notActiveWords(c: SandboxContact): string {
  if (c.optedOutAt || c.status === 'OPTED_OUT') return `Not moved: opted out on ${day(c.optedOutAt ?? c.statusChangedAt)}`;
  return `Not moved: ${STATUS_WORDS[c.status] ?? 'no longer active'} on ${day(c.statusChangedAt)}`;
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
  const r = await prisma.sandboxMoveItem.updateMany({ where: { id: itemId, OR: [{ state: 'QUEUED' }, { state: 'RUNNING', claimedAt: { lt: stale } }] }, data: { state: 'RUNNING', claimedAt: at } });
  return r.count === 1;
}

/**
 * What one call of processMoveItem did. CLAIMED_ELSEWHERE: another process held the item or had
 * already finished it, so this call did nothing and counts nothing (B190).
 */
export type MoveItemOutcome = 'DONE' | 'FAILED' | 'DRY_RUN' | 'CLAIMED_ELSEWHERE';

/** The CRM person Twenty has for this contact now that the move may attach to: never a shared line, never one already taken. */
async function attachableNow(client: TwentyClient, contact: SandboxContact): Promise<string | null> {
  await refreshCrmCopyFor([dedupeInputOf(contact)], client);
  const crm = await crmCandidates(contact);
  return crm.card && !crm.card.sharedLine ? crm.card.id : null;
}

/** One item: idempotent, so a retry after a crash finds what the first attempt created. */
export async function processMoveItem(itemId: string, now = new Date()): Promise<MoveItemOutcome> {
  if (!(await claimItem(itemId))) return 'CLAIMED_ELSEWHERE';
  const item = await prisma.sandboxMoveItem.findUniqueOrThrow({ where: { id: itemId }, include: { move: true } });
  const contact = await prisma.sandboxContact.findUnique({ where: { id: item.sandboxContactId }, include: contactInclude });
  if (!contact) { await fail(item, 'Not moved: this contact is no longer in Cold outreach.', 'permanent'); return 'FAILED'; }
  const mover = await prisma.user.findUnique({ where: { id: item.move.createdById }, select: { id: true, name: true } });
  const actor: AuditActor = mover ? { type: 'USER', id: mover.id, label: mover.name } : SYSTEM_ACTOR;
  let client: TwentyClient;
  try { client = await getTwentyClient(); } catch (err) { await fail(item, failureWords(err).text, 'transient', err); return 'FAILED'; }
  // Resume: the local transaction ran but the process stopped before the notes were all written.
  if (contact.status === 'MOVED' && item.twentyPersonId && contact.twentyPersonId === item.twentyPersonId) return finishNotes(item, contact, client, actor, now);
  // The checks again, right before anything is written to the CRM (N001, N017, N003, B105).
  if (contact.status !== 'ACTIVE') { await fail(item, notActiveWords(contact), 'permanent'); return 'FAILED'; }
  if (!contact.ownerId) { await fail(item, 'Not moved: it has no owner. Assign one, then move it again.', 'permanent'); return 'FAILED'; }
  if (!contact.owner?.active) { await fail(item, `Not moved: ${contact.owner?.name ?? 'its owner'} has left. Assign a new owner, then move it again.`, 'permanent'); return 'FAILED'; }
  const check = await contactability({ kind: 'cold', row: contact }, { act: 'move' });
  if (!check.ok) { await fail(item, `Not moved: ${check.reason.replace(/\.$/, '').replace(/^This contact's /, 'its ')}.`, 'permanent'); return 'FAILED'; }
  const settings = await getSettings();
  const dryRun = client.kind === 'dry-run';
  try {
    let personId = item.twentyPersonId;
    let companyId = item.twentyCompanyId;
    let companyAction = item.companyAction;
    let personUpdatedAt = item.personUpdatedAt;
    let mode = item.mode;
    let personNextBefore: { nextAction: string | null; nextActionDueDate: string | null } | null = null;
    if (mode === 'attach') {
      let person = item.attachPersonId ? await client.getPerson(item.attachPersonId) : null;
      if (!person || person.deletedAt) {
        // The person chosen at queue time has left the CRM since: whoever the CRM has for this contact
        // now (never on a shared line), or else the move creates them, as the dialog would have.
        if (item.attachPersonId) await markPersonDeleted(item.attachPersonId, person?.deletedAt ? new Date(person.deletedAt) : now);
        const other = await attachableNow(client, contact);
        person = other ? await client.getPerson(other) : null;
      }
      if (person && !person.deletedAt) {
        const taken = await prisma.sandboxContact.findFirst({ where: { twentyPersonId: person.id, id: { not: contact.id } }, select: { firstName: true, lastName: true } });
        if (taken) { await fail(item, `Not moved: ${person.firstName} ${person.lastName} in the CRM is already linked to ${taken.firstName} ${taken.lastName}. Two contacts cannot both move onto one person; ask an admin.`, 'permanent'); return 'FAILED'; }
        if (person.dnd) { await fail(item, `Not moved: ${person.firstName} ${person.lastName} is marked Do not contact in the CRM.`, 'permanent'); return 'FAILED'; }
        personId = person.id; companyId = person.companyId; companyAction = 'none'; personUpdatedAt = person.updatedAt;
        // B097: the person's own Next Action as it was, for Undo; the move writes one only when there is none.
        personNextBefore = { nextAction: person.nextAction ?? null, nextActionDueDate: person.nextActionDueDate ?? null };
        await prisma.sandboxMoveItem.update({ where: { id: item.id }, data: { attachPersonId: person.id, personNextBefore: personNextBefore as Prisma.InputJsonValue } });
        if (!dryRun) await upsertPersonCache(person);
      } else {
        const ready = checkReady(contact, { owner: contact.owner, podName: contact.pod?.name ?? null, settings: settings.sandbox });
        if (!ready.ready) { await fail(item, `The CRM person to attach to is no longer in the CRM, and Cadence cannot create them until the contact has ${ready.missing.map((m) => m.text.toLowerCase()).join(', ')}.`, 'permanent'); return 'FAILED'; }
        mode = 'create';
        await prisma.sandboxMoveItem.update({ where: { id: item.id }, data: { mode, attachPersonId: null } });
      }
    }
    if (mode === 'create' && !personId) {
      // A retry first looks for the person an earlier attempt created (idempotent on cadenceSandboxId).
      const earlier = await client.findPeople({ emails: contact.email ? [contact.email] : [], cadenceSandboxId: contact.id });
      const ours = earlier.find((p) => (p.raw as Record<string, unknown> | undefined)?.cadenceSandboxId === contact.id || (p.createdBySource === 'API' && new Date(p.createdAt) >= item.move.createdAt && normalizeEmail(p.email) === contact.email));
      const declined = (item.snapshot as { notSamePersonAs?: string } | null)?.notSamePersonAs ?? null;
      const theirs = earlier.find((p) => p !== ours && !p.deletedAt && p.id !== declined);
      if (!ours && theirs && !declined) { await fail(item, `${theirs.firstName} ${theirs.lastName} is in the CRM with this email now. Move it again: the history goes to that person.`, 'permanent'); return 'FAILED'; }
      if (ours) {
        personId = ours.id; companyId = ours.companyId; personUpdatedAt = ours.updatedAt; companyAction = companyAction ?? (ours.companyId ? 'linked' : 'none');
      } else {
        const firm = await resolveFirm(contact, item.chosenCompanyId);
        if (firm.action === 'blocked') { await fail(item, `Not moved: ${firm.name} is a blocked account.`, 'permanent'); return 'FAILED'; }
        if (firm.action === 'choose') { await fail(item, 'Several firms in the CRM match. Move it again and choose one.', 'permanent'); return 'FAILED'; }
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
      await prisma.sandboxMoveItem.update({ where: { id: item.id }, data: { state: 'DRY_RUN', twentyPersonId: null, twentyCompanyId: null, companyAction, error: 'Dry run: nothing was written to the CRM and the contact stays in Cold outreach.', doneAt: now, attempts: { increment: 1 } } });
      return 'DRY_RUN';
    }
    await prisma.sandboxMoveItem.update({ where: { id: item.id }, data: { twentyPersonId: personId, twentyCompanyId: companyId, companyAction, personUpdatedAt, mode } });
    const local = await completeLocally({ ...item, mode }, personId!, companyId, personNextBefore, actor, now);
    if (!local.ok) return local.outcome;
    const fresh = await prisma.sandboxMoveItem.findUniqueOrThrow({ where: { id: item.id }, include: { move: true } });
    const moved = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: contact.id }, include: contactInclude });
    return finishNotes(fresh, moved, client, actor, now);
  } catch (err) {
    const words = failureWords(err);
    await fail(item, words.text, words.failure, err);
    return 'FAILED';
  }
}

type ItemWithMove = SandboxMoveItem & { move: { createdById: string; createdAt: Date } };

/**
 * The one local transaction (8.6 step 3), under the contact's row lock, which completes only if the
 * contact is still ACTIVE: status MOVED, the person linked, its rows handed over (their audience
 * stamps untouched), its running campaigns ended and recorded on the item, its cold next step closed
 * and a CRM one opened (in attach mode only when the person has none: B097), a bounced email
 * flagged on the person (N018). A contact opted out meanwhile is not moved: the CRM person is opted
 * out too, here and in the CRM (N001).
 */
async function completeLocally(item: ItemWithMove, personId: string, companyId: string | null, personNextBefore: { nextAction: string | null; nextActionDueDate: string | null } | null, actor: AuditActor, now: Date): Promise<{ ok: true } | { ok: false; outcome: MoveItemOutcome }> {
  const step = item.nextStep as MoveNextStep | null;
  const cancelled: string[] = [];
  const r = await withSubjectLock(coldRef(item.sandboxContactId), null, 'move', async (tx) => {
    const c = (await tx.sandboxContact.findUnique({ where: { id: item.sandboxContactId }, include: { owner: { select: { active: true } } } }))!;
    const [{ now: stamp }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    const changed = await tx.sandboxContact.updateMany({ where: { id: c.id, status: 'ACTIVE' }, data: { status: 'MOVED', movedAt: now, movedById: item.move.createdById, twentyPersonId: personId, twentyCompanyId: companyId, statusChangedAt: stamp } });
    if (!changed.count) throw new RefusedError(refuse('moved', 'This contact is no longer active.'));
    // Running campaigns end, labelled "Moved to CRM" (B102), and are kept on the item for Undo (B101).
    const running = await tx.enrollment.findMany({ where: { sandboxContactId: c.id, personId: null, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { id: true } });
    for (const e of running) {
      cancelled.push(...(await cancelOpenTasks(tx, e.id, 'exited:moved_to_crm', actor)).map((t) => t.id));
      await tx.enrollment.update({ where: { id: e.id }, data: { status: 'EXITED', exitReason: 'moved_to_crm', exitedAt: now } });
      await logAudit({ entityType: 'enrollment', entityId: e.id, action: 'exited', actor, details: { reason: 'moved_to_crm' } }, tx);
    }
    // The rows go with the person. Their audience stays what it was stamped (8.4): past reports never change.
    await tx.touch.updateMany({ where: { sandboxContactId: c.id, personId: null }, data: { personId } });
    await tx.callLog.updateMany({ where: { sandboxContactId: c.id, personId: null }, data: { personId } });
    await tx.enrollment.updateMany({ where: { sandboxContactId: c.id, personId: null }, data: { personId } });
    // The cold next step closes; a CRM one opens, unless the person already has one of their own (B097).
    await tx.nextAction.updateMany({ where: { sandboxContactId: c.id, personId: null, state: 'OPEN' }, data: { state: 'CANCELLED', closedAt: now, crmPending: false } });
    const theirs = (await tx.nextAction.count({ where: { personId, state: 'OPEN' } })) || Boolean(personNextBefore && (personNextBefore.nextAction || personNextBefore.nextActionDueDate));
    let nextActionId: string | null = null;
    if (step && !theirs) {
      const created = await tx.nextAction.create({ data: { personId, sandboxContactId: c.id, foUserId: c.ownerId!, label: step.label, action: step.action, dueDate: step.dueDate, repeat: step.repeat ?? 'NONE', kind: step.kind ?? 'ACTION', meetingAt: step.meetingAt ? new Date(step.meetingAt) : null, crmPending: true, audience: 'CRM', createdById: item.move.createdById } });
      nextActionId = created.id;
      await tx.personCache.updateMany({ where: { id: personId }, data: { nextAction: step.label, nextActionDueDate: step.dueDate } });
    }
    // N018: the bounce goes with the person, as Cadence's own flag.
    if (c.badEmail) await tx.personCache.updateMany({ where: { id: personId }, data: { badEmail: true } });
    await tx.sandboxMoveItem.update({ where: { id: item.id }, data: { exitedEnrollmentIds: running.map((e) => e.id) } });
    await logAudit({ entityType: 'sandbox_contact', entityId: c.id, action: 'sandbox_moved', actor, details: { moveId: item.moveId, personId, companyId, mode: item.mode, endedEnrollments: running.length, nextStepKept: !theirs, nextActionId } }, tx);
    return nextActionId;
  }, { audit: actor, now });
  if (r.ok) {
    await syncCancelled(cancelled, { actor });
    const id = r.value;
    if (id) await afterResponse(async () => { await pushNextAction(id); });
    return { ok: true };
  }
  // The contact changed while the CRM was written (N001, B105): it does not move.
  const c = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: item.sandboxContactId } });
  if (c.optedOutAt || c.status === 'OPTED_OUT') {
    // The same person, now in the CRM, honours the stop request there too (D6).
    await optOutPerson(personId, { source: (c.optOutSource as OptOutSource | null) ?? 'contact_page', actor, guard: null, reason: 'Opted out while being moved to the CRM.', sweep: false });
    await fail(item, `Not moved: opted out during the move, on ${day(c.optedOutAt ?? now)}. The CRM person is marked Do not contact.`, 'permanent');
    return { ok: false, outcome: 'FAILED' };
  }
  await fail(item, notActiveWords(c), 'permanent');
  return { ok: false, outcome: 'FAILED' };
}

/** History notes last, each once by its key, each id kept as it lands; then the item is DONE with its own undo deadline (N062). */
async function finishNotes(item: ItemWithMove, contact: MoveContact, client: TwentyClient, actor: AuditActor, now: Date): Promise<MoveItemOutcome> {
  const settings = await getSettings();
  const personId = contact.twentyPersonId!;
  const notes = new Set(item.notesWritten);
  const bounce = contact.badEmail ? await prisma.sandboxEmail.findFirst({ where: { sandboxContactId: contact.id, kind: 'BOUNCE' }, orderBy: { at: 'desc' }, select: { at: true } }) : null;
  const mover = await prisma.user.findUnique({ where: { id: item.move.createdById }, select: { name: true } });
  const written = await prisma.$queryRaw<{ key: string | null; twentyId: string | null }[]>`SELECT payload->>'cadenceNoteKey' AS key, "twentyId" FROM "TwentyWrite" WHERE operation = 'createNote' AND payload->>'cadenceMoveItemId' = ${item.id}`;
  const done = new Set(written.map((w) => w.key).filter((k): k is string => Boolean(k)));
  for (const w of written) if (w.twentyId) notes.add(w.twentyId);
  for (const d of await historyDrafts(contact.id, { movedByName: mover?.name ?? null, movedAt: contact.movedAt ?? now, bouncedOn: bounce?.at ?? null })) {
    if (d.key && done.has(d.key)) continue;
    const id = await writeNote(client, { title: d.title, bodyMarkdown: d.bodyMarkdown, personId, companyId: contact.twentyCompanyId }, { moveItemId: item.id, noteKey: d.key ?? null });
    if (id) { notes.add(id); await prisma.sandboxMoveItem.update({ where: { id: item.id }, data: { notesWritten: [...notes] } }); }
  }
  await prisma.sandboxNote.updateMany({ where: { sandboxContactId: contact.id }, data: { twentyNoteId: 'moved' } });
  const undoUntil = item.undoUntil ?? new Date(now.getTime() + settings.sandbox.undoDays * 86_400_000);
  await prisma.sandboxMoveItem.update({ where: { id: item.id }, data: { state: 'DONE', notesWritten: [...notes], error: null, failure: null, doneAt: item.doneAt ?? now, undoUntil, attempts: { increment: 1 } } });
  await logAudit({ entityType: 'sandbox_contact', entityId: contact.id, action: 'move_done', actor, details: { moveId: item.moveId, personId, notes: notes.size, undoUntil: undoUntil.toISOString() } });
  return 'DONE';
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

/** A move is done when none of its items waits or runs; its mover is told once, with the counts (B036). */
export async function finishMoveIfSettled(moveId: string, now = new Date()): Promise<void> {
  if (await prisma.sandboxMoveItem.count({ where: { moveId, state: { in: [...IN_FLIGHT] } } })) return;
  await prisma.sandboxMove.updateMany({ where: { id: moveId, state: { not: 'DONE' } }, data: { state: 'DONE', finishedAt: now } });
  const told = await prisma.sandboxMove.updateMany({ where: { id: moveId, notifiedAt: null }, data: { notifiedAt: now } });
  if (!told.count) return;
  const move = await prisma.sandboxMove.findUniqueOrThrow({ where: { id: moveId }, include: { items: { select: { state: true } } } });
  const done = move.items.filter((i) => i.state === 'DONE').length;
  const failed = move.items.filter((i) => i.state === 'FAILED').length;
  await prisma.notification.create({ data: { userId: move.createdById, kind: 'move_finished', payload: { moveId, done, failed, text: failed ? `Move to CRM finished: ${done} moved, ${failed} failed.` : `Move to CRM finished: ${done} moved.`, href: coldMoveHref(moveId) } } });
}

// ---------------------------------------------------------------------------
// Retry (8.6 step 4)
// ---------------------------------------------------------------------------

/** Retry and Undo are open to the same people (B188): the mover, the leaders of the contact's pod, and admins. */
export const mayRetryOrUndo = (a: Actor, m: { createdById: string }, contact: { podId: string | null }) => canUndoMove(a, { movedById: m.createdById, podId: contact.podId });

/**
 * Queue a move's failed items again, after the checks run again (B036): a contact that cannot move
 * now is marked permanent with the reason, one the CRM has since gained goes to that person, and a
 * permanent failure, or a contact another move holds (B005), is left alone. Only items this person
 * may retry (B188).
 */
export async function retryFailedItems(moveId: string, actor?: Actor): Promise<{ queued: number; refused: string[] }> {
  const move = await prisma.sandboxMove.findUnique({ where: { id: moveId } });
  if (!move) return { queued: 0, refused: ['Move not found.'] };
  const failed = await prisma.sandboxMoveItem.findMany({ where: { moveId, state: 'FAILED', OR: [{ failure: null }, { failure: { not: 'permanent' } }] } });
  const contacts = new Map((await prisma.sandboxContact.findMany({ where: { id: { in: failed.map((i) => i.sandboxContactId) } }, select: { id: true, podId: true, ownerId: true } })).map((c) => [c.id, c]));
  const refused: string[] = [];
  const allowed = actor ? failed.filter((i) => { const ok = mayRetryOrUndo(actor, move, contacts.get(i.sandboxContactId) ?? { podId: null }); if (!ok) refused.push('Only the person who started this move, the leaders of the contact\'s pod, and admins can retry it.'); return ok; }) : failed;
  if (!allowed.length) return { queued: 0, refused };
  const pre = actor ? await preflightMove(allowed.map((i) => i.sandboxContactId), actor) : null;
  if (pre?.refused) return { queued: 0, refused: [pre.refused] };
  let queued = 0;
  for (const item of allowed) {
    const p = pre?.items.find((x) => x.contactId === item.sandboxContactId);
    if (p && (p.group === 'left_out' || p.group === 'needs')) {
      const why = p.group === 'needs' ? `Needs ${p.missing.map((m) => m.text.toLowerCase()).join(', ')}. Fix it, then move it again.` : `Not moved: ${p.reason}.`;
      await prisma.sandboxMoveItem.updateMany({ where: { id: item.id, state: 'FAILED' }, data: { failure: 'permanent', error: why } });
      continue;
    }
    const mode = p?.group === 'in_crm' && p.crmPerson ? 'attach' : item.mode;
    const r = await prisma.sandboxMoveItem.updateMany({ where: { id: item.id, state: 'FAILED' }, data: { state: 'QUEUED', error: null, failure: null, mode, attachPersonId: mode === 'attach' ? p?.crmPerson?.id ?? item.attachPersonId : null } }).catch((err) => {
      if (isUniqueViolation(err)) return { count: 0 };
      throw err;
    });
    queued += r.count;
  }
  if (queued) await prisma.sandboxMove.update({ where: { id: moveId }, data: { state: 'QUEUED', finishedAt: null, notifiedAt: null } });
  return { queued, refused };
}

// ---------------------------------------------------------------------------
// Undo (8.6 step 5)
// ---------------------------------------------------------------------------

export type UndoReport = {
  /** Create mode: the CRM person was deleted. */
  personDeleted?: boolean;
  notesDeleted: number;
  /** Note ids still in the CRM, for a later Undo to finish (B113). */
  notesLeft: string[];
  /** A firm the move created: deleted with its last person (B111), or kept because others are there. */
  companyDeleted?: boolean | null;
  companyLeft?: string | null;
  /** Attach mode: the CRM person's own Next Action put back (B097). */
  nextActionRestored?: boolean | null;
  /** Campaigns the contact was put back in, and those that had ended (B101). */
  campaignsRestored?: string[];
  campaignsEnded?: string[];
};

export type UndoResult = { ok: true; message: string; partial: boolean } | { ok: false; error: string };
export type UndoOptions = { /** B101: put the contact back in these of the campaigns the move ended, while they run. */ restoreEnrollmentIds?: string[] };

/** The last moment this item can be undone: its own deadline, fixed when it was made (N062). */
export function undoClosesOn(item: Pick<SandboxMoveItem, 'doneAt' | 'undoUntil'>, settings: SandboxSettings): Date | null {
  if (item.undoUntil) return item.undoUntil;
  return item.doneAt ? new Date(item.doneAt.getTime() + settings.undoDays * 86_400_000) : null;
}

/** "the history is still on Erin Wu: 2 notes", for "Undo incomplete: <what is left>" (B113). */
export function undoLeftWords(r: UndoReport, personName: string): string | null {
  const parts = [
    ...(r.notesLeft.length ? [`${r.notesLeft.length} note${r.notesLeft.length === 1 ? ' is' : 's are'} still on ${personName} in the CRM`] : []),
    ...(r.companyDeleted === false && r.companyLeft ? [`the firm ${r.companyLeft} is still in the CRM`] : []),
    ...(r.nextActionRestored === false ? [`${personName}'s own Next Action was not put back`] : []),
  ];
  return parts.length ? parts.join('; ') : null;
}

/**
 * Undo a move (8.6 step 5, 4.5). The person first (create mode), then the notes, each recorded; a
 * firm the move created goes with its last person; the CRM person's own Next Action comes back
 * (attach mode). Then one local transaction gives the contact its rows, its own next step and, when
 * asked, its campaigns back. Cadence's own CRM writes never block it (B033); a partial failure ends
 * UNDO_PARTIAL with what is left, and Undo again finishes it (B113). Unsent note writes are dropped
 * (B099). The deadline is the item's own (N062).
 */
export async function undoMoveItem(itemId: string, actor: Actor, audit: AuditActor, now = new Date(), opts: UndoOptions = {}): Promise<UndoResult> {
  const settings = await getSettings();
  const item = await prisma.sandboxMoveItem.findUnique({ where: { id: itemId }, include: { move: true } });
  if (!item) return { ok: false, error: 'Move not found.' };
  if (item.state === 'UNDO_PARTIAL') return finishPartialUndo(item, actor, audit, now);
  if (item.state !== 'DONE') return { ok: false, error: item.state === 'UNDONE' ? 'This move was already undone.' : item.state === 'UNDOING' ? 'This move is being undone already.' : 'Only a finished move can be undone.' };
  const closes = undoClosesOn(item, settings.sandbox);
  if (closes && now > closes) return { ok: false, error: `This move can no longer be undone: its undo window closed on ${day(closes)}.` };
  const contact = await prisma.sandboxContact.findUnique({ where: { id: item.sandboxContactId }, include: { pod: { select: { name: true } } } });
  if (!contact || contact.status !== 'MOVED' || contact.piiClearedAt) return { ok: false, error: 'This contact can no longer be brought back to Cold outreach.' };
  if (!canUndoMove(actor, { movedById: contact.movedById, podId: contact.podId })) {
    const mover = contact.movedById ? await prisma.user.findUnique({ where: { id: contact.movedById }, select: { name: true } }) : null;
    return { ok: false, error: whyNotUndoMove(actor, mover?.name ?? null, contact.pod?.name ?? null) ?? 'You cannot undo this move.' };
  }
  const personId = item.twentyPersonId!;
  let client: TwentyClient;
  try { client = await getTwentyClient(); } catch { return { ok: false, error: 'The CRM is not connected, so nothing was undone.' }; }
  let person: Awaited<ReturnType<TwentyClient['getPerson']>>;
  try { person = await client.getPerson(personId); } catch { return { ok: false, error: 'The CRM did not answer, so nothing was undone. Try again in a few minutes.' }; }
  const personName = person ? `${person.firstName} ${person.lastName}`.trim() : 'the CRM person';
  if (item.mode === 'create' && person && !person.deletedAt) {
    // B033: an updatedAt from Cadence's own writes (the move, its next-action sync) never blocks.
    const ours = new Set([item.personUpdatedAt, ...(await ownStamps(personId, item.doneAt ? new Date(item.doneAt.getTime() - 60_000) : null))].filter(Boolean));
    if (!ours.has(person.updatedAt)) return { ok: false, error: `Someone changed ${personName} in the CRM on ${day(new Date(person.updatedAt))}, so the move is kept. Change it back in the CRM, or keep the person there.` };
    const newer = await prisma.touch.findFirst({ where: { personId, sandboxContactId: null, createdAt: { gt: item.doneAt! }, NOT: { externalId: { in: item.notesWritten.map((id) => `note:${id}`) } } }, select: { summary: true } });
    if (newer) return { ok: false, error: `${personName} has activity in the CRM since the move (${newer.summary}), so the move is kept.` };
    if (await prisma.enrollment.count({ where: { personId, sandboxContactId: null } })) return { ok: false, error: `${personName} has been put in a CRM campaign since the move, so the move is kept.` };
  }
  const claimed = await prisma.sandboxMoveItem.updateMany({ where: { id: item.id, state: 'DONE' }, data: { state: 'UNDOING' } });
  if (!claimed.count) return { ok: false, error: 'This move is being undone already.' };
  // B099: note writes still waiting in the outbox never land after the undo.
  await prisma.$executeRaw`DELETE FROM "TwentyWrite" WHERE operation = 'createNote' AND status <> 'OK' AND payload->>'cadenceMoveItemId' = ${item.id}`;
  const report: UndoReport = { notesDeleted: 0, notesLeft: [] };
  if (item.mode === 'create') {
    // The person first: if the CRM refuses, nothing else is touched and the move stands (B113).
    try { if (person && !person.deletedAt) await client.deletePerson(personId); } catch {
      await prisma.sandboxMoveItem.update({ where: { id: item.id }, data: { state: 'DONE' } });
      return { ok: false, error: 'The CRM did not answer, so nothing was undone. Try again in a few minutes.' };
    }
    report.personDeleted = true;
    await markPersonDeleted(personId, now);
  }
  const retried = await prisma.$queryRaw<{ twentyId: string }[]>`SELECT "twentyId" FROM "TwentyWrite" WHERE operation = 'createNote' AND "twentyId" IS NOT NULL AND payload->>'cadenceMoveItemId' = ${item.id}`;
  for (const id of [...new Set([...item.notesWritten, ...retried.map((r) => r.twentyId)])]) {
    try { await client.deleteNote(id); report.notesDeleted++; } catch { report.notesLeft.push(id); }
  }
  if (item.mode === 'attach') report.nextActionRestored = await restorePersonNextAction(client, item, personId);
  Object.assign(report, await deleteCreatedFirm(client, item, personId, now));
  return restoreLocally(item, contact.id, personId, personName, report, actor, audit, now, opts);
}

/** B097: the CRM person's own Next Action, as it was before the move wrote one; nothing when the move left theirs alone. */
async function restorePersonNextAction(client: TwentyClient, item: SandboxMoveItem, personId: string): Promise<boolean | null> {
  const ours = await prisma.nextAction.findFirst({ where: { personId, sandboxContactId: item.sandboxContactId, audience: 'CRM', state: 'OPEN' } });
  if (!ours) return null;
  const before = (item.personNextBefore as { nextAction: string | null; nextActionDueDate: string | null } | null) ?? { nextAction: null, nextActionDueDate: null };
  try {
    await client.setPersonNextAction(personId, before);
    await prisma.personCache.updateMany({ where: { id: personId }, data: before });
    return true;
  } catch {
    return false;
  }
}

/** B111: a firm a move created goes when its last person is undone, whichever move's item that is. */
async function deleteCreatedFirm(client: TwentyClient, item: SandboxMoveItem, personId: string, now: Date): Promise<Pick<UndoReport, 'companyDeleted' | 'companyLeft'>> {
  const companyId = item.twentyCompanyId;
  if (!companyId) return { companyDeleted: null };
  const createdByMove = item.companyAction === 'created' || (await prisma.sandboxMoveItem.count({ where: { twentyCompanyId: companyId, companyAction: 'created' } })) > 0;
  if (!createdByMove) return { companyDeleted: null };
  try {
    const others = (await client.listPeople({ companyId, limit: 5 })).items.filter((p) => p.id !== personId && !p.deletedAt);
    if (others.length) return { companyDeleted: null };
    await client.deleteCompany(companyId);
    await markCompanyDeleted(companyId, now);
    return { companyDeleted: true };
  } catch {
    const co = await prisma.companyCache.findUnique({ where: { id: companyId }, select: { name: true } });
    return { companyDeleted: false, companyLeft: co?.name ?? 'the firm' };
  }
}

/** The contact back, in one transaction under its lock: rows, own next step, campaigns if asked (B034, B101). */
async function restoreLocally(item: SandboxMoveItem, contactId: string, personId: string, personName: string, report: UndoReport, actor: Actor, audit: AuditActor, now: Date, opts: UndoOptions): Promise<UndoResult> {
  const wanted = new Set((opts.restoreEnrollmentIds ?? []).filter((id) => item.exitedEnrollmentIds.includes(id)));
  const r = await withSubjectLock(coldRef(contactId), null, 'undo', async (tx) => {
    const c = (await tx.sandboxContact.findUnique({ where: { id: contactId } }))!;
    const [{ now: stamp }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    // Only the rows that came from this contact go back; the person's own CRM rows stay. Audience never changes.
    const fromContact = { sandboxContactId: contactId, personId };
    await tx.touch.updateMany({ where: fromContact, data: { personId: null } });
    await tx.callLog.updateMany({ where: fromContact, data: { personId: null } });
    await tx.enrollment.updateMany({ where: fromContact, data: { personId: null } });
    // The CRM next step the move opened closes; the contact's own comes back (B034).
    await tx.nextAction.updateMany({ where: { ...fromContact, state: 'OPEN' }, data: { state: 'CANCELLED', closedAt: now, crmPending: false } });
    const prior = item.priorNextAction as (MoveNextStep & { id?: string; foUserId?: string }) | null;
    if (prior && !c.optedOutAt) {
      const row = prior.id ? await tx.nextAction.findUnique({ where: { id: prior.id } }) : null;
      if (row && row.state === 'CANCELLED' && !row.personId) await tx.nextAction.update({ where: { id: row.id }, data: { state: 'OPEN', closedAt: null } });
      else await tx.nextAction.create({ data: { sandboxContactId: contactId, foUserId: prior.foUserId ?? c.ownerId ?? actor.id, label: prior.label, action: prior.action, dueDate: prior.dueDate, repeat: prior.repeat ?? 'NONE', kind: prior.kind ?? 'ACTION', meetingAt: prior.meetingAt ? new Date(prior.meetingAt) : null, crmPending: false, audience: 'SANDBOX', createdById: actor.id } });
    }
    // B101: back in the campaigns asked for, where they still run; the step the move cancelled reopens.
    const restored: string[] = [];
    const ended: string[] = [];
    for (const id of item.exitedEnrollmentIds) {
      const e = await tx.enrollment.findUnique({ where: { id }, include: { campaign: { select: { name: true, status: true } }, sequence: { select: { name: true } } } });
      if (!e) continue;
      const name = e.campaign?.name ?? e.sequence.name;
      if (!wanted.has(id) || c.optedOutAt) continue;
      if (e.status !== 'EXITED' || e.exitReason !== 'moved_to_crm' || (e.campaign && e.campaign.status !== 'ACTIVE')) { ended.push(name); continue; }
      await tx.enrollment.update({ where: { id }, data: { status: 'ACTIVE', exitReason: null, exitedAt: null } });
      await tx.task.updateMany({ where: { enrollmentId: id, state: 'CANCELLED', cancelReason: 'exited:moved_to_crm' }, data: { state: 'PENDING', cancelReason: null } });
      await logAudit({ entityType: 'enrollment', entityId: id, action: 'restored', actor: audit, details: { reason: 'move_undone' } }, tx);
      restored.push(name);
    }
    report.campaignsRestored = restored;
    report.campaignsEnded = ended;
    // An opt-out made while the person was in the CRM holds here too.
    await tx.sandboxContact.update({ where: { id: contactId }, data: { status: c.optedOutAt ? 'OPTED_OUT' : 'ACTIVE', movedAt: null, movedById: null, twentyPersonId: null, twentyCompanyId: null, statusChangedAt: stamp, lastActivityAt: now } });
    await tx.sandboxNote.updateMany({ where: { sandboxContactId: contactId }, data: { twentyNoteId: null } });
    const partial = Boolean(undoLeftWords(report, personName));
    await tx.sandboxMoveItem.update({ where: { id: item.id }, data: { state: partial ? 'UNDO_PARTIAL' : 'UNDONE', undoneAt: now, undoneById: actor.id, undoReport: report as unknown as Prisma.InputJsonValue } });
    await logAudit({ entityType: 'sandbox_contact', entityId: contactId, action: 'move_undone', actor: audit, details: { moveId: item.moveId, personId, mode: item.mode, ...report } as unknown as Prisma.InputJsonValue }, tx);
    return partial;
  }, { audit, now });
  if (!r.ok) {
    await prisma.sandboxMoveItem.updateMany({ where: { id: item.id, state: 'UNDOING' }, data: { state: 'UNDO_PARTIAL', undoReport: report as unknown as Prisma.InputJsonValue } });
    return { ok: false, error: `Undo incomplete: the contact could not be brought back (${r.reason.replace(/\.$/, '')}).` };
  }
  return { ok: true, partial: r.value, message: undoMessage(item.mode, personName, report) };
}

function undoMessage(mode: string, personName: string, report: UndoReport): string {
  const left = undoLeftWords(report, personName);
  if (left) return `Undo incomplete: ${left}. Undo again to finish.`;
  const back = report.campaignsRestored?.length ? ` Back in ${report.campaignsRestored.join(', ')}.` : '';
  const ended = report.campaignsEnded?.length ? ` ${report.campaignsEnded.join(', ')} ${report.campaignsEnded.length === 1 ? 'has' : 'have'} ended, so it was not put back there.` : '';
  return mode === 'attach'
    ? `Undone. ${personName} stays in the CRM; only the history moved from here was taken off.${back}${ended}`
    : `Undone. ${personName} was deleted from the CRM and is back in Cold outreach.${back}${ended}`;
}

/** Finish an undo that was left partial: the notes and the firm that were still in the CRM (B113). */
async function finishPartialUndo(item: SandboxMoveItem, actor: Actor, audit: AuditActor, now: Date): Promise<UndoResult> {
  const contact = await prisma.sandboxContact.findUnique({ where: { id: item.sandboxContactId }, select: { podId: true } });
  if (!canUndoMove(actor, { movedById: item.undoneById, podId: contact?.podId ?? null }) && !canUndoMove(actor, { movedById: (await prisma.sandboxMove.findUnique({ where: { id: item.moveId }, select: { createdById: true } }))?.createdById ?? null, podId: contact?.podId ?? null })) return { ok: false, error: 'Only the person who moved it, the leaders of its pod, and admins can finish this undo.' };
  let client: TwentyClient;
  try { client = await getTwentyClient(); } catch { return { ok: false, error: 'The CRM is not connected, so nothing was finished.' }; }
  const report = { notesDeleted: 0, notesLeft: [], ...(item.undoReport as UndoReport | null) } as UndoReport;
  const left: string[] = [];
  for (const id of report.notesLeft) { try { await client.deleteNote(id); report.notesDeleted++; } catch { left.push(id); } }
  report.notesLeft = left;
  if (report.companyDeleted === false) Object.assign(report, await deleteCreatedFirm(client, item, item.twentyPersonId ?? '', now));
  if (report.nextActionRestored === false) report.nextActionRestored = await restorePersonNextAction(client, item, item.twentyPersonId ?? '');
  const person = item.twentyPersonId ? await prisma.personCache.findUnique({ where: { id: item.twentyPersonId }, select: { firstName: true, lastName: true } }) : null;
  const name = person ? `${person.firstName} ${person.lastName}`.trim() : 'the CRM person';
  const stillLeft = undoLeftWords(report, name);
  await prisma.sandboxMoveItem.update({ where: { id: item.id }, data: { state: stillLeft ? 'UNDO_PARTIAL' : 'UNDONE', undoReport: report as unknown as Prisma.InputJsonValue } });
  await logAudit({ entityType: 'sandbox_contact', entityId: item.sandboxContactId, action: 'move_undo_finished', actor: audit, details: { moveId: item.moveId, left: stillLeft } });
  return stillLeft ? { ok: true, partial: true, message: `Undo incomplete: ${stillLeft}. Undo again to finish.` } : { ok: true, partial: false, message: 'Undone. Nothing from this move is left in the CRM.' };
}

/** The last day a move made today can be undone, for the dialog. */
export const undoUntil = (today: string, settings: SandboxSettings) => addDays(today, settings.undoDays);
