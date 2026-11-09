import type { Prisma, SandboxContact } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { exitEnrollment, OCCUPYING_STATUSES } from '../engine/enrollment';
import { afterResponse, retryDelayMs } from '../engine/sync-out';
import { pushNextAction } from '../next-actions';
import { getTwentyClient } from '../twenty';
import { ownWriteStamp } from '../twenty/own-writes';
import { isRoleEmail, normalizeLinkedin, personalPhone, readExtraPhones, toE164 } from '../sandbox/normalize';
import { addKeptSuppressions, addSuppressions, keepKeys, personKeys, readKeptKeys, widenedKeys } from '../sandbox/suppression';
import { OWN_DETAIL_MATCHES } from '../sandbox/status';
import { coldRef, personRef } from '../subject';
import { refuse, withSubjectLock, type GuardActor, type Refusal } from './guard';
import { scrub } from './scrub';

/**
 * The contact state machine (cold outreach PLAN 8.5). Each move between states is one function and
 * one transaction, under the contact's row lock (guard.ts):
 *   ACTIVE -> OPTED_OUT   opt out (contact page, "Asked not to be contacted", the suppress endpoint, a suppression hit)
 *   ACTIVE -> REMOVED     Remove, or retention
 *   REMOVED -> OPTED_OUT  opting out a tombstone, from the keys it kept (N027)
 *   MOVED -> (opted out)  through the CRM person it became
 *   OPTED_OUT -> ACTIVE   lifting a post-call-form opt-out (D4)
 *   any -> OPTED_OUT      Erase, with every detail cleared
 * (ACTIVE -> MOVED and back are Move and Undo, in sandbox/move.ts.)
 * Each one: a conditional status update, the open next step cancelled, running enrollments ended
 * with a labelled reason, the contact dropped from campaigns that have not started, statusChangedAt
 * stamped from the database clock, and an audit row. Opt-out and Remove racing end as an opt-out
 * (N026): both take the lock, and Remove only changes an ACTIVE contact that was never opted out.
 */

export type OptOutSource = 'call_form' | 'contact_page' | 'suppression_list' | 'skip_reason' | 'erase' | 'bellwether' | 'person_page';
export type TransitionOptions = { actor: AuditActor; /** The signed-in user the guard judges; null for Cadence itself. */ guard?: GuardActor | null; now?: Date; createdById?: string | null };
export type OptOutOptions = TransitionOptions & { source: OptOutSource; reason?: string | null; /** False for the opt-outs one opt-out causes (N025), so they do not cascade. */ sweep?: boolean; endSequences?: boolean };
export type TransitionResult = { ok: true; changed: boolean } | Refusal;

type Tx = Prisma.TransactionClient;

/** The database's clock, for statusChangedAt: Bellwether reads changes since a time, so every app server must agree (8.5). */
async function dbNow(tx: Tx): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return row.now;
}

/** Cancel the cold contact's open next step and take it out of cold campaigns that have not started. */
async function closeColdWork(tx: Tx, contactId: string, now: Date) {
  await tx.nextAction.updateMany({ where: { sandboxContactId: contactId, personId: null, state: 'OPEN' }, data: { state: 'CANCELLED', closedAt: now } });
  await tx.$executeRaw`UPDATE "Campaign" SET "personIds" = array_remove("personIds", ${contactId}), "updatedAt" = now() WHERE audience::text = 'SANDBOX' AND status::text IN ('DRAFT', 'PENDING_APPROVAL', 'SCHEDULED') AND ${contactId} = ANY("personIds")`;
}

/**
 * A removed or erased contact's calls still waiting for their form are discarded (owner, 9 Nov 2026):
 * there is no one left to write it about, so the notice and the Call button's wait end with them.
 */
