import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { formatLocalDate, todayIn } from '../dates';
import { getSettings } from '../settings';
import { callOutcomes } from '../engine/outcomes';
import { PRODUCTS } from '../workspace';
import { optionLabel } from '../twenty/labels';
import { coldRef, personRef, subjectHref } from '../subject';
import { audienceFor, callPodFor } from '../outreach/audience';
import { formHolderOf } from './form-holder';
import { callStepChoices, ownerOfSubject, runningEnrollment } from './link';
import { recordCallTouch } from './call-log';
import { defaultNextStepDate, outcomeGroup, SILENT_OUTCOMES, type OutcomeGroup } from './form';
import { callTimeWords, talkWords } from './words';

/**
 * What the post-call form shows for one call (cold outreach PLAN 4.6), read when it opens: who the call
 * was with (or "Who did you speak to?": B026), what it closes ("Closes Call 2 of Q4 Harbor" or "Extra
 * call: closes nothing", N013), what happens next by default (B028, B093), the owner's next step a
 * colleague's form leaves alone (B027), "Saving claims Jane for you" (B092), the contact's standing
 * when it is no longer active (B004, B029), and the talk time that greys out No answer and Busy (B025).
 * Also a mistaken call's discard (B024) and the rep naming who an unmatched call was with.
 */

export type FormOutcomeView = { key: string; label: string; answered: boolean; group: OutcomeGroup; disabled: string | null };
export type CallFormContext = {
  callId: string;
  incoming: boolean;
  /** "Jane Doe", or null when nobody is matched yet. */
  name: string | null;
  number: string | null;
  /** "yesterday 20:20 CT" (N096). */
  at: string;
  talk: string | null;
  who: null | { kind: 'person' | 'cold'; id: string; href: string; active: boolean; standing: string | null; firstName: string };
  /** An ambiguous call's possible people: a shared or firm line (B018). */
  candidates: { key: string; name: string; cold: boolean }[];
  closes: { linked: { key: string; words: string } | null; choices: { key: string; words: string; repeats: boolean }[] };
  /** The next step the call leaves open, as it reads. */
  open: { words: string; repeats: boolean; mine: boolean; foName: string } | null;
  campaign: { name: string; next: string | null } | null;
  /** B027: "Jane is Alisa's contact. Her next step stays; yours goes to her as a suggestion." */
  colleague: string | null;
  /** B092: "Saving claims Jane for you." */
  claim: string | null;
  outcomes: FormOutcomeView[];
  products: { key: string; label: string }[];
  /** The outcome the call's Twilio status suggests. */
  prefill: string | null;
  defaultDate: string;
  today: string;
  /** Why the call cannot be discarded now, or null when it can (B024). */
  discard: string | null;
};

const PREFILL: Record<string, string> = { busy: 'busy', 'no-answer': 'no_answer', failed: 'no_answer', canceled: 'no_answer' };
export const DISCARD_WINDOW_MS = 24 * 3600_000;

type Viewer = { id: string; timezone: string };

/** Why this call can't be discarded by this user now, or null. */
function discardRefusal(call: { formDoneAt: Date | null; discardedAt: Date | null; startedAt: Date | null; createdAt: Date; userId: string | null; formUserId: string | null }, user: Viewer, now: Date): string | null {
  if (call.discardedAt) return 'This call was discarded already.';
  if (call.formDoneAt) return 'Its form is in, so it stays.';
  if (formHolderOf(call) !== user.id) return 'Only the rep whose form it is can discard it.';
  if (now.getTime() - (call.startedAt ?? call.createdAt).getTime() > DISCARD_WINDOW_MS) return 'A call can be discarded only within 24 hours.';
  return null;
}

