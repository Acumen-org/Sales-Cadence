import { createHash } from 'node:crypto';
import { Prisma, type SandboxContact, type SandboxEmailKind } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, SYSTEM_ACTOR, type AuditActor } from '../audit';
import { coldRef } from '../subject';
import { refuse, RefusedError, withSubjectLock, type GuardActor } from '../outreach/guard';
import { getSettings } from '../settings';
import { formatInstant, safeTimezone } from '../dates';
import { workspaceTimezone } from '../workspace';
import { audienceOf } from '../outreach/audience';
import { contactability } from '../outreach/contactability';
import { closeFromTouch, subjectKey } from '../engine/observed-evidence';
import { markReplied, OCCUPYING_STATUSES } from '../engine/enrollment';
import { bounceDetected } from '../engine/outcomes';
import { closeEmailNextAction } from '../next-actions';
import { notify, podLeaders } from '../notifications';
import { normalizeEmail } from '../sandbox/normalize';
import { maskValue, suppressionHash } from '../sandbox/suppression';
import { autoCreatedFor } from '../sandbox/crm-cleanup';

/**
 * What one email to or from a cold contact does (cold outreach PLAN 8.11, W10), whichever way
 * Cadence saw it: in a sales mailbox through Outlook tracking (graph-mail.ts), or in the CRM's own
 * mail sync while tracking is off (ingest.ts, N028). Only the metadata is kept (addresses, subject,
 * time, conversation), never the body, and only for mail that matches a cold contact.
 *
 *  - Sent: a touch stamped with the contact's audience (8.4), the open email step it counts for,
 *    and the Email next step due that day (N098). An email to someone who must not be contacted is
 *    never stored: it rings the rep's and the pod leaders' bells and is counted (N016).
 *  - Reply: the campaign stops as Replied, and the campaign's rep, the mailbox owner and the owner
 *    hear of it; the pod's leaders when nobody owns the contact. An auto-reply rings nobody (N064).
 *  - Bounce: only a real failure notice from a mail system counts (N059), matched to an email sent
 *    from the same mailbox (N058). Matched by its conversation it is a bounce, with the same rule
 *    as the "Email bounced" skip (N060); matched only by subject, or to several contacts, it is a
 *    possible bounce the rep checks (N097). Either rings the bell.
 */

/** One email, as either source saw it. */
export type SeenMail = {
  /** One id per email and source: Outlook's internetMessageId, or "message:<id>" for the CRM's copy. */
  key: string;
  conversationId: string | null;
  subject: string | null;
  at: Date;
  /** Whose mailbox: the rep who sent it, or the one whose inbox it reached. */
  mailboxUserId: string | null;
  via: 'outlook' | 'crm';
};

export const EMAIL_TO_DO_NOT_CONTACT = 'email_to_do_not_contact';
/** The same email seen by both sources lands within minutes, under the same subject. */
const SAME_EMAIL_MS = 10 * 60_000;
const BOUNCE_WINDOW_MS = 72 * 3_600_000;

const addressesOf = (c: Pick<SandboxContact, 'email' | 'additionalEmails'>) => [c.email, ...c.additionalEmails].map((a) => normalizeEmail(a)).filter((a): a is string => Boolean(a));
const touchKey = (mail: SeenMail, contactId: string) => (mail.via === 'outlook' ? `graph:${mail.key}:sbx:${contactId}` : `${mail.key}:sbx:${contactId}`);
const fromCrm = (key: string) => key.startsWith('message:');
const nameOf = (c: Pick<SandboxContact, 'firstName' | 'lastName'>) => `${c.firstName} ${c.lastName}`.trim() || null;

/** Cold contacts of any status behind these addresses (lower-cased). */
export async function coldContactsByAddress(addresses: string[]): Promise<SandboxContact[]> {
  const wanted = [...new Set(addresses.map((a) => normalizeEmail(a)).filter((a): a is string => Boolean(a)))];
  if (!wanted.length) return [];
  return prisma.sandboxContact.findMany({ where: { OR: [{ email: { in: wanted } }, { additionalEmails: { hasSome: wanted } }] }, orderBy: { createdAt: 'asc' } });
}

