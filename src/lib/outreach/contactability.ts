import type { PersonCache, Prisma, SandboxContact } from '@prisma/client';
import { prisma } from '../db';
import { pendingFormBlock } from '../calls/gate';
import { hasUsableEmail } from '../sandbox/ready';
import { crmDoNotContactTwin, optedOutTwin } from '../sandbox/dedupe';
import { checkKeysOf, findSuppressed, personCheckKeys, suppressionHash } from '../sandbox/suppression';
import { readExtraPhones, toE164 } from '../sandbox/normalize';
import { attemptLimitBlock, callAttemptsToday, callingHoursBlock, callPlace, recordingNotice, type CallPlace } from '../calls/hours';
import type { SubjectRef } from '../subject';
import type { Fix, RefusalCode } from './guard';

/**
 * One contactability check (cold outreach PLAN 8.2) for CRM people and cold contacts alike: may we
 * reach this person now, this way? It returns the first block, in this order, each with its reason
 * and the button that fixes it:
 *   1. not ACTIVE, or being moved;
 *   2. suppressed on any key: every email, every phone of every type and the number being dialled,
 *      LinkedIn, the Bellwether ids and the individual CRD, and an opted-out twin (B001, B002);
 *   3. Do not contact in the CRM or opted out in Cadence, including a cold contact whose name and
 *      firm match such a CRM person (N003);
 *   4. "Also in CRM" (B053);
 *   5. a post-call form of the caller's still waiting;
 *   6. no usable detail for the channel: email, phone, LinkedIn (B136, N077);
 *   7. a call only: outside 8am to 9pm in the person's zone, or 2 calls already today (owner, 13 Nov 2026,
 *      audit M02); a call to a two-party-consent state carries the recording notice as its warning (M03).
 * Not every block applies to every act: EFFECTS is the table in 8.2, and the caller reads `effect`.
 */

/** Who asks: the Call button, setting a next step (by hand or in the form), task generation, a campaign, Outlook step-closing, Move. */
export type ContactAct = 'call' | 'next_step' | 'form_next_step' | 'task' | 'enroll' | 'step_close' | 'move';
export type ContactChannel = 'CALL' | 'EMAIL' | 'LINKEDIN';
export type Block = 'inactive' | 'suppressed' | 'do_not_contact' | 'in_crm' | 'form_pending' | 'no_channel' | 'calling_hours' | 'call_limit';
/**
 * What a block does to an act: refuse it (block), leave the step or contact out (skip, leave_out),
 * end the enrollment (end), raise a compliance alert (alert), close the step (close), ask once
 * (confirm), say so and carry on (warn), or nothing at all (runs).
 */
export type Effect = 'block' | 'skip' | 'leave_out' | 'end' | 'alert' | 'close' | 'confirm' | 'warn' | 'runs';

export const EFFECTS: Record<Block, Record<ContactAct, Effect>> = {
  inactive: { call: 'block', next_step: 'block', form_next_step: 'block', task: 'end', enroll: 'leave_out', step_close: 'alert', move: 'block' },
  suppressed: { call: 'block', next_step: 'block', form_next_step: 'block', task: 'end', enroll: 'leave_out', step_close: 'alert', move: 'leave_out' },
  do_not_contact: { call: 'block', next_step: 'block', form_next_step: 'block', task: 'end', enroll: 'leave_out', step_close: 'alert', move: 'leave_out' },
  in_crm: { call: 'block', next_step: 'block', form_next_step: 'block', task: 'skip', enroll: 'leave_out', step_close: 'close', move: 'runs' },
  // The form being filed is itself the pending form: its own next step never waits on the queue it clears.
  form_pending: { call: 'block', next_step: 'block', form_next_step: 'runs', task: 'runs', enroll: 'warn', step_close: 'runs', move: 'runs' },
  no_channel: { call: 'block', next_step: 'block', form_next_step: 'block', task: 'skip', enroll: 'warn', step_close: 'runs', move: 'runs' },
  // M02: only the call itself waits for the hour or the next day; planning a call never does.
  calling_hours: { call: 'block', next_step: 'runs', form_next_step: 'runs', task: 'runs', enroll: 'runs', step_close: 'runs', move: 'runs' },
  call_limit: { call: 'block', next_step: 'runs', form_next_step: 'runs', task: 'runs', enroll: 'runs', step_close: 'runs', move: 'runs' },
};

const CODE: Record<Block, RefusalCode> = { inactive: 'opted_out', suppressed: 'suppressed', do_not_contact: 'do_not_contact', in_crm: 'in_crm', form_pending: 'form_pending', no_channel: 'no_channel', calling_hours: 'calling_hours', call_limit: 'call_limit' };

