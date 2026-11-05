import type { PersonCache, Prisma, SandboxContact } from '@prisma/client';
import { prisma } from '../db';
import { getSettings } from '../settings';
import { callingHours } from '../calls/hours';
import { pendingFormBlock } from '../calls/gate';
import { hasUsableEmail } from '../sandbox/ready';
import { crmDoNotContactTwin, optedOutTwin } from '../sandbox/dedupe';
import { checkKeysOf, findSuppressed, personCheckKeys } from '../sandbox/suppression';
import { readExtraPhones, toE164 } from '../sandbox/normalize';
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
 *   7. calling hours, for the Call button only, at the click (N008).
 * Not every block applies to every act: EFFECTS is the table in 8.2, and the caller reads `effect`.
 */

/** Who asks: the Call button, setting a next step (by hand or in the form), task generation, a campaign, Outlook step-closing, Move. */
export type ContactAct = 'call' | 'next_step' | 'form_next_step' | 'task' | 'enroll' | 'step_close' | 'move';
export type ContactChannel = 'CALL' | 'EMAIL' | 'LINKEDIN';
export type Block = 'inactive' | 'suppressed' | 'do_not_contact' | 'in_crm' | 'form_pending' | 'no_channel' | 'calling_hours';
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
  calling_hours: { call: 'block', next_step: 'runs', form_next_step: 'runs', task: 'runs', enroll: 'runs', step_close: 'runs', move: 'runs' },
};

const CODE: Record<Block, RefusalCode> = { inactive: 'opted_out', suppressed: 'suppressed', do_not_contact: 'do_not_contact', in_crm: 'in_crm', form_pending: 'form_pending', no_channel: 'no_channel', calling_hours: 'calling_hours' };

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
};

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
      if (opts.act !== 'move' && await tx.sandboxMoveItem.count({ where: { sandboxContactId: c.id, state: { in: ['QUEUED', 'RUNNING'] } } })) return blocked('inactive', opts, 'This contact is being moved to the CRM.');
      return null;
    },
    async () => {
      const hit = await findSuppressed(checkKeysOf(c, c.id, opts.number), tx);
      if (hit) return blocked('suppressed', opts, `This contact's ${hit.kind === 'bellwether_id' ? 'Bellwether record' : hit.kind === 'individual_crd' ? 'CRD' : hit.kind === 'phone_subject' ? 'phone' : hit.kind} is on the suppression list.`);
      const twin = await optedOutTwin({ email: c.email, additionalEmails: c.additionalEmails, linkedinUrl: c.linkedinUrl, individualCrd: c.individualCrd, phone: c.phone, phoneType: c.phoneType ?? 'unknown', additionalPhones: readExtraPhones(c.additionalPhones) }, tx, c.id);
      return twin ? blocked('suppressed', opts, 'Another record of this person asked not to be contacted.') : null;
    },
    async () => {
      const linked = [c.crmMatchPersonId, c.crmAutoPersonId].filter((id): id is string => Boolean(id));
      const flagged = linked.length ? await tx.personCache.findFirst({ where: { id: { in: linked }, OR: [{ dnd: true }, { optedOut: true }] }, select: { firstName: true, lastName: true } }) : null;
      const twin = flagged ? { name: `${flagged.firstName} ${flagged.lastName}`.trim() } : await crmDoNotContactTwin(c, tx);
      return twin ? blocked('do_not_contact', opts, `${twin.name || 'This person'} is marked Do not contact in the CRM.`) : null;
    },
    () => (c.crmMatchPersonId || c.crmAutoPersonId ? blocked('in_crm', opts, 'This person is in the CRM now, so their outreach has stopped. Move to CRM to work them there.', { label: 'Move to CRM' }) : null),
    () => formPending(opts),
    () => channelBlock(opts, { email: c.email, badEmail: !hasUsableEmail(c), phone: c.phone ?? readExtraPhones(c.additionalPhones)[0]?.number ?? null, badPhone: c.badPhone, linkedin: c.linkedinUrl }),
    () => hoursBlock(opts, c),
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
    () => hoursBlock(opts, { phone: p.phone, state: null, companyState: null, country: null }),
  ]);
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

/** Calling hours, at the click only (decision 14): they never stop a next step, a campaign or a move. */
async function hoursBlock(opts: ContactOptions, c: { phone?: string | null; state?: string | null; companyState?: string | null; country?: string | null }): Promise<ContactCheck | null> {
  if (opts.act !== 'call') return null;
  const hours = callingHours(c, (await getSettings()).calling, opts.now ?? new Date());
  if (!hours.allowed) return blocked('calling_hours', opts, hours.warning ?? 'It is outside calling hours for this contact.');
  return hours.warning ? { ok: true, warning: hours.warning, confirm: null } : null;
}

/** "Email", "Call" or "LinkedIn" for a next action's ActionType. */
export function channelOfAction(action: string | null | undefined): ContactChannel | null {
  if (action === 'EMAIL') return 'EMAIL';
  if (action === 'CALL') return 'CALL';
  if (action === 'LINKEDIN_MESSAGE' || action === 'LINKEDIN_CONNECT') return 'LINKEDIN';
  return null;
}