/** Whether this email is on the contact already: from this source, or from the other one (Outlook and the CRM both saw it). */
async function seenAlready(contactId: string, kinds: SandboxEmailKind[], mail: SeenMail): Promise<boolean> {
  if (await prisma.sandboxEmail.findUnique({ where: { internetMessageId_sandboxContactId: { internetMessageId: mail.key, sandboxContactId: contactId } }, select: { id: true } })) return true;
  const near = await prisma.sandboxEmail.findMany({ where: { sandboxContactId: contactId, kind: { in: kinds }, at: { gte: new Date(mail.at.getTime() - SAME_EMAIL_MS), lte: new Date(mail.at.getTime() + SAME_EMAIL_MS) } }, select: { internetMessageId: true, subject: true } });
  const key = subjectKey(mail.subject ?? '');
  return near.some((e) => fromCrm(e.internetMessageId) !== fromCrm(mail.key) && subjectKey(e.subject ?? '') === key);
}

/** Any action on the contact keeps retention away; an older email never moves it back. */
async function touchedAt(contactId: string, at: Date) {
  await prisma.sandboxContact.updateMany({ where: { id: contactId, OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: at } }] }, data: { lastActivityAt: at } });
}

/** Whether someone in Cadence's copy of the CRM has any of these addresses. */
async function crmHolds(addresses: string[]): Promise<boolean> {
  if (!addresses.length) return false;
  return (await prisma.personCache.count({ where: { deletedAt: null, OR: [{ emailNorm: { in: addresses } }, { additionalEmailsNorm: { hasSome: addresses } }] } })) > 0;
}

async function activeOwner(ownerId: string | null): Promise<string | null> {
  if (!ownerId) return null;
  const u = await prisma.user.findUnique({ where: { id: ownerId }, select: { active: true } });
  return u?.active ? ownerId : null;
}

// ---------------------------------------------------------------------------
// Sent
// ---------------------------------------------------------------------------

export type SentResult = { recorded: string[]; closed: number; alerts: number; /** The addresses a cold contact answered for. */ matched: Set<string> };

/** An email from our side to these addresses: each cold contact behind them, by its status and contactability. */
export async function recordColdSent(addresses: string[], mail: SeenMail): Promise<SentResult> {
  const out: SentResult = { recorded: [], closed: 0, alerts: 0, matched: new Set() };
  const wanted = new Set(addresses.map((a) => normalizeEmail(a)).filter((a): a is string => Boolean(a)));
  for (const c of await coldContactsByAddress([...wanted])) {
    const mine = addressesOf(c).filter((a) => wanted.has(a));
    for (const a of mine) out.matched.add(a);
    // In the CRM now: the email is the CRM person's, and the CRM's mail sync records it there.
    if (c.status === 'MOVED') continue;
    const dnc = { contactId: c.id, personId: null, podId: c.podId, name: nameOf(c), address: mine[0] };
    if (c.status !== 'ACTIVE') {
      // A removal never stops the CRM: someone in the CRM with this address is theirs to email.
      if (c.status === 'REMOVED' && await crmHolds(mine)) continue;
      if (await alertDoNotContact({ ...dnc, why: c.status === 'OPTED_OUT' ? 'They asked not to be contacted.' : 'They were removed from Cold outreach.' }, mail)) out.alerts++;
      continue;
    }
    // Outlook step-closing asks contactability first (8.2): opted out, suppressed or Do not contact
    // in the CRM is an alert, never a closed step; "Also in CRM" still closes it.
    // A contact part way through a Move to CRM is still theirs to email: recorded, not alerted.
    const check = await contactability({ kind: 'cold', row: c }, { act: 'step_close' });
    if (!check.ok && check.effect === 'alert' && check.block !== 'inactive') {
      if (await alertDoNotContact({ ...dnc, why: check.reason }, mail)) out.alerts++;
      continue;
    }
    const r = await recordSent(c, mail);
    if (r) { out.recorded.push(c.id); if (r.closed) out.closed++; }
  }
  return out;
}