export const GONE_CONTACT_DISCARD = 'The contact was removed, so the call needs no form.';
async function discardWaitingForms(tx: Tx, contactId: string, now: Date) {
  return tx.callLog.updateMany({ where: { sandboxContactId: contactId, personId: null, formDueAt: { not: null }, formDoneAt: null, discardedAt: null }, data: { discardedAt: now, discardReason: GONE_CONTACT_DISCARD } });
}

/** End the subject's running enrollments with a labelled reason ("opted_out", "removed"), after the transaction. */
async function endEnrollments(where: Prisma.EnrollmentWhereInput, reason: string, actor: AuditActor, now: Date) {
  const running = await prisma.enrollment.findMany({ where: { ...where, status: { in: OCCUPYING_STATUSES } }, select: { id: true } });
  for (const e of running) await exitEnrollment(e.id, { reason, actor, now });
  return running.length;
}

// ---------------------------------------------------------------------------
// Opt out
// ---------------------------------------------------------------------------

/** Opt a cold contact out, whatever its state: a moved contact through its CRM person, a removed one from the keys it kept. */
export async function optOutContact(contactId: string, opts: OptOutOptions): Promise<TransitionResult> {
  const now = opts.now ?? new Date();
  // Filled inside the lock: what to do once it is released.
  const seen: { movedTo: string | null; contact: SandboxContact | null } = { movedTo: null, contact: null };
  const r = await withSubjectLock(coldRef(contactId), opts.guard ?? null, 'opt_out', async (tx) => {
    const c = (await tx.sandboxContact.findUnique({ where: { id: contactId } }))!;
    seen.contact = c;
    const stamp = await dbNow(tx);
    const meta = { reason: 'opted_out' as const, source: opts.source, sandboxContactId: c.id, createdById: opts.createdById ?? null };
    if (c.status === 'MOVED') {
      // The person is in the CRM now: opted out there (below), and the tombstone reads opted_out.
      seen.movedTo = c.twentyPersonId;
      if (!c.optedOutAt) await tx.sandboxContact.update({ where: { id: c.id }, data: { optedOutAt: now, optOutReason: opts.reason ?? opts.source, optOutSource: opts.source, statusChangedAt: stamp } });
      if (!c.piiClearedAt) await addSuppressions(widenedKeys(c, c.twentyPersonId ?? c.id), { ...meta, personId: c.twentyPersonId }, tx);
      return !c.optedOutAt;
    }
    if (c.status === 'REMOVED') {
      // N027: a tombstone is opted out from the keys it kept when its details were cleared.
      await addKeptSuppressions(readKeptKeys(c.keptKeys), meta, tx);
      if (!c.piiClearedAt) await addSuppressions(widenedKeys(c, c.id), meta, tx);
    } else {
      await addSuppressions(widenedKeys(c, c.id), meta, tx);
    }
    const changed = await tx.sandboxContact.updateMany({ where: { id: c.id, status: { in: ['ACTIVE', 'REMOVED'] } }, data: { status: 'OPTED_OUT', optedOutAt: now, optOutReason: opts.reason ?? opts.source, optOutSource: opts.source, statusChangedAt: stamp } });
    if (!changed.count) return false;
    await closeColdWork(tx, c.id, now);
    await logAudit({ entityType: 'sandbox_contact', entityId: c.id, action: 'opted_out', actor: opts.actor, details: { source: opts.source, reason: opts.reason ?? null, from: c.status } }, tx);
    return true;
  }, { audit: opts.actor, now });
  if (!r.ok) {
    // Opting out twice is not a failure: the stop request is honoured either way.
    if (r.code === 'already_opted_out') return { ok: true, changed: false };
    return r;
  }
  if (seen.movedTo) {
    const p = await optOutPerson(seen.movedTo, { ...opts, guard: null });
    return { ok: true, changed: r.value || (p.ok && p.changed) };
  }
  if (opts.endSequences !== false) await endEnrollments({ sandboxContactId: contactId }, 'opted_out', opts.actor, now);
  // N025: every other live record of the same person goes too, and the CRM person who is "Also in CRM".
  if (opts.sweep !== false && seen.contact) await sweepSamePerson(seen.contact, opts, now);
  return { ok: true, changed: r.value };
}