export type ContactCheck =
  | { ok: true; warning: string | null; /** Asked once before the act goes ahead: a number marked wrong. */ confirm: string | null }
  | { ok: false; block: Block; effect: Effect; code: RefusalCode; reason: string; fix: Fix | null };

export type ContactOptions = {
  act: ContactAct;
  channel?: ContactChannel | null;
  /** The exact number being dialled (E.164 or as typed). */
  number?: string | null;
  now?: Date;
  /** The rep acting, for the pending-form block. */
  user?: { id: string; timezone: string } | null;
  tx?: Prisma.TransactionClient | typeof prisma;
  /** Lookups a batched pre-check (`clearColdLookups`) proved find nothing for this contact, so they are skipped. */
  clear?: ReadonlySet<ColdLookup> | null;
};

/** The database lookups a cold contact's check makes: a move in flight, the suppression list, an opted-out twin, a CRM Do not contact. */
export type ColdLookup = 'moving' | 'suppressed' | 'twin' | 'dnc';

type ColdRow = SandboxContact;
type PersonRow = PersonCache;

/** The check, loading the subject itself. A subject that is gone is blocked as inactive. */
export async function contactability(subject: SubjectRef | { kind: 'cold'; row: ColdRow } | { kind: 'person'; row: PersonRow }, opts: ContactOptions): Promise<ContactCheck> {
  const tx = opts.tx ?? prisma;
  if (!('row' in subject)) {
    const row = subject.kind === 'cold' ? await tx.sandboxContact.findUnique({ where: { id: subject.id } }) : await tx.personCache.findUnique({ where: { id: subject.id } });
    if (!row) return blocked('inactive', opts, subject.kind === 'cold' ? 'This contact is no longer in Cold outreach.' : 'This person is no longer in the CRM.');
    return subject.kind === 'cold' ? coldCheck(row as ColdRow, opts) : personCheck(row as PersonRow, opts);
  }
  return subject.kind === 'cold' ? coldCheck(subject.row, opts) : personCheck(subject.row, opts);
}

function blocked(block: Block, opts: ContactOptions, reason: string, fix: Fix | null = null): ContactCheck {
  return { ok: false, block, effect: EFFECTS[block][opts.act], code: CODE[block], reason, fix };
}

/** Run the blocks in order; the first whose effect is not `runs` or `warn` decides, warnings are kept. */
async function firstBlock(opts: ContactOptions, steps: Array<() => Promise<ContactCheck | null> | ContactCheck | null>): Promise<ContactCheck> {
  let warning: string | null = null;
  let confirm: string | null = null;
  for (const step of steps) {
    const r = await step();
    if (!r) continue;
    if (r.ok) { warning = warning ?? r.warning; confirm = confirm ?? r.confirm; continue; }
    if (r.effect === 'runs') continue;
    if (r.effect === 'warn') { warning = warning ?? r.reason; continue; }
    return r;
  }
  return { ok: true, warning, confirm };
}

const STATUS_WORDS: Record<string, string> = { OPTED_OUT: 'This contact was opted out.', REMOVED: 'This contact was removed.', MOVED: 'This contact is in the CRM now.' };

async function coldCheck(c: ColdRow, opts: ContactOptions): Promise<ContactCheck> {
  const tx = opts.tx ?? prisma;
  return firstBlock(opts, [
    async () => {
      if (c.status !== 'ACTIVE') return blocked('inactive', opts, STATUS_WORDS[c.status] ?? 'This contact is not active.', c.status === 'MOVED' && c.twentyPersonId ? { label: 'Open in People', href: `/people/${c.twentyPersonId}` } : null);
      if (opts.act !== 'move' && !opts.clear?.has('moving') && await tx.sandboxMoveItem.count({ where: { sandboxContactId: c.id, state: { in: ['QUEUED', 'RUNNING'] } } })) return blocked('inactive', opts, 'This contact is being moved to the CRM.');
      return null;
    },
    async () => {
      const hit = opts.clear?.has('suppressed') && !opts.number ? null : await findSuppressed(checkKeysOf(c, c.id, opts.number), tx);
      if (hit) return blocked('suppressed', opts, `This contact's ${hit.kind === 'bellwether_id' ? 'Bellwether record' : hit.kind === 'individual_crd' ? 'CRD' : hit.kind === 'phone_subject' ? 'phone' : hit.kind} is on the suppression list.`);
      const twin = opts.clear?.has('twin') ? null : await optedOutTwin({ email: c.email, additionalEmails: c.additionalEmails, linkedinUrl: c.linkedinUrl, individualCrd: c.individualCrd, phone: c.phone, phoneType: c.phoneType ?? 'unknown', additionalPhones: readExtraPhones(c.additionalPhones) }, tx, c.id);
      return twin ? blocked('suppressed', opts, 'Another record of this person asked not to be contacted.') : null;
    },
    async () => {
      const linked = [c.crmMatchPersonId, c.crmAutoPersonId].filter((id): id is string => Boolean(id));
      const flagged = linked.length && !opts.clear?.has('dnc') ? await tx.personCache.findFirst({ where: { id: { in: linked }, OR: [{ dnd: true }, { optedOut: true }] }, select: { firstName: true, lastName: true } }) : null;
      const twin = flagged ? { name: `${flagged.firstName} ${flagged.lastName}`.trim() } : opts.clear?.has('dnc') ? null : await crmDoNotContactTwin(c, tx);
      return twin ? blocked('do_not_contact', opts, `${twin.name || 'This person'} is marked Do not contact in the CRM.`) : null;
    },
    () => (c.crmMatchPersonId || c.crmAutoPersonId ? blocked('in_crm', opts, 'This person is in the CRM now, so their outreach has stopped. Move to CRM to work them there.', { label: 'Move to CRM' }) : null),
    () => formPending(opts),
    () => channelBlock(opts, { email: c.email, badEmail: !hasUsableEmail(c), phone: c.phone ?? readExtraPhones(c.additionalPhones)[0]?.number ?? null, badPhone: c.badPhone, linkedin: c.linkedinUrl }),
    () => callRules(opts, { sandboxContactId: c.id }, () => callPlace({ state: c.state, country: c.country }, { state: c.companyState, country: c.companyCountry })),
  ]);
}

