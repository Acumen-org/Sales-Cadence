import type { ActionType, NextActionKind, NextActionRepeat } from '@prisma/client';
import { logAudit, type AuditActor } from '../audit';
import { coldRef } from '../subject';
import { isUniqueViolation } from '../engine/tasks';
import { refuse, RefusedError, withSubjectLock, type GuardActor, type Refusal } from '../outreach/guard';
import { channelOfAction, contactability } from '../outreach/contactability';

/**
 * A cold contact's own next step. It stays in Cadence until the contact moves to the CRM; the one
 * Tasks list shows it beside the campaign steps (PLAN 4.3), for active contacts only (B009).
 */

/** A meeting is its own kind of next step, with its time when known (B183). */
export type ColdNextStepInput = { label: string; action: ActionType; dueDate: string; repeat?: NextActionRepeat; foUserId: string; kind?: NextActionKind; meetingAt?: Date | null };
export type ColdNextStepOptions = {
  /** The signed-in user the guard judges; null is Cadence itself. */
  guard?: GuardActor | null;
  /** By hand, or the post-call form's next step (whose own pending form never blocks it). */
  act?: 'next_step' | 'form_next_step';
  /** The rep, for the pending-form block. */
  user?: { id: string; timezone: string } | null;
};

/**
 * Set a cold contact's one open next step, under its lock, only if the contact may be reached that
 * way (PLAN 8.2): active and not being moved (B009), not suppressed or Do not contact, not "Also in
 * CRM" (B053), with an email for an Email step and a LinkedIn profile for a LinkedIn one (N077).
 */
export async function setColdNextStep(contactId: string, input: ColdNextStepInput, actor: AuditActor & { id?: string | null }, opts: ColdNextStepOptions = {}): Promise<{ ok: true; id: string } | Refusal> {
  const act = opts.act ?? 'next_step';
  const data = { label: input.label, action: input.action, dueDate: input.dueDate, repeat: input.repeat ?? 'NONE', foUserId: input.foUserId, kind: input.kind ?? 'ACTION', meetingAt: input.meetingAt ?? null, crmPending: false, crmError: null };
  const attempt = () => withSubjectLock(coldRef(contactId), opts.guard ?? null, act === 'form_next_step' ? 'form_next_step' : 'next_action', async (tx) => {
    const row = (await tx.sandboxContact.findUnique({ where: { id: contactId } }))!;
    const check = await contactability({ kind: 'cold', row }, { act, channel: channelOfAction(input.action), user: opts.user ?? null, tx });
    if (!check.ok && check.effect === 'block') throw new RefusedError(refuse(check.code, check.reason, check.fix));
    const open = await tx.nextAction.findFirst({ where: { sandboxContactId: contactId, personId: null, state: 'OPEN' }, select: { id: true } });
    // One open next step per contact is a database rule (NextAction_one_open_per_sandbox_contact, B005).
    const saved = open ? await tx.nextAction.update({ where: { id: open.id }, data }) : await tx.nextAction.create({ data: { ...data, sandboxContactId: contactId, createdById: actor.id ?? null, audience: 'SANDBOX' } });
    // Setting a next step is activity (N032).
    await tx.sandboxContact.update({ where: { id: contactId }, data: { lastActivityAt: new Date() } });
    await logAudit({ entityType: 'sandbox_contact', entityId: contactId, action: 'next_action_set', actor, details: { label: saved.label, dueDate: saved.dueDate } }, tx);
    return saved.id;
  }, { audit: actor });
  const r = await attempt().catch((err) => { if (isUniqueViolation(err)) return attempt(); throw err; });
  return r.ok ? { ok: true, id: r.value } : r;
}

/** The same, for callers that only expect it to succeed: a refusal is thrown with its reason. */
export async function setSandboxNextAction(contactId: string, input: ColdNextStepInput, actor: AuditActor & { id?: string | null }, opts: ColdNextStepOptions = {}): Promise<string> {
  const r = await setColdNextStep(contactId, input, actor, opts);
  if (!r.ok) throw new Error(r.reason);
  return r.id;
}