/**
 * Opt a CRM person out (B007, D6, N011): Cadence's flag, the person's own keys on the suppression
 * list (a CRM phone for this person only), their open next actions cancelled, their pending steps
 * ended, the moved contact's tombstone and only the refusals that matched on their own details, and
 * then the CRM itself: Do not contact set and the Next Action cleared, each write logged.
 */
export async function optOutPerson(personId: string, opts: OptOutOptions): Promise<TransitionResult> {
  const now = opts.now ?? new Date();
  const seen = { hadCrmFlag: false, crmNextAction: false, cancelled: [] as string[] };
  const r = await withSubjectLock(personRef(personId), opts.guard ?? null, 'opt_out', async (tx) => {
    const p = (await tx.personCache.findUnique({ where: { id: personId } }))!;
    seen.hadCrmFlag = p.dnd;
    const stamp = await dbNow(tx);
    const changed = !p.optedOut;
    if (changed) {
      await tx.personCache.update({ where: { id: personId }, data: { optedOut: true, optedOutAt: now, optOutSource: opts.source, optOutLiftedAt: null } });
      await logAudit({ entityType: 'person', entityId: personId, action: 'flags_updated', actor: opts.actor, details: { optedOut: true, source: opts.source } }, tx);
    }
    await addSuppressions(personKeys(p), { reason: 'opted_out', source: opts.source, personId, createdById: opts.createdById ?? null }, tx);
    await tx.sandboxContact.updateMany({ where: { twentyPersonId: personId, optedOutAt: null }, data: { optedOutAt: now, optOutReason: opts.reason ?? opts.source, optOutSource: opts.source, statusChangedAt: stamp } });
    // N011: a refusal matched on a shared office line belongs to a colleague; it stays as it was.
    await tx.bellwetherRefusal.updateMany({ where: { crmPersonId: personId, status: { not: 'opted_out' }, matchedOn: { in: OWN_DETAIL_MATCHES } }, data: { status: 'opted_out', statusChangedAt: stamp } });
    const open = await tx.nextAction.findMany({ where: { personId, state: 'OPEN' }, select: { id: true } });
    seen.cancelled = open.map((n) => n.id);
    if (seen.cancelled.length) await tx.nextAction.updateMany({ where: { id: { in: seen.cancelled } }, data: { state: 'CANCELLED', closedAt: now, crmPending: true } });
    seen.crmNextAction = Boolean(p.nextAction || p.nextActionDueDate);
    if (seen.crmNextAction) await tx.personCache.update({ where: { id: personId }, data: { nextAction: null, nextActionDueDate: null } });
    await tx.$executeRaw`UPDATE "Campaign" SET "personIds" = array_remove("personIds", ${personId}), "updatedAt" = now() WHERE audience::text = 'CRM' AND status::text IN ('DRAFT', 'PENDING_APPROVAL', 'SCHEDULED') AND ${personId} = ANY("personIds")`;
    if (changed || seen.cancelled.length) await logAudit({ entityType: 'person', entityId: personId, action: 'opted_out', actor: opts.actor, details: { source: opts.source, reason: opts.reason ?? null, nextActionsCancelled: seen.cancelled.length } }, tx);
    return changed;
  }, { audit: opts.actor, now });
  if (!r.ok) return r.code === 'already_opted_out' ? { ok: true, changed: false } : r;
  if (opts.endSequences !== false) await endEnrollments({ personId }, 'opted_out', opts.actor, now);
  const ids = seen.cancelled;
  const clearDirectly = seen.crmNextAction && !ids.length;
  const setFlag = !seen.hadCrmFlag;
  await afterResponse(async () => {
    for (const id of ids) await pushNextAction(id);
    await writeCrmDoNotContact(personId, { dnd: setFlag ? true : null, clearNextAction: clearDirectly });
  });
  if (opts.sweep !== false) {
    const p = await prisma.personCache.findUnique({ where: { id: personId } });
    if (p) {
      // The same person's cold records: "Also in CRM" ones, and those with their own email or LinkedIn.
      const emails = [p.emailNorm, ...p.additionalEmailsNorm].filter((e): e is string => Boolean(e) && !isRoleEmail(e));
      const linkedin = normalizeLinkedin(p.linkedinUrl);
      const twins = await prisma.sandboxContact.findMany({ where: { status: 'ACTIVE', OR: [{ crmMatchPersonId: personId }, { crmAutoPersonId: personId }, ...(emails.length ? [{ email: { in: emails } }, { additionalEmails: { hasSome: emails } }] : []), ...(linkedin ? [{ linkedinUrl: linkedin }] : [])] }, select: { id: true } });
      for (const t of twins) await optOutContact(t.id, { ...opts, guard: null, sweep: false, source: opts.source === 'call_form' ? 'suppression_list' : opts.source, reason: 'The same person was opted out in the CRM.' });
    }
  }
  return { ok: true, changed: r.value };
}

