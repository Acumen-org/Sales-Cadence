import type { ActionType, NextActionKind } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { formatLocalDate, isLocalDate, todayIn } from '../dates';
import { setNextActions } from '../next-actions';
import { setColdNextStep } from '../sandbox/work';
import { personRef } from '../subject';
import { canAct, loadSubject, type GuardActor } from './guard';
import { channelOfAction, contactability } from './contactability';

/**
 * A colleague's next step, offered to the owner instead of replacing theirs (B027, PLAN 4.6). It is a
 * Notification of kind next_step_suggestion carrying what, how, when and from whom. Accepting it runs
 * the same checks as setting a step by hand: the guard, then contactability; so a suggestion for a
 * contact opted out, removed or moved since is refused with the reason (PLAN 8.12). Dismissing it
 * changes nothing. The bell (S5) and the contact pages show it.
 */

export type SuggestionPayload = { what?: string; how?: ActionType | null; kind?: NextActionKind; when?: string | null; callId?: string; from?: string };
export type Suggestion = { id: string; from: string; what: string; how: ActionType | null; kind: NextActionKind; when: string | null; words: string; personId: string | null; sandboxContactId: string | null; createdAt: Date };

const ACTION_WORDS: Record<string, string> = { CALL: 'Call', EMAIL: 'Email', LINKEDIN_MESSAGE: 'LinkedIn message', LINKEDIN_CONNECT: 'LinkedIn connect' };

function asSuggestion(n: { id: string; payload: unknown; personId: string | null; sandboxContactId: string | null; createdAt: Date }): Suggestion {
  const p = (n.payload ?? {}) as SuggestionPayload;
  const kind = p.kind ?? 'ACTION';
  const what = p.what?.trim() || (kind === 'MEETING' ? 'Meeting' : ACTION_WORDS[p.how ?? ''] ?? 'Next step');
  const how = kind === 'MEETING' ? 'Meeting' : ACTION_WORDS[p.how ?? ''] ?? null;
  return { id: n.id, from: p.from ?? 'A colleague', what, how: p.how ?? null, kind, when: p.when ?? null, personId: n.personId, sandboxContactId: n.sandboxContactId, createdAt: n.createdAt, words: `${what}${how && how !== what ? ` (${how})` : ''}${p.when ? ` on ${formatLocalDate(p.when)}` : ''}` };
}

/** Open suggestions for this user, on one subject or all of them. */
export async function openSuggestions(userId: string, subject?: { personId?: string | null; sandboxContactId?: string | null }): Promise<Suggestion[]> {
  const where = subject?.personId ? { personId: subject.personId } : subject?.sandboxContactId ? { sandboxContactId: subject.sandboxContactId } : {};
  const rows = await prisma.notification.findMany({ where: { userId, kind: 'next_step_suggestion', resolution: null, ...where }, orderBy: { createdAt: 'desc' }, take: 20 });
  return rows.map(asSuggestion);
}

type Accepter = GuardActor & { name: string; timezone: string };

export async function acceptSuggestion(id: string, user: Accepter, actor: AuditActor & { id?: string | null }, now = new Date()): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const n = await prisma.notification.findUnique({ where: { id } });
  if (!n || n.userId !== user.id || n.kind !== 'next_step_suggestion') return { ok: false, error: 'This suggestion is not yours to accept.' };
  if (n.resolution) return { ok: false, error: `This suggestion was ${n.resolution} already.` };
  const s = asSuggestion(n);
  if (!s.how || !s.when || !isLocalDate(s.when)) return { ok: false, error: 'This suggestion has no step and day to set. Set the next step yourself.' };
  const today = todayIn(user.timezone, now);
  if (s.when < today) return { ok: false, error: `Its day (${formatLocalDate(s.when)}) has passed. Set the next step yourself, on a later day.` };
  const input = { label: s.what, action: s.how, dueDate: s.when, kind: s.kind, meetingAt: null };
  if (n.sandboxContactId && !n.personId) {
    // The same checks as a step set by hand: the guard (status, owner, pod) and contactability.
    const r = await setColdNextStep(n.sandboxContactId, { ...input, foUserId: user.id }, actor, { guard: user, act: 'next_step', user });
    if (!r.ok) return { ok: false, error: r.reason };
  } else if (n.personId) {
    const subject = await loadSubject(personRef(n.personId));
    if (!subject) return { ok: false, error: 'This person is no longer in the CRM.' };
    const verdict = canAct(user, subject, 'next_action');
    if (!verdict.ok) return { ok: false, error: verdict.reason };
    const check = await contactability(personRef(n.personId), { act: 'next_step', channel: s.kind === 'MEETING' ? null : channelOfAction(s.how), now, user });
    if (!check.ok && check.effect === 'block') return { ok: false, error: check.reason };
    const r = await setNextActions([n.personId], { ...input, repeat: 'NONE', foUserId: user.id }, actor, user.id);
    if (!r.set.length) return { ok: false, error: r.skipped[0]?.reason ?? 'The next step could not be set.' };
  } else {
    return { ok: false, error: 'This suggestion is about nobody Cadence still holds.' };
  }
  await prisma.notification.update({ where: { id }, data: { resolution: 'accepted', resolvedAt: now, readAt: n.readAt ?? now } });
  await logAudit({ entityType: n.personId ? 'person' : 'sandbox_contact', entityId: (n.personId ?? n.sandboxContactId)!, action: 'suggestion_accepted', actor, details: { notificationId: id, from: s.from } });
  return { ok: true, message: `Next step set: ${s.words}.` };
}

export async function dismissSuggestion(id: string, userId: string, now = new Date()): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const done = await prisma.notification.updateMany({ where: { id, userId, kind: 'next_step_suggestion', resolution: null }, data: { resolution: 'dismissed', resolvedAt: now, readAt: now } });
  return done.count ? { ok: true, message: 'Dismissed. Your next step stays as it was.' } : { ok: false, error: 'This suggestion was answered already.' };
}