async function recordSent(c: SandboxContact, mail: SeenMail): Promise<{ closed: boolean } | null> {
  if (await seenAlready(c.id, ['SENT'], mail)) return null;
  const { matching } = await getSettings();
  const externalId = touchKey(mail, c.id);
  const summary = `Email sent: ${mail.subject || '(no subject)'}`;
  const touch = await prisma.touch.upsert({ where: { externalId }, create: { sandboxContactId: c.id, channel: 'EMAIL', direction: 'OUTBOUND', occurredAt: mail.at, summary, externalId, actorUserId: mail.mailboxUserId, audience: audienceOf({ sandboxContactId: c.id }, c.status) }, update: {} });
  const closed = await closeFromTouch({ sandboxContactId: c.id, types: ['EMAIL'], touch: { externalId, channel: 'EMAIL', occurredAt: mail.at, summary: touch.summary }, source: 'OBSERVED_MESSAGE', matching, ctx: { actor: SYSTEM_ACTOR } });
  await prisma.sandboxEmail.createMany({ data: [{ sandboxContactId: c.id, userId: mail.mailboxUserId, kind: 'SENT', internetMessageId: mail.key, conversationId: mail.conversationId, subject: mail.subject, at: mail.at, touchId: touch.id, taskId: closed.code === 'completed' ? closed.taskId ?? null : null }], skipDuplicates: true });
  await closeEmailNextAction({ sandboxContactId: c.id }, mail.at, externalId);
  await touchedAt(c.id, mail.at);
  return { closed: closed.code === 'completed' };
}

/**
 * Addresses no live cold contact answered for, that belong to someone who must not be contacted:
 * on the suppression list (a CRM person who opted out, an erased contact, an address suppressed by
 * hand), or a removed contact's, recognised by the hashes it keeps once its details are cleared
 * (N027) while nobody in the CRM holds the address. Outlook tracking only: the CRM's mail sync
 * keeps its own rules for CRM people.
 */
export async function alertSuppressedAddresses(addresses: string[], mail: SeenMail, skip: Set<string>): Promise<number> {
  let alerts = 0;
  const list = [...new Set(addresses.map((a) => normalizeEmail(a)).filter((a): a is string => Boolean(a) && !skip.has(a!)))];
  if (!list.length) return 0;
  const hashOf = new Map(list.map((a) => [a, suppressionHash('email', a)]));
  const [rows, removed] = await Promise.all([
    prisma.suppression.findMany({ where: { kind: 'email', subjectId: null, valueHash: { in: [...hashOf.values()] } }, orderBy: { createdAt: 'asc' }, select: { valueHash: true, sandboxContactId: true, personId: true, reason: true } }),
    prisma.$queryRaw<Array<{ id: string; podId: string | null; keptKeys: unknown }>>`
      SELECT c.id, c."podId", c."keptKeys" FROM "SandboxContact" c
      WHERE c.status = 'REMOVED' AND (${Prisma.join([...hashOf.values()].map((h) => Prisma.sql`c."keptKeys" @> ${JSON.stringify([{ kind: 'email', valueHash: h }])}::jsonb`), ' OR ')})`,
  ]);
  for (const address of list) {
    const hash = hashOf.get(address)!;
    const row = rows.find((r) => r.valueHash === hash);
    if (row) {
      const contact = row.sandboxContactId ? await prisma.sandboxContact.findUnique({ where: { id: row.sandboxContactId }, select: { firstName: true, lastName: true, podId: true } }) : null;
      const person = !contact && row.personId ? await prisma.personCache.findUnique({ where: { id: row.personId }, select: { firstName: true, lastName: true } }) : null;
      const why = row.reason === 'erased' ? 'Their details were erased at their request.' : row.reason === 'do_not_contact' ? 'They are marked Do not contact.' : 'They asked not to be contacted.';
      if (await alertDoNotContact({ contactId: contact ? row.sandboxContactId : null, personId: person ? row.personId : null, podId: contact?.podId ?? null, name: (contact && nameOf(contact)) || (person && nameOf(person)) || null, address, why }, mail)) alerts++;
      continue;
    }
    const tombstone = removed.find((c) => JSON.stringify(c.keptKeys).includes(hash));
    if (!tombstone) continue;
    // A removal never stops the CRM: someone in the CRM with this address is theirs to email.
    if (await crmHolds([address])) continue;
    if (await alertDoNotContact({ contactId: tombstone.id, personId: null, podId: tombstone.podId, name: null, address, why: 'They were removed from Cold outreach.' }, mail)) alerts++;
  }
  return alerts;
}