export async function callFormContext(callId: string, user: Viewer, now = new Date()): Promise<{ ok: true; context: CallFormContext } | { ok: false; error: string }> {
  const call = await prisma.callLog.findUnique({ where: { id: callId }, include: { form: true, person: { select: { firstName: true, lastName: true, optedOut: true, dnd: true, deletedAt: true } }, sandboxContact: { select: { firstName: true, lastName: true, status: true, ownerId: true, owner: { select: { name: true, active: true } }, optedOutAt: true, statusChangedAt: true } } } });
  if (!call) return { ok: false, error: 'This call is no longer in Cadence.' };
  if (call.form || call.formDoneAt) return { ok: false, error: 'This call already has its form: it was saved, perhaps in another tab.' };
  if (call.discardedAt) return { ok: false, error: 'This call was discarded, so it needs no form.' };
  if (formHolderOf(call) !== user.id) return { ok: false, error: 'This form is someone else\'s to fill in.' };
  const settings = await getSettings();
  const subject = { personId: call.personId, sandboxContactId: call.personId ? null : call.sandboxContactId };
  const today = todayIn(user.timezone, now);
  const incoming = call.direction === 'INBOUND';

  let who: CallFormContext['who'] = null;
  if (call.person) {
    const name = `${call.person.firstName} ${call.person.lastName}`.trim() || 'This person';
    const standing = call.person.deletedAt ? `${name} is no longer in the CRM, so no next step will be set.` : call.person.optedOut ? `You called someone who asked not to be contacted. The call and form are kept; no next step will be set.` : call.person.dnd ? `${name} is marked Do not contact in the CRM. The call and form are kept; no next step will be set.` : null;
    who = { kind: 'person', id: call.personId!, href: subjectHref(personRef(call.personId!)), active: !standing, standing, firstName: call.person.firstName || name };
  } else if (call.sandboxContact) {
    const c = call.sandboxContact;
    const name = `${c.firstName} ${c.lastName}`.trim() || 'This contact';
    // B004, B029: a contact no longer active keeps the call and its form, and gets no next step.
    const standing = c.status === 'OPTED_OUT' ? 'You called a contact who asked not to be contacted. The call and form are kept; no next step will be set.' : c.status === 'REMOVED' ? 'This contact was removed from Cold outreach. The call and form are kept; no next step will be set.' : c.status === 'MOVED' ? `${name} is in the CRM now. The call and form are kept; set the next step on their People page.` : null;
    who = { kind: 'cold', id: call.sandboxContactId!, href: subjectHref(coldRef(call.sandboxContactId!)), active: !standing, standing, firstName: c.firstName || name };
  }
  const name = call.person ? `${call.person.firstName} ${call.person.lastName}`.trim() : call.sandboxContact ? `${call.sandboxContact.firstName} ${call.sandboxContact.lastName}`.trim() || 'Removed contact' : null;
  const candidates = (Array.isArray(call.candidates) ? (call.candidates as { kind?: string; id?: string; name?: string }[]) : []).filter((c) => c?.id).map((c) => ({ key: `${c.kind === 'person' ? 'person' : 'sandbox'}:${c.id}`, name: c.name || 'Unnamed', cold: c.kind !== 'person' }));

  const { linked, choices } = incoming ? { linked: null, choices: [] } : await callStepChoices(call);
  const running = who?.active ? await runningEnrollment(subject) : null;
  const openWhere = subject.personId ? { personId: subject.personId } : subject.sandboxContactId ? { sandboxContactId: subject.sandboxContactId, personId: null } : null;
  const openRow = openWhere && who?.active ? await prisma.nextAction.findFirst({ where: { ...openWhere, state: 'OPEN' }, include: { fo: { select: { name: true } } } }) : null;
  const closesOpen = linked?.kind === 'next' && linked.id === openRow?.id && !linked.repeats;
  const ownerId = who?.active ? await ownerOfSubject(subject) : null;
  const ownerName = call.sandboxContact?.owner?.active ? call.sandboxContact.owner.name : ownerId ? (await prisma.user.findUnique({ where: { id: ownerId }, select: { name: true } }))?.name ?? null : null;
  const first = who?.firstName ?? 'This contact';
  const colleague = who?.active && ownerId && ownerId !== user.id && (!openRow || openRow.foUserId !== user.id) ? `${first} is ${ownerName ?? 'someone else'}'s contact. ${openRow ? 'Their next step stays; yours goes to them as a suggestion.' : 'Your next step goes to them as a suggestion.'}` : null;
  const claim = who?.kind === 'cold' && who.active && !ownerId ? `Saving claims ${first} for you.` : null;
  const task = running?.tasks[0];

  const outcomes = callOutcomes(settings.rules).map((o) => {
    const talked = (call.talkSec ?? 0) >= settings.calling.connectSeconds;
    const disabled = talked && SILENT_OUTCOMES.has(o.key) ? `This call lasted ${talkWords(call.talkSec)}` : null;
    return { key: o.key, label: o.label, answered: o.answered, group: outcomeGroup(o), disabled };
  });
  const prefill = PREFILL[call.twilioStatus ?? ''] && outcomes.some((o) => o.key === PREFILL[call.twilioStatus ?? ''] && !o.disabled) ? PREFILL[call.twilioStatus ?? ''] : null;

  return {
    ok: true,
    context: {
      callId: call.id,
      incoming,
      name,
      number: incoming ? call.fromNumber : call.toNumber,
      at: callTimeWords(call.startedAt ?? call.createdAt, user.timezone, now),
      talk: talkWords(call.talkSec),
      who,
      candidates,
      closes: { linked: linked ? { key: `${linked.kind}:${linked.id}`, words: linked.words } : null, choices: choices.map((c) => ({ key: `${c.kind}:${c.id}`, words: c.words, repeats: c.repeats })) },
      open: openRow && !closesOpen ? { words: `${openRow.label} on ${formatLocalDate(openRow.dueDate)}`, repeats: openRow.repeat !== 'NONE', mine: openRow.foUserId === user.id, foName: openRow.fo.name } : null,
      campaign: running ? { name: running.campaign?.name ?? running.sequence.name, next: task ? `${task.label} on ${formatLocalDate(task.snoozedTo ?? task.dueDate)}` : null } : null,
      colleague,
      claim,
      outcomes,
      products: PRODUCTS.map((p) => ({ key: p, label: optionLabel(p) })),
      prefill,
      defaultDate: defaultNextStepDate(today, settings.rules.workingDays),
      today,
      discard: discardRefusal(call, user, now),
    },
  };
}