async function personCheck(p: PersonRow, opts: ContactOptions): Promise<ContactCheck> {
  const tx = opts.tx ?? prisma;
  return firstBlock(opts, [
    () => (p.deletedAt ? blocked('inactive', opts, 'This person is no longer in the CRM.') : null),
    async () => {
      const hit = await findSuppressed(personCheckKeys(p, opts.number), tx);
      return hit ? blocked('suppressed', opts, `This person's ${hit.kind === 'phone_subject' ? 'phone' : hit.kind} is on the suppression list.`) : null;
    },
    () => (p.optedOut ? blocked('do_not_contact', opts, 'This person asked not to be contacted.') : p.dnd ? blocked('do_not_contact', opts, 'This person is marked Do not contact in the CRM.') : null),
    () => formPending(opts),
    () => channelBlock(opts, { email: p.email, badEmail: p.badEmail || p.emailMissing, phone: p.phone, badPhone: p.badPhone, linkedin: p.linkedinUrl }),
    () => callRules(opts, { personId: p.id }, async () => callPlace({ state: p.city }, { state: p.companyId ? (await tx.companyCache.findUnique({ where: { id: p.companyId }, select: { city: true } }))?.city : null })),
  ]);
}

/** M02, M03: a call only. The hour and today's calls in the person's own zone; the recording notice where all must agree. */
async function callRules(opts: ContactOptions, subject: { personId?: string; sandboxContactId?: string }, placeOf: () => CallPlace | Promise<CallPlace>): Promise<ContactCheck | null> {
  if (opts.act !== 'call') return null;
  const now = opts.now ?? new Date();
  const place = await placeOf();
  const hours = callingHoursBlock(place, now);
  if (hours) return blocked('calling_hours', opts, hours);
  const limit = attemptLimitBlock(await callAttemptsToday(subject, place, now), place);
  if (limit) return blocked('call_limit', opts, limit);
  const notice = recordingNotice(place);
  return notice ? { ok: true, warning: notice, confirm: null } : null;
}

async function formPending(opts: ContactOptions): Promise<ContactCheck | null> {
  if (!opts.user || EFFECTS.form_pending[opts.act] === 'runs') return null;
  const pending = await pendingFormBlock(opts.user.id, opts.user.timezone);
  return pending ? blocked('form_pending', opts, pending, { label: 'Fill it in' }) : null;
}

function channelBlock(opts: ContactOptions, d: { email: string | null; badEmail: boolean; phone: string | null; badPhone: boolean; linkedin: string | null }): ContactCheck | null {
  const channel = opts.channel ?? (opts.act === 'call' ? 'CALL' : null);
  if (!channel) return null;
  if (channel === 'EMAIL') {
    if (!d.email) return blocked('no_channel', opts, 'There is no email address for this contact. Pick another way, or add an email first.');
    if (d.badEmail) return blocked('no_channel', opts, 'This contact\'s email bounced. Pick another way, or fix the email first.');
  }
  if (channel === 'LINKEDIN' && !d.linkedin) return blocked('no_channel', opts, 'There is no LinkedIn profile for this contact. Pick another way, or add the profile first.');
  if (channel === 'CALL') {
    if (!d.phone && !toE164(opts.number)) return blocked('no_channel', opts, 'There is no phone number for this contact. Pick another way, or add a number first.');
    // A number marked wrong: the Call button asks once; a next step by phone is refused (8.2, block 6).
    if (d.badPhone) return opts.act === 'call' ? { ok: true, warning: null, confirm: 'This number was marked wrong.' } : blocked('no_channel', opts, 'This contact\'s number was marked wrong. Pick another way, or fix the number first.');
  }
  return null;
}