/** Opt out whichever subject a row is about: the person once a contact has moved, else the cold contact. */
export async function optOutRow(row: { personId?: string | null; sandboxContactId?: string | null }, opts: OptOutOptions): Promise<TransitionResult> {
  if (row.personId) return optOutPerson(row.personId, opts);
  if (row.sandboxContactId) return optOutContact(row.sandboxContactId, opts);
  return { ok: true, changed: false };
}

/**
 * N025: the other live records of the same person (a manual add that raced a push, a second
 * Bellwether record) are opted out with it: same personal email, CRD, LinkedIn or direct/mobile
 * phone; shared inboxes and shared lines never count. And the CRM person it is "Also in CRM" as.
 */
async function sweepSamePerson(c: SandboxContact, opts: OptOutOptions, now: Date) {
  const follow: OptOutOptions = { ...opts, guard: null, sweep: false, now, source: opts.source === 'call_form' ? 'suppression_list' : opts.source, reason: 'The same person was opted out on another record.' };
  const emails = [c.email, ...c.additionalEmails].filter((e): e is string => Boolean(e) && !isRoleEmail(e));
  const phones = [{ number: c.phone, type: c.phoneType }, ...readExtraPhones(c.additionalPhones)].filter((p) => personalPhone(p.type)).map((p) => toE164(p.number)).filter((n): n is string => Boolean(n));
  const or: Prisma.SandboxContactWhereInput[] = [
    ...(emails.length ? [{ email: { in: emails } }, { additionalEmails: { hasSome: emails } }] : []),
    ...(c.individualCrd ? [{ individualCrd: c.individualCrd }] : []),
    ...(c.linkedinUrl ? [{ linkedinUrl: c.linkedinUrl }] : []),
    ...phones.map((n) => ({ phone: n, phoneType: { in: ['direct', 'mobile'] } })),
  ];
  if (or.length) {
    const twins = await prisma.sandboxContact.findMany({ where: { id: { not: c.id }, status: { in: ['ACTIVE', 'MOVED'] }, optedOutAt: null, OR: or }, select: { id: true } });
    for (const t of twins) await optOutContact(t.id, follow);
  }
  for (const personId of new Set([c.crmMatchPersonId, c.crmAutoPersonId].filter((id): id is string => Boolean(id)))) await optOutPerson(personId, follow);
}

// ---------------------------------------------------------------------------
// The CRM's own flag (D6)
// ---------------------------------------------------------------------------

/**
 * Set (or clear) the person's Do not contact field in the CRM, and clear their Next Action, each
 * write logged in TwentyWrite like Cadence's other CRM writes; a write Twenty refuses waits in the
 * outbox and the worker sends it again (sync-retry.ts). Never called while a row lock is held.
 */