/** B024: a call logged or dialled by mistake, taken out before its form and within a day, with a reason leaders see. */
export async function discardCall(callId: string, reason: string, user: Viewer, actor: AuditActor, now = new Date()): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const why = reason.trim();
  if (!why) return { ok: false, error: 'Say why this call should not count.' };
  const call = await prisma.callLog.findUnique({ where: { id: callId } });
  if (!call) return { ok: false, error: 'Call not found.' };
  const refusal = discardRefusal(call, user, now);
  if (refusal) return { ok: false, error: refusal };
  const done = await prisma.callLog.updateMany({ where: { id: callId, formDoneAt: null, discardedAt: null }, data: { discardedAt: now, discardReason: why.slice(0, 500), touchId: null } });
  if (!done.count) return { ok: false, error: 'Its form was saved just now, so it stays.' };
  // Out of every count: its touch goes; the step it would have closed stays open.
  if (call.touchId) await prisma.touch.deleteMany({ where: { id: call.touchId } });
  await logAudit({ entityType: 'call', entityId: callId, action: 'call_discarded', actor, details: { reason: why.slice(0, 500) } });
  return { ok: true, message: 'Discarded. It counts nowhere, and you can call again.' };
}

/** B026: the rep says who their unmatched (or shared-line) call was with; the form then goes on for them. */
export async function chooseCallContact(callId: string, contact: string, user: Viewer, actor: AuditActor): Promise<{ ok: true } | { ok: false; error: string }> {
  const [kind, id] = contact.split(':');
  if (!id || (kind !== 'person' && kind !== 'sandbox')) return { ok: false, error: 'Choose who the call was with.' };
  const call = await prisma.callLog.findUnique({ where: { id: callId } });
  if (!call) return { ok: false, error: 'Call not found.' };
  if (formHolderOf(call) !== user.id) return { ok: false, error: 'This form is someone else\'s to fill in.' };
  if (call.formDoneAt || call.discardedAt) return { ok: false, error: 'This call already has its form.' };
  const exists = kind === 'person' ? await prisma.personCache.count({ where: { id, deletedAt: null } }) : await prisma.sandboxContact.count({ where: { id } });
  if (!exists) return { ok: false, error: kind === 'person' ? 'That person is no longer in the CRM.' : 'That contact is no longer in Cold outreach.' };
  const subject = { personId: kind === 'person' ? id : null, sandboxContactId: kind === 'sandbox' ? id : null };
  // Stamped once, when the call is matched (PLAN 8.4).
  const stamp: Prisma.CallLogUncheckedUpdateInput = { ...(call.audience ? {} : { audience: await audienceFor(subject) }), ...(call.podId ? {} : { podId: await callPodFor({ enrollmentId: call.enrollmentId, sandboxContactId: subject.sandboxContactId, userId: call.userId }) }) };
  const updated = await prisma.callLog.update({ where: { id: callId }, data: { ...subject, matchedBy: 'chosen', candidates: undefined, ...stamp } });
  if (updated.statusRank >= 4) await recordCallTouch(updated);
  await logAudit({ entityType: 'call', entityId: callId, action: 'contact_chosen', actor, details: { kind, id, by: 'rep' } });
  return { ok: true };
}