/**
 * N016: an email went to someone who must not be contacted. Nothing of it is stored (no subject, no
 * touch, no step closed); the rep and their pod's leaders are told, with the time and the masked
 * address, and it is counted (audit action `email_to_do_not_contact`). Once per email and person.
 */
async function alertDoNotContact(d: { contactId: string | null; personId: string | null; podId: string | null; name: string | null; address: string; why: string }, mail: SeenMail): Promise<boolean> {
  const messageKey = createHash('sha256').update(mail.key).digest('hex').slice(0, 32);
  const entity = d.contactId ? { entityType: 'sandbox_contact' as const, entityId: d.contactId } : d.personId ? { entityType: 'person' as const, entityId: d.personId } : { entityType: 'suppression' as const, entityId: suppressionHash('email', d.address) };
  if (await prisma.auditLog.findFirst({ where: { action: EMAIL_TO_DO_NOT_CONTACT, entityId: entity.entityId, details: { path: ['messageKey'], equals: messageKey } }, select: { id: true } })) return false;
  const masked = maskValue('email', d.address);
  const sender = mail.mailboxUserId ? await prisma.user.findUnique({ where: { id: mail.mailboxUserId }, select: { name: true, timezone: true, pods: { select: { podId: true } } } }) : null;
  await logAudit({ ...entity, action: EMAIL_TO_DO_NOT_CONTACT, actor: SYSTEM_ACTOR, details: { messageKey, at: mail.at.toISOString(), mailboxUserId: mail.mailboxUserId, address: masked, why: d.why, via: mail.via } });
  const leaders = await podLeaders(d.podId ? [d.podId] : sender?.pods.map((p) => p.podId) ?? []);
  const when = formatInstant(mail.at, safeTimezone(sender?.timezone ?? workspaceTimezone()));
  const text = `${sender?.name ?? 'Someone'} emailed ${d.name ?? masked} (${masked}) on ${when}. ${d.why} Do not email, call or message this person.`;
  await notify([mail.mailboxUserId, ...leaders], { kind: 'compliance_alert', sandboxContactId: d.contactId, personId: d.personId, fromUserId: mail.mailboxUserId, payload: { text, name: d.name ?? masked, address: masked, why: d.why, at: mail.at.toISOString() } });
  return true;
}