export async function writeCrmDoNotContact(personId: string, what: { dnd: boolean | null; clearNextAction?: boolean }): Promise<void> {
  const writes: Array<{ operation: 'setPersonDnd' | 'setPersonNextAction'; payload: Record<string, unknown> }> = [];
  if (what.dnd !== null) writes.push({ operation: 'setPersonDnd', payload: { id: personId, dnd: what.dnd } });
  if (what.clearNextAction) writes.push({ operation: 'setPersonNextAction', payload: { id: personId, nextAction: null, nextActionDueDate: null } });
  if (!writes.length) return;
  let client: Awaited<ReturnType<typeof getTwentyClient>> | null = null;
  try { client = await getTwentyClient(); } catch { client = null; }
  for (const w of writes) {
    try {
      if (!client) throw new Error('The CRM is not configured.');
      if (w.operation === 'setPersonDnd') await client.setPersonDnd(personId, { dnd: Boolean(w.payload.dnd) });
      else await client.setPersonNextAction(personId, { nextAction: null, nextActionDueDate: null });
      if (client.kind !== 'dry-run') await prisma.twentyWrite.create({ data: { operation: w.operation, objectType: 'person', twentyId: personId, payload: w.payload as Prisma.InputJsonValue, dryRun: false, resultUpdatedAt: await ownWriteStamp(client, personId) } });
      if (w.operation === 'setPersonDnd') await prisma.personCache.updateMany({ where: { id: personId }, data: w.payload.dnd ? { dnd: true, dndReason: 'DO_NOT_DISTURB' } : { dnd: false, dndReason: null } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[opt-out] could not ${w.operation} in Twenty for ${personId}: ${message}`);
      await prisma.twentyWrite.create({ data: { operation: w.operation, objectType: 'person', twentyId: personId, payload: w.payload as Prisma.InputJsonValue, dryRun: false, status: 'FAILED', error: message.slice(0, 1000), attempts: 1, nextAttemptAt: new Date(Date.now() + retryDelayMs(1)) } }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Remove and erase
// ---------------------------------------------------------------------------

/** What a tombstone keeps: ids, status and dates. Its keys are kept as hashes (keptKeys). */
export const PII_CLEARED: Prisma.SandboxContactUpdateInput = {
  firstName: '', lastName: '', sortName: null, jobTitle: null, email: null, emailVerification: null, additionalEmails: [], phone: null, phoneType: null,
  phoneExtension: null, additionalPhones: [], linkedinUrl: null, city: null, state: null, individualCrd: null, designations: [], tags: [],
  companyName: null, companyDomain: null, companyWebsite: null, companyCrd: null, companyCity: null, companyState: null, companyPhone: null,
  companyAumUsd: null, companyEmployees: null, bellwetherUrl: null, sourceNote: null, pushedByEmail: null, pushedByName: null, optOutReason: null, removedReason: null,
};

/**
 * ACTIVE -> REMOVED, by a user (with a reason) or by retention. Personal data is cleared from the row
 * and everywhere else (scrub, B054); its keys stay as hashes so it can still be opted out (N027).
 * Bellwether reads `removed` and may push the person again.
 */
export async function removeContact(contactId: string, opts: TransitionOptions & { reason?: string | null }): Promise<TransitionResult> {
  const now = opts.now ?? new Date();
  const r = await withSubjectLock(coldRef(contactId), opts.guard ?? null, 'remove', async (tx) => {
    const c = (await tx.sandboxContact.findUnique({ where: { id: contactId } }))!;
    const stamp = await dbNow(tx);
    // N026: only an active contact nobody opted out; an opt-out that got here first wins.
    const changed = await tx.sandboxContact.updateMany({ where: { id: c.id, status: 'ACTIVE', optedOutAt: null }, data: { ...(PII_CLEARED as Prisma.SandboxContactUpdateManyMutationInput), status: 'REMOVED', statusChangedAt: stamp, piiClearedAt: now, removedById: opts.actor.type === 'USER' ? opts.actor.id ?? null : null, removedReason: opts.reason?.trim().slice(0, 500) || null, keptKeys: keepKeys(widenedKeys(c, c.id)) as unknown as Prisma.InputJsonValue } });
    if (!changed.count) return false;
    await scrub(tx, c);
    await closeColdWork(tx, c.id, now);
    const discarded = await discardWaitingForms(tx, c.id, now);
    await logAudit({ entityType: 'sandbox_contact', entityId: c.id, action: 'removed', actor: opts.actor, details: { by: opts.actor.type === 'USER' ? 'user' : 'retention', hasReason: Boolean(opts.reason?.trim()), formsDiscarded: discarded.count } }, tx);
    return true;
  }, { audit: opts.actor, now });
  if (!r.ok) return r;
  if (r.value) await endEnrollments({ sandboxContactId: contactId }, 'removed', opts.actor, now);
  return { ok: true, changed: r.value };
}

/**
 * Erase (an admin, for a GDPR or California request): the person is opted out for good (their keys
 * suppressed, a direct or mobile phone for anyone, any other line for them only), then every piece of
 * personal data in Cadence goes. Recordings live in Twilio; their ids come back for an admin to
 * delete there. A moved contact is erased in the CRM.
 */
export async function eraseContact(contactId: string, opts: TransitionOptions): Promise<{ ok: true; recordings: string[] } | Refusal> {
  const now = opts.now ?? new Date();
  const seen: { before: SandboxContact | null } = { before: null };
  const r = await withSubjectLock(coldRef(contactId), opts.guard ?? null, 'erase', async (tx) => {
    const c = (await tx.sandboxContact.findUnique({ where: { id: contactId } }))!;
    if (c.status === 'MOVED') return null;
    seen.before = c;
    const stamp = await dbNow(tx);
    const meta = { reason: 'erased' as const, source: 'erase', sandboxContactId: c.id, createdById: opts.createdById ?? null };
    const keys = c.piiClearedAt ? [] : widenedKeys(c, c.id);
    await addSuppressions(keys, meta, tx);
    await addKeptSuppressions(readKeptKeys(c.keptKeys), meta, tx);
    const { recordings } = await scrub(tx, c);
    await tx.sandboxEmail.deleteMany({ where: { sandboxContactId: c.id } });
    await tx.sandboxContact.update({
      where: { id: c.id },
      data: {
        ...PII_CLEARED, status: 'OPTED_OUT', piiClearedAt: now, erasedAt: now, statusChangedAt: stamp,
        ...(c.optedOutAt ? {} : { optedOutAt: now, optOutSource: 'erase' }),
        keptKeys: (keys.length ? keepKeys(keys) : readKeptKeys(c.keptKeys)) as unknown as Prisma.InputJsonValue,
      },
    });
    await closeColdWork(tx, c.id, now);
    const discarded = await discardWaitingForms(tx, c.id, now);
    await logAudit({ entityType: 'sandbox_contact', entityId: c.id, action: 'erased', actor: opts.actor, details: { recordings: recordings.length, from: c.status, formsDiscarded: discarded.count } }, tx);
    return recordings;
  }, { audit: opts.actor, now });
  if (!r.ok) return r;
  if (r.value === null) return refuse('moved', 'This contact is in the CRM now. Erase the person in the CRM.');
  await endEnrollments({ sandboxContactId: contactId }, 'opted_out', opts.actor, now);
  if (seen.before) await sweepSamePerson(seen.before, { ...opts, source: 'erase', sweep: false }, now);
  return { ok: true, recordings: r.value };
}

// ---------------------------------------------------------------------------
// Lifting a form opt-out (D4)
// ---------------------------------------------------------------------------

/**
 * OPTED_OUT -> ACTIVE, for an opt-out that came from the post-call form only: any admin at any time,
 * or Biz Ops closing its "Think this is wrong?" ticket (D4, owner 5 Nov). It removes only that
 * opt-out's own suppression rows, restarts nothing, stamps optOutLiftedAt (Bellwether reads it), and
 * clears the CRM's Do not contact when Cadence's opt-out set it. Every lift is audited.
 */
export async function liftOptOut(ref: { kind: 'cold' | 'person'; id: string }, opts: TransitionOptions & { viaTicket?: boolean }): Promise<TransitionResult> {
  const now = opts.now ?? new Date();
  const seen: { personId: string | null; since: Date | null } = { personId: null, since: null };
  const r = await withSubjectLock(ref, opts.guard ?? null, 'lift_opt_out', async (tx) => {
    const stamp = await dbNow(tx);
    if (ref.kind === 'cold') {
      const c = (await tx.sandboxContact.findUnique({ where: { id: ref.id } }))!;
      if (c.status !== 'OPTED_OUT' || c.optOutSource !== 'call_form') return false;
      await tx.suppression.deleteMany({ where: { sandboxContactId: c.id, source: 'call_form' } });
      await tx.sandboxContact.update({ where: { id: c.id }, data: { status: 'ACTIVE', optedOutAt: null, optOutReason: null, optOutSource: null, optOutLiftedAt: now, statusChangedAt: stamp } });
      await logAudit({ entityType: 'sandbox_contact', entityId: c.id, action: 'opt_out_lifted', actor: opts.actor, details: { viaTicket: Boolean(opts.viaTicket), optedOutAt: c.optedOutAt?.toISOString() ?? null } }, tx);
      return true;
    }
    const p = (await tx.personCache.findUnique({ where: { id: ref.id } }))!;
    if (!p.optedOut || p.optOutSource !== 'call_form') return false;
    seen.personId = p.id;
    seen.since = p.optedOutAt;
    await tx.suppression.deleteMany({ where: { personId: p.id, source: 'call_form' } });
    await tx.personCache.update({ where: { id: p.id }, data: { optedOut: false, optedOutAt: null, optOutSource: null, optOutLiftedAt: now } });
    await tx.sandboxContact.updateMany({ where: { twentyPersonId: p.id, optOutSource: 'call_form' }, data: { optedOutAt: null, optOutReason: null, optOutSource: null, optOutLiftedAt: now, statusChangedAt: stamp } });
    // A push refused because this person had opted out reads already_in_crm again, with the lift
    // (optOutLiftedAt), so Bellwether lifts only the opt-out it was sent (contract 1.1, D4). One that
    // matched by name and firm stays: the CRM's own Do not contact may still stand.
    await tx.bellwetherRefusal.updateMany({ where: { crmPersonId: p.id, status: 'opted_out', matchedOn: { in: OWN_DETAIL_MATCHES.filter((m) => m !== 'name_firm') } }, data: { status: 'already_in_crm', statusChangedAt: stamp } });
    await logAudit({ entityType: 'person', entityId: p.id, action: 'opt_out_lifted', actor: opts.actor, details: { viaTicket: Boolean(opts.viaTicket), optedOutAt: p.optedOutAt?.toISOString() ?? null } }, tx);
    return true;
  }, { audit: opts.actor, now, viaTicket: opts.viaTicket });
  if (!r.ok) return r;
  if (seen.personId) {
    // Only the Do not contact Cadence itself set is cleared: one the team set in the CRM stays.
    const id = seen.personId;
    const ours = await prisma.twentyWrite.findFirst({ where: { operation: 'setPersonDnd', twentyId: id, ...(seen.since ? { createdAt: { gte: seen.since } } : {}) }, orderBy: { createdAt: 'desc' }, select: { payload: true } });
    if ((ours?.payload as { dnd?: boolean } | null)?.dnd === true) {
      await afterResponse(async () => { await writeCrmDoNotContact(id, { dnd: false }); });
    }
  }
  return { ok: true, changed: r.value };
}