/** "Email", "Call" or "LinkedIn" for a next action's ActionType. */
export function channelOfAction(action: string | null | undefined): ContactChannel | null {
  if (action === 'EMAIL') return 'EMAIL';
  if (action === 'CALL') return 'CALL';
  if (action === 'LINKEDIN_MESSAGE' || action === 'LINKEDIN_CONNECT') return 'LINKEDIN';
  return null;
}

const HASHES_PER_READ = 5000;
const lowerName = (first: string, last: string) => `${first.trim().toLowerCase()}|${last.trim().toLowerCase()}`;

/**
 * For many cold contacts at once (a cold audience, a launch): which of a contact's lookups a handful
 * of batched reads prove find nothing, so `contactability` can skip them (`opts.clear`). It errs one
 * way only: a lookup is cleared only when nothing in the database could make it hit, so the check
 * still runs in full, query by query, for any contact a batched read could not clear. A cold audience
 * of 3,000 contacts made some 15,000 queries without it (W13 volume test).
 */
export async function clearColdLookups(rows: ColdRow[], tx: Prisma.TransactionClient | typeof prisma = prisma): Promise<Map<string, Set<ColdLookup>>> {
  const out = new Map<string, Set<ColdLookup>>();
  if (!rows.length) return out;
  const hashesOf = new Map(rows.map((c) => [c.id, checkKeysOf(c, c.id, null).map((k) => suppressionHash(k.kind, k.value))]));
  const allHashes = [...new Set([...hashesOf.values()].flat())];
  const linked = [...new Set(rows.flatMap((c) => [c.crmMatchPersonId, c.crmAutoPersonId].filter((id): id is string => Boolean(id))))];
  const [moving, flagged, optedOut, dnc, ...hit] = await Promise.all([
    tx.sandboxMoveItem.findMany({ where: { sandboxContactId: { in: rows.map((c) => c.id) }, state: { in: ['QUEUED', 'RUNNING'] } }, select: { sandboxContactId: true } }),
    linked.length ? tx.personCache.findMany({ where: { id: { in: linked }, OR: [{ dnd: true }, { optedOut: true }] }, select: { id: true } }) : Promise.resolve([]),
    // Every opted-out record whose details are still there: what an opted-out twin is matched against.
    tx.sandboxContact.findMany({ where: { optedOutAt: { not: null }, piiClearedAt: null }, select: { id: true, email: true, additionalEmails: true, individualCrd: true, linkedinUrl: true, phone: true, additionalPhones: true } }),
    tx.personCache.findMany({ where: { deletedAt: null, OR: [{ dnd: true }, { optedOut: true }] }, select: { firstName: true, lastName: true } }),
    ...Array.from({ length: Math.ceil(allHashes.length / HASHES_PER_READ) }, (_, i) => tx.suppression.findMany({ where: { valueHash: { in: allHashes.slice(i * HASHES_PER_READ, (i + 1) * HASHES_PER_READ) } }, select: { valueHash: true } })),
  ]);
  const movingIds = new Set(moving.map((m) => m.sandboxContactId));
  const flaggedIds = new Set(flagged.map((p) => p.id));
  const hitHashes = new Set(hit.flat().map((r) => r.valueHash));
  const dncNames = new Set(dnc.map((p) => lowerName(p.firstName, p.lastName)));
  // Each opted-out record's details, with who holds them, so a contact never counts as its own twin.
  const heldBy = new Map<string, Set<string>>();
  const valuesOf = (c: Pick<ColdRow, 'email' | 'additionalEmails' | 'individualCrd' | 'linkedinUrl' | 'phone' | 'additionalPhones'>) => [c.email, ...c.additionalEmails, c.individualCrd, c.linkedinUrl, c.phone, ...readExtraPhones(c.additionalPhones).map((p) => p.number)].filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase());
  for (const o of optedOut) for (const v of valuesOf(o)) heldBy.set(v, (heldBy.get(v) ?? new Set()).add(o.id));
  for (const c of rows) {
    const clear = new Set<ColdLookup>();
    if (!movingIds.has(c.id)) clear.add('moving');
    if (!hashesOf.get(c.id)!.some((h) => hitHashes.has(h))) clear.add('suppressed');
    if (!valuesOf(c).some((v) => [...(heldBy.get(v) ?? [])].some((id) => id !== c.id))) clear.add('twin');
    if (![c.crmMatchPersonId, c.crmAutoPersonId].some((id) => id && flaggedIds.has(id)) && !dncNames.has(lowerName(c.firstName, c.lastName))) clear.add('dnc');
    out.set(c.id, clear);
  }
  return out;
}