export type CallContactOption = { key: string; name: string; sub: string | null; cold: boolean };

/** "Who did you speak to?": CRM people and cold contacts by name, email, phone or firm (B026, B127). */
export async function searchCallContacts(query: string): Promise<CallContactOption[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const digits = q.replace(/\D/g, '');
  const words = q.split(/\s+/).filter(Boolean).slice(0, 3);
  const nameWhere = words.map((w) => ({ OR: [{ firstName: { contains: w, mode: 'insensitive' as const } }, { lastName: { contains: w, mode: 'insensitive' as const } }] }));
  const [people, cold] = await Promise.all([
    prisma.personCache.findMany({ where: { deletedAt: null, OR: [{ AND: nameWhere }, { email: { contains: q, mode: 'insensitive' } }, { companyName: { contains: q, mode: 'insensitive' } }, ...(digits.length >= 6 ? [{ phoneE164: { contains: digits } }] : [])] }, select: { id: true, firstName: true, lastName: true, companyName: true, jobTitle: true }, take: 8 }),
    prisma.sandboxContact.findMany({ where: { status: { in: ['ACTIVE', 'OPTED_OUT'] }, OR: [{ AND: nameWhere }, { email: { contains: q, mode: 'insensitive' } }, { companyName: { contains: q, mode: 'insensitive' } }, ...(digits.length >= 6 ? [{ phone: { contains: digits } }] : [])] }, select: { id: true, firstName: true, lastName: true, companyName: true, jobTitle: true, status: true }, take: 8 }),
  ]);
  return [
    ...people.map((p) => ({ key: `person:${p.id}`, name: `${p.firstName} ${p.lastName}`.trim() || 'Unnamed', sub: [p.jobTitle, p.companyName].filter(Boolean).join(' · ') || null, cold: false })),
    ...cold.map((c) => ({ key: `sandbox:${c.id}`, name: `${c.firstName} ${c.lastName}`.trim() || 'Unnamed', sub: [c.jobTitle, c.companyName, c.status === 'OPTED_OUT' ? 'Do not contact' : null].filter(Boolean).join(' · ') || null, cold: true })),
  ];
}