/** N016: how many emails went to people who must not be contacted since `since`, for Settings and Reports. */
export async function emailsToDoNotContact(since: Date): Promise<number> {
  return prisma.auditLog.count({ where: { action: EMAIL_TO_DO_NOT_CONTACT, createdAt: { gte: since } } });
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/** A message from a cold contact: recorded on each live contact with the address; a real reply stops their campaign and rings the bell. */
export async function recordColdReply(from: string, mail: SeenMail, automatic: boolean): Promise<{ replies: number; autoReplies: number; contacts: string[] }> {
  const out = { replies: 0, autoReplies: 0, contacts: [] as string[] };
  const contacts = (await coldContactsByAddress([from])).filter((c) => c.status === 'ACTIVE');
  for (const c of contacts) {
    if (await seenAlready(c.id, ['REPLY', 'AUTO_REPLY'], mail)) continue;
    const externalId = touchKey(mail, c.id);
    const touch = await prisma.touch.upsert({ where: { externalId }, create: { sandboxContactId: c.id, channel: 'EMAIL', direction: 'INBOUND', occurredAt: mail.at, summary: `${automatic ? 'Auto-reply' : 'Reply'}: ${mail.subject || '(no subject)'}`, externalId, audience: audienceOf({ sandboxContactId: c.id }, c.status) }, update: {} });
    await prisma.sandboxEmail.createMany({ data: [{ sandboxContactId: c.id, userId: mail.mailboxUserId, kind: automatic ? 'AUTO_REPLY' : 'REPLY', internetMessageId: mail.key, conversationId: mail.conversationId, subject: mail.subject, at: mail.at, touchId: touch.id }], skipDuplicates: true });
    await touchedAt(c.id, mail.at);
    out.contacts.push(c.id);
    // An out-of-office answers nobody: it never stops a campaign and never rings (N064).
    if (automatic) { out.autoReplies++; continue; }
    out.replies++;
    const running = await prisma.enrollment.findMany({ where: { sandboxContactId: c.id, personId: null, status: { in: OCCUPYING_STATUSES } }, select: { id: true, foUserId: true } });
    for (const e of running) await markReplied(e.id, { at: mail.at, evidenceId: externalId, actor: SYSTEM_ACTOR });
    // The campaign's rep, the mailbox it reached and the owner; the pod's leaders when nobody owns it.
    const owner = await activeOwner(c.ownerId);
    const leaders = owner ? [] : await podLeaders(c.podId ? [c.podId] : mail.mailboxUserId ? (await prisma.userPod.findMany({ where: { userId: mail.mailboxUserId }, select: { podId: true } })).map((p) => p.podId) : []);
    await notify([...running.map((e) => e.foUserId), mail.mailboxUserId, owner, ...leaders], { kind: 'reply', sandboxContactId: c.id, payload: { subject: mail.subject, touchId: touch.id, at: mail.at.toISOString() } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bounces
// ---------------------------------------------------------------------------

/** A mail system, not a person. */
const SYSTEM_SENDER = /^(postmaster|mailer-daemon|microsoftexchange[0-9a-f]*)@/i;
/** What a failed delivery is called. */
const FAILURE = /^\s*(undeliverable|undelivered mail|delivery has failed|delivery failure|mail delivery failed|returned mail|failure notice|message not delivered|delivery status notification \(failure\))/i;
/** What a delay, a delivery receipt or a relay is called: never a bounce (N059). */
const NOT_A_FAILURE = /^\s*(delivery delayed|delayed|delivered|relayed|expanded|delivery status notification \((delay|success|relay)\))/i;

/**
 * What an inbox message from a mail system is: a bounce (a system sender and a failure subject,
 * both, N059), another notice to ignore (a delay, a receipt), or null when a person sent it.
 */
export function systemNotice(from: string | null | undefined, subject: string | null | undefined): 'bounce' | 'notice' | null {
  if (!from || !SYSTEM_SENDER.test(from)) return null;
  const s = subject ?? '';
  return !NOT_A_FAILURE.test(s) && FAILURE.test(s) ? 'bounce' : 'notice';
}

/** "Undeliverable: One concrete example" -> "One concrete example". */
export function originalSubject(subject: string | null | undefined): string | null {
  const s = (subject ?? '').replace(/^\s*(undeliverable|undelivered mail returned to sender|delivery has failed[^:]*|delivery failure|mail delivery failed[^:]*|returned mail[^:]*|failure notice|message not delivered)\s*:\s*/i, '').trim();
  return s && s !== (subject ?? '').trim() ? s : null;
}

/**
 * A bounce notice in a sales mailbox, matched to the email it answers among those sent from that
 * same mailbox (N058): by conversation, else by subject within 72 hours. One contact by
 * conversation is a bounce; a subject-only match, or several contacts, is a possible bounce.
 */
export async function recordBounce(mail: SeenMail): Promise<{ bounced: string[]; possible: string[] }> {
  const out = { bounced: [] as string[], possible: [] as string[] };
  if (!mail.mailboxUserId) return out;
  const fromHere = { kind: 'SENT' as const, userId: mail.mailboxUserId };
  let sent = mail.conversationId ? await prisma.sandboxEmail.findMany({ where: { ...fromHere, conversationId: mail.conversationId }, select: { sandboxContactId: true, subject: true } }) : [];
  const byConversation = sent.length > 0;
  if (!byConversation) {
    const original = originalSubject(mail.subject);
    if (original) sent = await prisma.sandboxEmail.findMany({ where: { ...fromHere, subject: original, at: { gte: new Date(mail.at.getTime() - BOUNCE_WINDOW_MS), lte: mail.at } }, select: { sandboxContactId: true, subject: true } });
  }
  const ids = [...new Set(sent.map((s) => s.sandboxContactId))];
  if (!ids.length) return out;
  const certain = byConversation && ids.length === 1;
  const contacts = await prisma.sandboxContact.findMany({ where: { id: { in: ids }, status: 'ACTIVE' } });
  for (const c of contacts) {
    const sentSubject = sent.find((s) => s.sandboxContactId === c.id)?.subject ?? null;
    if (certain ? await bounced(c, mail, sentSubject) : await possibleBounce(c, mail, sentSubject)) (certain ? out.bounced : out.possible).push(c.id);
  }
  return out;
}

async function bounced(c: SandboxContact, mail: SeenMail, sentSubject: string | null): Promise<boolean> {
  const created = await prisma.sandboxEmail.createMany({ data: [{ sandboxContactId: c.id, userId: mail.mailboxUserId, kind: 'BOUNCE', internetMessageId: mail.key, conversationId: mail.conversationId, subject: mail.subject, at: mail.at }], skipDuplicates: true });
  if (!created.count) return false;
  // Certain now: the possible bounce, if any, is settled.
  if (c.possibleBounceAt) await prisma.sandboxContact.update({ where: { id: c.id }, data: { possibleBounceAt: null } });
  const r = await bounceDetected({ sandboxContactId: c.id }, { actor: SYSTEM_ACTOR });
  await logAudit({ entityType: 'sandbox_contact', entityId: c.id, action: 'email_bounced', actor: SYSTEM_ACTOR, details: { at: mail.at.toISOString(), via: mail.via, skipped: r.skipped, exited: r.exited } });
  const text = r.exited ? 'The address is marked bounced and their campaign ended. Find another way to reach them.' : r.skipped ? 'The address is marked bounced and their open email steps were skipped.' : 'The address is marked bounced.';
  await notify([mail.mailboxUserId, await activeOwner(c.ownerId)], { kind: 'bounce', sandboxContactId: c.id, payload: { subject: sentSubject, text, at: mail.at.toISOString() } });
  return true;
}

/** N097: set once, on a contact not already known to bounce, and shown as a badge with Clear and Confirm. */
async function possibleBounce(c: SandboxContact, mail: SeenMail, sentSubject: string | null): Promise<boolean> {
  const set = await prisma.sandboxContact.updateMany({ where: { id: c.id, possibleBounceAt: null, badEmail: false }, data: { possibleBounceAt: mail.at } });
  if (!set.count) return false;
  await logAudit({ entityType: 'sandbox_contact', entityId: c.id, action: 'possible_bounce', actor: SYSTEM_ACTOR, details: { at: mail.at.toISOString(), via: mail.via } });
  await notify([mail.mailboxUserId, await activeOwner(c.ownerId)], { kind: 'possible_bounce', sandboxContactId: c.id, payload: { subject: sentSubject, at: mail.at.toISOString() } });
  return true;
}

/** The chip beside a cold contact's name: "Email bounced", else "Possible bounce" (N097). */
export const bounceWords = (c: { badEmail: boolean; possibleBounceAt: Date | null }) => (c.badEmail ? 'Email bounced' : c.possibleBounceAt ? 'Possible bounce' : null);

type Answer = { ok: true; message: string } | { ok: false; error: string };

/** Clear or Confirm on a possible bounce (N097), through the guard as an edit of the contact. */
async function settlePossibleBounce(contactId: string, actor: GuardActor, audit: AuditActor, action: 'possible_bounce_cleared' | 'possible_bounce_confirmed'): Promise<Answer | null> {
  const r = await withSubjectLock(coldRef(contactId), actor, 'edit', async (tx) => {
    const c = await tx.sandboxContact.findUniqueOrThrow({ where: { id: contactId }, select: { possibleBounceAt: true } });
    if (!c.possibleBounceAt) throw new RefusedError(refuse('not_allowed', 'There is no possible bounce on this contact any more: someone settled it already.'));
    await tx.sandboxContact.update({ where: { id: contactId }, data: { possibleBounceAt: null } });
    await logAudit({ entityType: 'sandbox_contact', entityId: contactId, action, actor: audit, details: { possibleBounceAt: c.possibleBounceAt.toISOString() } }, tx);
  }, { audit });
  return r.ok ? null : { ok: false, error: r.reason };
}

/** The rep checked the address and it is fine: the badge goes and nothing else changes. */
export async function clearPossibleBounce(contactId: string, actor: GuardActor, audit: AuditActor): Promise<Answer> {
  return (await settlePossibleBounce(contactId, actor, audit, 'possible_bounce_cleared')) ?? { ok: true, message: 'Cleared. The address stays as it is.' };
}

/** The rep confirmed it: the same rule as a bounce seen in the mailbox, and as the "Email bounced" skip (N060). */
export async function confirmPossibleBounce(contactId: string, actor: GuardActor, audit: AuditActor): Promise<Answer> {
  const refused = await settlePossibleBounce(contactId, actor, audit, 'possible_bounce_confirmed');
  if (refused) return refused;
  const r = await bounceDetected({ sandboxContactId: contactId }, { actor: audit });
  return { ok: true, message: r.exited ? 'Marked bounced. Their campaign ended.' : r.skipped ? 'Marked bounced. Their open email steps were skipped.' : 'Marked bounced.' };
}

// ---------------------------------------------------------------------------
// The CRM's mail sync (N028)
// ---------------------------------------------------------------------------

/**
 * The addresses in an email that belong to a live cold contact and to no real CRM person: nobody in
 * the CRM, or only the person Twenty's mail sync made for the contact (which the cleanup removes).
 * Mail with these addresses is the cold contact's, not a CRM person's. Returns each address with the
 * CRM people to leave out for it.
 */
export async function coldOnlyAddresses(participants: Array<{ handle: string | null | undefined; personId?: string | null }>): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const wanted = [...new Set(participants.map((p) => normalizeEmail(p.handle)).filter((h): h is string => Boolean(h)))];
  if (!wanted.length) return out;
  const contacts = (await coldContactsByAddress(wanted)).filter((c) => c.status === 'ACTIVE');
  if (!contacts.length) return out;
  // Whoever holds the address in Cadence's copy of the CRM, and whoever Twenty linked to it on the email.
  const linked = [...new Set(participants.flatMap((p) => (p.personId ? [p.personId] : [])))];
  const people = await prisma.personCache.findMany({ where: { deletedAt: null, OR: [{ emailNorm: { in: wanted } }, { additionalEmailsNorm: { hasSome: wanted } }, { id: { in: linked } }] }, select: { id: true, emailNorm: true, additionalEmailsNorm: true, createdBySource: true, createdByName: true, raw: true } });
  for (const address of wanted) {
    const contact = contacts.find((c) => addressesOf(c).includes(address));
    if (!contact) continue;
    const ids = new Set(participants.filter((p) => p.personId && normalizeEmail(p.handle) === address).map((p) => p.personId!));
    const holders = people.filter((p) => p.emailNorm === address || p.additionalEmailsNorm.includes(address) || ids.has(p.id));
    if (holders.every((p) => autoCreatedFor(p, contact))) out.set(address, [...new Set([...holders.map((p) => p.id), ...ids])]);
  }
  return out;
}
