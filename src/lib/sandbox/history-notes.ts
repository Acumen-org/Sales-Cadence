import { prisma } from '../db';
import { formatLocalDate, toLocalDate } from '../dates';
import { firstNameOf } from '../names';
import { getSettings } from '../settings';
import { workspaceTimezone } from '../workspace';
import { retryDelayMs } from '../engine/sync-out';
import { callOutcomes } from '../engine/outcomes';
import type { TwentyClient } from '../twenty';
import type { CreateNoteInput } from '../twenty/types';

/**
 * The Twenty notes a sandbox contact's history becomes when it moves (plan 8.3), and the one note
 * writer every call form and move uses. A failed write is kept in the outbox and retried by the
 * worker, like every other Cadence note.
 */

export type NoteDraft = { title: string; bodyMarkdown: string; at: Date };

const day = (at: Date) => formatLocalDate(toLocalDate(at, workspaceTimezone()), 'short');
const minutes = (sec: number | null) => (sec == null ? null : sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`);

export const NEXT_STEP_LABELS: Record<string, string> = { call_again: 'Call again', email: 'Email', linkedin: 'LinkedIn', meeting: 'Meeting', none: 'No further action' };

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
    `Next step: ${NEXT_STEP_LABELS[f.nextStep] ?? f.nextStep}${f.nextStepDate ? `, ${formatLocalDate(f.nextStepDate, 'long')}` : ''}`,
    ...(f.interest ? [`Interest: ${f.interest}`] : []),
    ...(f.decisionMaker ? [`Decision maker: ${f.decisionMaker}`] : []),
    ...(f.productsDiscussed.length ? [`Products discussed: ${f.productsDiscussed.join(', ')}`] : []),
    `Duration: ${minutes(call.talkSec) ?? 'not connected'}`,
    `Direction: ${call.direction === 'OUTBOUND' ? 'outbound' : 'inbound'}`,
    ...(campaign ? [`Campaign: ${campaign.name}`] : []),
    ...(f.notes ? ['', f.notes] : []),
    '',
    `In Cadence: ${(process.env.APP_URL ?? '').replace(/\/+$/, '')}/calls/${call.id}`,
  ];
  return { title: `${p} Call ${day(at)} by ${by} - ${outcome}${f.rating ? ` (${f.rating}/5)` : ''}`, bodyMarkdown: lines.join('\n'), at };
}

/** Everything a sandbox contact did in Cadence, as notes for the person it becomes. */
export async function historyDrafts(contactId: string): Promise<NoteDraft[]> {
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
  for (const c of contact.calls) { const d = await callNoteDraft(c.id, p); if (d) drafts.push(d); }
  for (const n of contact.notes) drafts.push({ title: `${p} Note ${day(n.createdAt)} by ${firstNameOf(n.authorName ?? 'Cadence')}`, bodyMarkdown: n.body, at: n.createdAt });
  const summary = [
    `Source: ${contact.source === 'BELLWETHER' ? 'Bellwether' : contact.source === 'MANUAL' ? 'added in Cadence' : contact.source.toLowerCase()}${contact.sourceNote ? ` (${contact.sourceNote})` : ''}`,
    `In the sandbox since ${day(contact.createdAt)}${contact.pushedByEmail ? `, pushed by ${contact.pushedByEmail}` : ''}`,
    ...(contact.bellwetherUrl ? [`Bellwether: ${contact.bellwetherUrl}`] : []),
    ...contact.enrollments.map((e) => `${e.campaign ? `Campaign ${e.campaign.name}` : `Sequence ${e.sequence.name}`}: ${e.status === 'EXITED' ? `ended (${(e.exitReason ?? 'ended').replace(/_/g, ' ')})` : e.status.toLowerCase()}`),
    ...(contact.emails.length ? ['', 'Emails:', ...contact.emails.map((m) => `- ${day(m.at)} ${m.kind === 'SENT' ? 'sent' : m.kind === 'REPLY' ? 'reply' : m.kind === 'BOUNCE' ? 'bounced' : 'auto-reply'}: ${m.subject ?? '(no subject)'}`)] : []),
    ...(contact.enrollments.some((e) => e.tasks.length) ? ['', 'Steps done:', ...contact.enrollments.flatMap((e) => e.tasks.map((t) => `- ${t.completedAt ? day(t.completedAt) : ''} ${t.label}`))] : []),
  ];
  drafts.push({ title: `${p} Sandbox history`, bodyMarkdown: summary.join('\n'), at: new Date() });
  return drafts;
}

/**
 * Write a note to Twenty through the outbox: logged when it lands, kept as FAILED (and retried with
 * backoff) when it does not. `meta` travels in the outbox payload so undo can find a retried note.
 */
export async function writeNote(client: TwentyClient, input: CreateNoteInput, meta: { taskId?: string | null; moveItemId?: string | null; callId?: string | null } = {}): Promise<string | null> {
  const payload = { ...input, ...(meta.moveItemId ? { cadenceMoveItemId: meta.moveItemId } : {}), ...(meta.callId ? { cadenceCallId: meta.callId } : {}) };
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
