import type { AuditLog, Task, Touch } from '@prisma/client';
import { presentNoteBody } from './crm-text';
import { describeAudit } from './audit-format';
import type { TwentyNote } from './twenty/types';
import { byNewest, cleanNote, cleanTitle, dedupeFeed, kindOf, type FeedItem } from './feed';

/** The campaign events a person's feed shows; the rest of the audit trail is administration. */
/** The kind's word for a campaign step: "Call step", "LinkedIn step". */
export const KIND_WORD = { call: 'Call', email: 'Email', linkedin: 'LinkedIn', meeting: 'Meeting', note: 'Note', campaign: 'Campaign' } as const;

export const FEED_AUDIT = ['enrolled', 'replied', 'meeting', 'exited', 'completed', 'paused', 'resumed', 'finished', 'moved_to_step', 'flags_updated', 'reassigned'];

/** "Email sent: Intro" -> "Intro" (the kind says it was an email sent); "Reply: Re: Intro" -> "Re: Intro". */
export function touchTitle(summary: string, prefix?: string): string {
  return cleanTitle(summary.replace(/^(Email sent|Reply): /, ''), prefix);
}

type FeedTask = Pick<Task, 'id' | 'label' | 'action' | 'chosenAction' | 'state' | 'disposition' | 'skipReason' | 'note' | 'completedAt' | 'updatedAt' | 'evidenceId' | 'twentyNoteId' | 'stepIndex' | 'enrollmentId'> & { fo: { name: string } };

/**
 * A CRM person's feed: what was done with them (touches, steps), what the CRM holds (notes) and
 * what happened to their campaigns. Cadence's own completion note in the CRM is the step it
 * mirrors, so it is shown once, as the step; a CRM note that was also read as a touch, once.
 */
export function personFeed(input: {
  touches: Touch[]; notes: TwentyNote[]; tasks: FeedTask[]; audit: AuditLog[];
  sequenceOf: (enrollmentId: string) => string | null; outcomeLabel: (key: string) => string; prefix?: string;
}): FeedItem[] {
  const { touches, notes, tasks, audit, prefix } = input;
  const mirrors = new Set(tasks.flatMap((t) => (t.twentyNoteId ? [t.twentyNoteId] : [])));
  const noteOf = (externalId: string) => (externalId.startsWith('note:') ? externalId.split(':')[1] : null);
  // The step a touch completed: the outcome, the rep's words and the campaign go with the touch.
  const stepOf = new Map<string, FeedTask>();
  for (const t of tasks) { stepOf.set(`task:${t.id}`, t); if (t.evidenceId) stepOf.set(t.evidenceId, t); }
  const stepFields = (t: FeedTask) => {
    const seq = input.sequenceOf(t.enrollmentId);
    return [
      ...(t.disposition ? [{ label: 'Outcome', value: input.outcomeLabel(t.disposition) }] : []),
      ...(t.skipReason ? [{ label: 'Why', value: t.skipReason }] : []),
      ...(seq ? [{ label: 'Campaign', value: `${seq} · step ${t.stepIndex + 1}` }] : []),
    ];
  };
  const items: FeedItem[] = [];
  for (const t of touches) {
    const noteId = noteOf(t.externalId);
    if (noteId && mirrors.has(noteId)) continue;
    const note = noteId ? notes.find((n) => n.id === noteId) : undefined;
    const clean = note ? cleanNote(presentNoteBody(note.bodyMarkdown)) : { body: null, fields: [] };
    const step = stepOf.get(t.externalId);
    // Marked done by hand: the step itself, by the rep who did it, not "Cadence".
    const byHand = step && t.externalId === `task:${step.id}`;
    items.push({
      key: `t${t.id}`, at: t.occurredAt.toISOString(), kind: kindOf(t.channel), direction: byHand ? null : t.direction === 'INBOUND' ? 'in' : 'out',
      label: byHand ? `${KIND_WORD[kindOf(t.channel)]} step` : null,
      title: byHand ? `${step.label} done` : note ? cleanTitle(note.title, prefix) : touchTitle(t.summary, prefix),
      who: byHand ? step.fo.name : t.actorLabel ?? note?.createdByName ?? null,
      source: noteId ? 'CRM note' : null, body: clean.body ?? step?.note ?? null, fields: [...clean.fields, ...(step ? stepFields(step) : [])],
    });
  }
  for (const n of notes) {
    if (mirrors.has(n.id) || touches.some((t) => noteOf(t.externalId) === n.id)) continue;
    const clean = cleanNote(presentNoteBody(n.bodyMarkdown));
    items.push({ key: `n${n.id}`, at: new Date(n.createdAt).toISOString(), kind: 'note', direction: null, title: cleanTitle(n.title, prefix), who: n.createdByName, body: clean.body, fields: clean.fields });
  }
  for (const t of tasks) {
    if (t.state !== 'DONE' && t.state !== 'SKIPPED') continue;
    // A step a touch already shows (the email that was read, the call that was imported) is that touch.
    if (t.state === 'DONE' && touches.some((x) => x.externalId === `task:${t.id}` || x.externalId === t.evidenceId)) continue;
    const kind = kindOf(t.chosenAction ?? t.action);
    items.push({
      key: `k${t.id}`, at: (t.completedAt ?? t.updatedAt).toISOString(), kind, direction: null, label: `${KIND_WORD[kind]} step`,
      title: `${t.label} ${t.state === 'DONE' ? 'done' : 'skipped'}`, who: t.fo.name, body: t.note, fields: stepFields(t),
    });
  }
  for (const a of audit) {
    if (!FEED_AUDIT.includes(a.action)) continue;
    const { title, fields } = describeAudit(a.action, a.details as Record<string, unknown> | null, null, a.entityType);
    items.push({ key: `a${a.id}`, at: a.createdAt.toISOString(), kind: 'campaign', direction: null, title, who: a.actorLabel, fields });
  }
  return dedupeFeed(items.sort(byNewest));
}
