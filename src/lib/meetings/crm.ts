import { prisma } from '../db';
import { env } from '../env';
import { getSettings } from '../settings';
import { getTwentyClient } from '../twenty';
import { optionLabel } from '../twenty/labels';
import { workspaceTimezone } from '../workspace';
import { retryDelayMs } from '../engine/sync-out';

/**
 * Twenty keeps the record. Every meeting added in Cadence is written there as a note on its
 * contacts and its account - when, how long, who booked it, the products, who was on it and the
 * recording - and kept in step: an edit replaces the note (so a contact added later is linked
 * too), a delete removes it. The title starts with Cadence's own prefix, so reading Twenty back
 * never mistakes it for an email or a call.
 */

type MeetingForNote = {
  id: string;
  title: string;
  sourceUrl: string;
  occurredAt: Date;
  durationSec: number | null;
  products: string[];
  companyId: string | null;
  companyName: string | null;
  bookedBy: { name: string } | null;
  attendees: { name: string | null; email: string | null; personId: string | null; external: boolean }[];
};

export function meetingNote(m: MeetingForNote, prefix: string): { title: string; bodyMarkdown: string } {
  const when = new Intl.DateTimeFormat('en-US', { timeZone: workspaceTimezone(), weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(m.occurredAt);
  const minutes = m.durationSec ? Math.max(1, Math.round(m.durationSec / 60)) : null;
  const people = m.attendees.map((a) => [a.name, a.email ? `(${a.email})` : null].filter(Boolean).join(' ')).filter(Boolean);
  const lines = [
    `When: ${when}${minutes ? ` (${minutes} min)` : ''}`,
    m.bookedBy ? `Booked by: ${m.bookedBy.name}` : null,
    m.products.length ? `Products: ${m.products.map(optionLabel).join(', ')}` : null,
    m.companyName ? `Account: ${m.companyName}` : null,
    people.length ? `Attendees: ${people.join(', ')}` : null,
    m.sourceUrl ? `Recording: ${m.sourceUrl}` : null,
    `In Cadence: ${env().APP_URL.replace(/\/$/, '')}/meetings/${m.id}`,
  ].filter(Boolean);
  return { title: `${prefix} Meeting: ${m.title}`.trim(), bodyMarkdown: lines.join('\n\n') };
}

const meetingSelect = {
  id: true, title: true, sourceUrl: true, occurredAt: true, durationSec: true, products: true, companyId: true, companyName: true, twentyNoteId: true, review: true,
  bookedBy: { select: { name: true } },
  attendees: { select: { name: true, email: true, personId: true, external: true } },
} as const;

/**
 * Write the meeting to Twenty, or rewrite it after an edit. Throws when Twenty refuses, so the
 * caller can keep it for a retry. A meeting with no contact and no account has nothing to sit on
 * in Twenty, and is left until it has one.
 */
export async function syncMeetingToCrm(meetingId: string): Promise<string | null> {
  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId }, select: meetingSelect });
  if (!meeting || meeting.review !== 'APPROVED') return null;
  const personIds = [...new Set(meeting.attendees.flatMap((a) => (a.personId ? [a.personId] : [])))];
  const client = await getTwentyClient();
  if (meeting.twentyNoteId) {
    await client.deleteNote(meeting.twentyNoteId).catch(() => undefined);
    await prisma.meeting.update({ where: { id: meetingId }, data: { twentyNoteId: null } });
  }
  if (!personIds.length && !meeting.companyId) return null;
  const { matching } = await getSettings();
  const note = meetingNote(meeting, matching.cadencePrefix);
  const { id } = await client.createNote({ ...note, personIds, companyId: meeting.companyId });
  await prisma.meeting.update({ where: { id: meetingId }, data: { twentyNoteId: id } });
  return id;
}

/** Write it now, or keep it in the outbox the worker retries with backoff. */
export async function pushMeetingToCrm(meetingId: string): Promise<void> {
  try {
    await syncMeetingToCrm(meetingId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[meetings] could not write meeting ${meetingId} to Twenty: ${message}`);
    await prisma.twentyWrite.create({ data: { operation: 'syncMeeting', objectType: 'note', payload: { meetingId }, status: 'FAILED', error: message, attempts: 1, nextAttemptAt: new Date(Date.now() + retryDelayMs(1)) } }).catch(() => undefined);
  }
}

/** A deleted meeting's note goes too. */
export async function removeMeetingFromCrm(noteId: string | null): Promise<void> {
  if (!noteId) return;
  try {
    await (await getTwentyClient()).deleteNote(noteId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.twentyWrite.create({ data: { operation: 'deleteNote', objectType: 'note', twentyId: noteId, payload: { id: noteId }, status: 'FAILED', error: message, attempts: 1, nextAttemptAt: new Date(Date.now() + retryDelayMs(1)) } }).catch(() => undefined);
  }
}
