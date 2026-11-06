import { prisma } from '../db';
import { formatLocalDate, toLocalDate } from '../dates';
import { firstNameOf } from '../names';
import { getSettings } from '../settings';
import { workspaceTimezone } from '../workspace';
import { retryDelayMs } from '../engine/sync-out';
import { callOutcomes } from '../engine/outcomes';
import type { TwentyClient } from '../twenty';
import type { CreateNoteInput } from '../twenty/types';
import { enrollmentStatusLabel } from '../enrollment-labels';
import { optionLabels } from '../twenty/labels';
import { plainText } from './normalize';

/**
 * The Twenty notes a sandbox contact's history becomes when it moves (plan 8.3), and the one note
 * writer every call form and move uses. A failed write is kept in the outbox and retried by the
 * worker, like every other Cadence note.
 */

/** `key` names the draft for a move's idempotent writes: call:<id>, note:<id>, history. */
export type NoteDraft = { title: string; bodyMarkdown: string; at: Date; key?: string };

/** "3 Nov 2026": note titles and history lines always carry the year (B189). */
const day = (at: Date) => formatLocalDate(toLocalDate(at, workspaceTimezone()), 'year');
const minutes = (sec: number | null) => (sec == null ? null : sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`);

export const NEXT_STEP_LABELS: Record<string, string> = { call_again: 'Call again', email: 'Email', linkedin: 'LinkedIn', meeting: 'Meeting', keep: 'Kept the current next step', campaign: 'The campaign continues', none: 'No further action' };

/** One call with its form, as a note: `[Cadence] Call 14 Oct 2026 by Alyssa - Connected (4/5)`. */
export async function callNoteDraft(callId: string, prefix?: string): Promise<NoteDraft | null> {
  const call = await prisma.callLog.findUnique({ where: { id: callId }, include: { form: true, user: { select: { name: true } } } });
  if (!call || !call.form) return null;
  const settings = await getSettings();
  const p = prefix ?? settings.matching.cadencePrefix;
  const outcome = callOutcomes(settings.rules).find((d) => d.key === call.form!.outcome)?.label ?? call.form.outcome;
  const at = call.startedAt ?? call.createdAt;
  const by = firstNameOf(call.user?.name ?? 'Cadence');
  const campaign = call.campaignId ? await prisma.campaign.findUnique({ where: { id: call.campaignId }, select: { name: true } }) : null;
  const f = call.form;
  const lines = [
    `Outcome: ${outcome}${f.rating ? ` (${f.rating}/5)` : ''}`,
    `Next step: ${f.nextStepLabel ?? NEXT_STEP_LABELS[f.nextStep] ?? f.nextStep}${f.nextStepDate ? `, ${formatLocalDate(f.nextStepDate, 'long')}` : ''}`,
    ...(f.interest ? [`Interest: ${f.interest}`] : []),
    ...(f.decisionMaker ? [`Decision maker: ${f.decisionMaker}`] : []),
    ...(f.productsDiscussed.length ? [`Products discussed: ${optionLabels(f.productsDiscussed)}`] : []),
    `Duration: ${minutes(call.talkSec) ?? 'not connected'}`,
    `Direction: ${call.direction === 'OUTBOUND' ? 'outbound' : 'inbound'}`,
    ...(campaign ? [`Campaign: ${campaign.name}`] : []),
    ...(f.notes ? ['', f.notes] : []),
    '',
    `In Cadence: ${(process.env.APP_URL ?? '').replace(/\/+$/, '')}/calls/${call.id}`,
  ];
  return { title: `${p} Call ${day(at)} by ${by} - ${outcome}${f.rating ? ` (${f.rating}/5)` : ''}`, bodyMarkdown: lines.join('\n'), at };
}

/** Who moved the contact and when, and the date its email bounced, for the history note (B189, N018). */
export type HistoryContext = { movedByName?: string | null; movedAt?: Date | null; bouncedOn?: Date | null };

/**
 * Everything a cold contact did in Cadence, as notes for the CRM person it becomes. Each draft has a
 * key, so a move that is resumed writes only what has not landed. The history note says where the
 * contact came from, who moved it and when, and carries a bounced email (B189, N018); its lines are
 * separate paragraphs, so the CRM shows them on lines of their own.
 */
export async function historyDrafts(contactId: string, ctx: HistoryContext = {}): Promise<NoteDraft[]> {
  const settings = await getSettings();
  const p = settings.matching.cadencePrefix;
  const contact = await prisma.sandboxContact.findUniqueOrThrow({
    where: { id: contactId },
    include: {
      notes: { orderBy: { createdAt: 'asc' } },
      emails: { orderBy: { at: 'asc' } },
      calls: { where: { form: { isNot: null } }, orderBy: { startedAt: 'asc' }, select: { id: true } },
      enrollments: { include: { campaign: { select: { name: true } }, sequence: { select: { name: true } }, tasks: { where: { state: 'DONE' }, select: { label: true, completedAt: true } } } },
    },
  });
  const drafts: NoteDraft[] = [];
  for (const c of contact.calls) { const d = await callNoteDraft(c.id, p); if (d) drafts.push({ ...d, key: `call:${c.id}` }); }
  for (const n of contact.notes) drafts.push({ title: `${p} Note ${day(n.createdAt)} by ${firstNameOf(n.authorName ?? 'Cadence')}`, bodyMarkdown: n.body, at: n.createdAt, key: `note:${n.id}` });
  const pusher = contact.pushedByName ?? (contact.pushedByEmail ? firstNameOf(contact.pushedByEmail.split('@')[0]) : null);
  const source = contact.source === 'BELLWETHER' ? `pushed from Bellwether${pusher ? ` by ${pusher}` : ''}` : contact.source === 'MANUAL' ? 'added in Cadence' : `from ${contact.source.toLowerCase()}`;
  const summary = [
    `From Cold outreach (${source}, ${day(contact.createdAt)})${contact.sourceNote ? `. Source: ${contact.sourceNote}` : ''}`,
    ...(ctx.movedAt ? [`Moved to the CRM${ctx.movedByName ? ` by ${ctx.movedByName}` : ''} on ${day(ctx.movedAt)}`] : []),
    ...(contact.badEmail ? [`Email bounced${ctx.bouncedOn ? ` on ${day(ctx.bouncedOn)}` : ''}: ${contact.email ?? 'the address'} is flagged in Cadence`] : []),
    ...(contact.bellwetherUrl ? [`Bellwether: ${contact.bellwetherUrl}`] : []),
    ...contact.enrollments.map((e) => `${e.campaign ? `Campaign ${e.campaign.name}` : `Sequence ${e.sequence.name}`}: ${enrollmentStatusLabel(e.status === 'ACTIVE' || e.status === 'PAUSED' ? { status: 'EXITED', exitReason: 'moved_to_crm' } : e)}`),
    ...(contact.emails.length ? [['Emails:', ...contact.emails.map((m) => `- ${day(m.at)} ${m.kind === 'SENT' ? 'sent' : m.kind === 'REPLY' ? 'reply' : m.kind === 'BOUNCE' ? 'bounced' : 'auto-reply'}: ${m.subject ?? '(no subject)'}`)].join('\n')] : []),
    ...(contact.enrollments.some((e) => e.tasks.length) ? [['Steps done:', ...contact.enrollments.flatMap((e) => e.tasks.map((t) => `- ${t.completedAt ? day(t.completedAt) : ''} ${t.label}`))].join('\n')] : []),
  ];
  drafts.push({ title: `${p} Cold outreach history`, bodyMarkdown: summary.join('\n\n'), at: new Date(), key: 'history' });
  return drafts;
}

/**
 * Write a note to Twenty through the outbox: logged when it lands, kept as FAILED (and retried with
 * backoff) when it does not. `meta` travels in the outbox payload so undo can find a retried note.
 * Notes carry text from outside Cadence (Bellwether's notes, a rep's pasted words, call notes): HTML
 * and markdown links are made plain first, so neither reaches the CRM as markup (B114).
 */
export async function writeNote(client: TwentyClient, raw: CreateNoteInput, meta: { taskId?: string | null; moveItemId?: string | null; callId?: string | null; noteKey?: string | null } = {}): Promise<string | null> {
  const input: CreateNoteInput = { ...raw, title: plainText(raw.title).replace(/\s+/g, ' '), bodyMarkdown: plainText(raw.bodyMarkdown) };
  const payload = { ...input, ...(meta.moveItemId ? { cadenceMoveItemId: meta.moveItemId } : {}), ...(meta.callId ? { cadenceCallId: meta.callId } : {}), ...(meta.noteKey ? { cadenceNoteKey: meta.noteKey } : {}) };
  try {
    const { id } = await client.createNote(input);
    if (client.kind !== 'dry-run') await prisma.twentyWrite.create({ data: { operation: 'createNote', objectType: 'note', payload, twentyId: id, taskId: meta.taskId ?? null, dryRun: false } });
    return id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.twentyWrite.create({ data: { operation: 'createNote', objectType: 'note', payload, taskId: meta.taskId ?? null, dryRun: false, status: 'FAILED', error: message.slice(0, 1000), attempts: 1, nextAttemptAt: new Date(Date.now() + retryDelayMs(1)) } });
    return null;
  }
}
