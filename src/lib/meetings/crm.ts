import { prisma } from '../db';
import { env } from '../env';
import { getSettings, isExternalEmail } from '../settings';
import { getTwentyClient, type TwentyClient } from '../twenty';
import type { TwentyMeetingSchema, TwentyTagField } from '../twenty/types';
import { optionLabel } from '../twenty/labels';
import { workspaceTimezone } from '../workspace';
import { meetingDay, meetingDayInstant } from './day';
import { retryDelayMs } from '../engine/sync-out';
import { parseTranscript, type TranscriptFormat } from './transcript';
import { ordinal } from './numbering';

/**
 * Twenty keeps the record. Every meeting added in Cadence is written to the workspace's own
 * Meetings object: its title and date, who booked it, the products and the team on the call as
 * tags, the account, the recording, the transcript, a link back, which meeting with its prospects
 * it is, and one Meeting contact per prospect, so the meeting shows on each of their records.
 *
 * Each Meeting contact row carries that prospect's own count (their 1st, 2nd... meeting with us)
 * with the day, who booked it, the products and the team, so a dashboard reads the bonus numbers
 * straight from Twenty: first meetings and the 5th, 10th, 15th from the Meetings object (one per
 * meeting, credited to the FO who booked it), and each prospect's count from Meeting contacts.
 * An edit updates the same records; a delete removes them. A workspace without a Meetings object
 * gets a note on the contacts and account instead.
 */

type MeetingForCrm = {
  id: string;
  title: string;
  sourceUrl: string;
  occurredAt: Date;
  products: string[];
  companyId: string | null;
  companyName: string | null;
  bookedBy: { name: string; twentyMemberId?: string | null } | null;
  /** The highest of its prospects' numbers: 1 only when everyone on it is new. */
  meetingNumber?: number | null;
  transcript?: string | null;
  transcriptFormat?: string | null;
  attendees: { name: string | null; email: string | null; personId: string | null; userId?: string | null; external: boolean; prospect?: boolean; meetingNumber?: number | null; person?: { firstName: string; lastName: string } | null }[];
};

/** Twenty's text fields hold the transcript as lines of "Speaker: what they said", up to a limit. */
const TRANSCRIPT_LIMIT = 100_000;
export function transcriptText(raw: string | null | undefined, format?: string | null): string {
  if (!raw?.trim()) return '';
  const { cues } = parseTranscript(raw, (format as TranscriptFormat | null) ?? undefined);
  const text = cues.length ? cues.map((c) => (c.speaker ? `${c.speaker}: ${c.text}` : c.text)).join('\n') : raw.trim();
  return text.length > TRANSCRIPT_LIMIT ? `${text.slice(0, TRANSCRIPT_LIMIT)}\n[Cut short here: the full transcript is in Cadence]` : text;
}

/** The note for a workspace with no Meetings object: plain lines, readable anywhere it is shown. */
export function meetingNote(m: MeetingForCrm, prefix: string): { title: string; bodyMarkdown: string } {
  const when = new Intl.DateTimeFormat('en-US', { timeZone: workspaceTimezone(), weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(m.occurredAt);
  const people = m.attendees.map((a) => [a.name, a.email ? `(${a.email})` : null].filter(Boolean).join(' ')).filter(Boolean);
  const lines = [
    `When: ${when}`,
    m.bookedBy ? `Booked by: ${m.bookedBy.name}` : null,
    m.meetingNumber ? `Meeting: ${m.meetingNumber === 1 ? 'first meeting' : `${ordinal(m.meetingNumber)} meeting`}` : null,
    m.products.length ? `Products: ${m.products.map(optionLabel).join(', ')}` : null,
    m.companyName ? `Account: ${m.companyName}` : null,
    people.length ? `Attendees: ${people.join(', ')}` : null,
    m.sourceUrl ? `Recording: ${m.sourceUrl}` : null,
    `In Cadence: ${cadenceUrl(m.id)}`,
  ].filter(Boolean);
  return { title: `${prefix} Meeting: ${m.title}`.trim(), bodyMarkdown: lines.join('\n\n') };
}

const cadenceUrl = (id: string) => `${env().APP_URL.replace(/\/$/, '')}/meetings/${id}`;
const link = (url: string, label = '') => ({ primaryLinkUrl: url, primaryLinkLabel: label, secondaryLinks: [] });

/** Whether a tag could be set: the ones that could not are listed in Settings > Twenty. */
export type TagOutcome = { field: string; name: string; ok: boolean };

/** A tag's value for a name: the tag with that label, else a new one when Twenty allows it. */
async function tagValue(client: TwentyClient, field: TwentyTagField, label: string, outcomes: TagOutcome[], fieldLabel: string): Promise<string | null> {
  const key = label.trim().toLowerCase();
  if (!key) return null;
  const hit = field.options.find((o) => o.label.trim().toLowerCase() === key || o.value.toLowerCase() === key);
  const added = hit ? null : await client.addSelectOption(field, label.trim());
  if (added) field.options.push({ value: added, label: label.trim() });
  outcomes.push({ field: fieldLabel, name: label.trim(), ok: Boolean(hit ?? added) });
  return hit?.value ?? added;
}

const MISSING_TAGS = 'meetingTagsMissing';

/**
 * Keep the list of tags Twenty lacks and Cadence could not add (its key may not change the data
 * model): a name set this time comes off the list, a name that failed goes on it.
 */
async function rememberTags(outcomes: TagOutcome[]): Promise<void> {
  if (!outcomes.length) return;
  const key = (t: { field: string; name: string }) => `${t.field}|${t.name.toLowerCase()}`;
  const row = await prisma.setting.findUnique({ where: { key: MISSING_TAGS } });
  const before = ((row?.value as { items?: { field: string; name: string }[] } | null)?.items ?? []);
  const settled = new Set(outcomes.map(key));
  const items = [...before.filter((t) => !settled.has(key(t))), ...outcomes.filter((t) => !t.ok).map(({ field, name }) => ({ field, name }))]
    .filter((t, i, all) => all.findIndex((u) => key(u) === key(t)) === i);
  if (items.length === before.length && items.every((t, i) => key(t) === key(before[i]))) return;
  await prisma.setting.upsert({ where: { key: MISSING_TAGS }, create: { key: MISSING_TAGS, value: { items } }, update: { value: { items } } });
}

/** The tags Settings > Twenty lists as missing. */
export async function missingMeetingTags(): Promise<{ field: string; name: string }[]> {
  const row = await prisma.setting.findUnique({ where: { key: MISSING_TAGS } });
  return (row?.value as { items?: { field: string; name: string }[] } | null)?.items ?? [];
}

/** The record's field values and the contacts to link, in the names this workspace gave its fields. */
export async function meetingRecord(m: MeetingForCrm, schema: TwentyMeetingSchema, client: TwentyClient): Promise<{ data: Record<string, unknown>; contacts: { personId: string; name: string; data: Record<string, unknown> }[]; tags: TagOutcome[] }> {
  const f = schema.fields;
  const tags: TagOutcome[] = [];
  const data: Record<string, unknown> = { name: m.title };
  // The value a tag field takes for these names: its tags, or the names written out in a text field.
  const named = async (field: TwentyTagField | null, names: string[], fieldLabel: string): Promise<unknown> => {
    if (!field) return undefined;
    if (field.text) return names.join(', ');
    const values: string[] = [];
    for (const n of names) { const v = await tagValue(client, field, n, tags, fieldLabel); if (v && !values.includes(v)) values.push(v); }
    return field.multi ? values : values[0] ?? null;
  };
  // The day only, whether Twenty's field is a date or a date and time.
  const day = (field: { dateOnly: boolean }) => (field.dateOnly ? meetingDay(m.occurredAt) : meetingDayInstant(meetingDay(m.occurredAt)).toISOString());
  if (f.date) data[f.date.name] = day(f.date);
  const booked = m.bookedBy ? [m.bookedBy.name] : [];
  const products = m.products.map(optionLabel);
  if (f.bookedBy) data[f.bookedBy.name] = await named(f.bookedBy, booked, 'Booked by');
  if (f.products) data[f.products.name] = await named(f.products, products, 'Products');
  // Who is on the team: a Cadence login, matched by id, address or name, or an address at one of
  // our domains. Team members are tags, never contacts, even when Twenty also has a People record
  // for them (Alisa is both).
  const [{ rules }, users] = await Promise.all([getSettings(), prisma.user.findMany({ select: { id: true, name: true, email: true, aliases: true } })]);
  const personName = (a: MeetingForCrm['attendees'][number]) => (a.person ? `${a.person.firstName} ${a.person.lastName}`.trim() : '') || a.name || a.email || '';
  const userOf = (a: MeetingForCrm['attendees'][number]) => {
    const email = a.email?.trim().toLowerCase();
    const name = personName(a).trim().toLowerCase();
    return users.find((u) => u.id === a.userId)
      ?? (email ? users.find((u) => [u.email, ...u.aliases].some((x) => x.trim().toLowerCase() === email)) : undefined)
      ?? (name ? users.find((u) => u.name.trim().toLowerCase() === name) : undefined);
  };
  const team: string[] = [];
  const external: MeetingForCrm['attendees'] = [];
  for (const a of m.attendees) {
    const user = userOf(a);
    if (user || (a.email && !isExternalEmail(a.email, rules.internalDomains))) { const n = user?.name ?? personName(a); if (n && !team.includes(n)) team.push(n); }
    else external.push(a);
  }
  if (f.team) data[f.team.name] = await named(f.team, team, 'Team on the call');
  if (f.meetingNumber) data[f.meetingNumber] = m.meetingNumber ?? null;
  if (f.firstMeeting) data[f.firstMeeting] = m.meetingNumber === 1;
  if (f.transcript) data[f.transcript] = transcriptText(m.transcript, m.transcriptFormat);
  if (f.recording) data[f.recording] = link(m.sourceUrl ?? '');
  if (f.cadenceLink) data[f.cadenceLink] = link(cadenceUrl(m.id), 'Open in Cadence');
  if (f.cadenceId) data[f.cadenceId] = m.id;
  if (f.guests) data[f.guests] = external.filter((a) => !a.personId).map((a) => a.name || a.email).filter(Boolean).join(', ');
  if (f.companyId) data[f.companyId] = m.companyId;
  // What every contact row says alike, in that object's own fields (and its own tags).
  // Only when there are rows to write: a meeting with no prospects asks Twenty for no tags here.
  const cf = external.some((a) => a.personId && a.prospect !== false) ? schema.contact?.fields : undefined;
  const shared: Record<string, unknown> = {};
  if (cf?.date) shared[cf.date.name] = day(cf.date);
  if (cf?.bookedBy) shared[cf.bookedBy.name] = await named(cf.bookedBy, booked, 'Meeting contacts: Booked by');
  if (cf?.products) shared[cf.products.name] = await named(cf.products, products, 'Meeting contacts: Products');
  if (cf?.team) shared[cf.team.name] = await named(cf.team, team, 'Meeting contacts: Team on the call');
  const contacts: { personId: string; name: string; data: Record<string, unknown> }[] = [];
  for (const a of external) {
    // A prospect, each once. Older meetings mark none, so any contact from Twenty counts there.
    if (!a.personId || a.prospect === false || contacts.some((c) => c.personId === a.personId)) continue;
    const own: Record<string, unknown> = { ...shared };
    if (cf?.meetingNumber) own[cf.meetingNumber] = a.meetingNumber ?? null;
    if (cf?.firstMeeting) own[cf.firstMeeting] = a.meetingNumber === 1;
    // Named for both sides: on the person it says which meeting, on the meeting which person.
    contacts.push({ personId: a.personId, name: `${m.title} · ${personName(a) || 'Contact'}`, data: own });
  }
  // The single "People" link on the meeting holds its first contact; all of them are Meeting contacts.
  if (f.personId) data[f.personId] = contacts[0]?.personId ?? null;
  if (f.assigneeId) data[f.assigneeId] = m.bookedBy?.twentyMemberId ?? null;
  return { data, contacts, tags };
}

const meetingSelect = {
  id: true, title: true, sourceUrl: true, occurredAt: true, products: true, companyId: true, companyName: true, twentyNoteId: true, twentyMeetingId: true, review: true,
  meetingNumber: true, transcript: true, transcriptFormat: true,
  bookedBy: { select: { name: true, twentyMemberId: true } },
  attendees: { select: { name: true, email: true, personId: true, userId: true, external: true, prospect: true, meetingNumber: true, person: { select: { firstName: true, lastName: true } } } },
} as const;

/**
 * Write the meeting to Twenty, or update what was written. Throws when Twenty refuses, so the
 * caller can keep it for a retry. Returns the record's id (or the note's, without a Meetings object).
 */
export async function syncMeetingToCrm(meetingId: string): Promise<string | null> {
  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId }, select: meetingSelect });
  if (!meeting || meeting.review !== 'APPROVED') return null;
  const client = await getTwentyClient();
  const schema = await client.meetingSchema();
  if (schema) {
    const { tags, ...record } = await meetingRecord(meeting, schema, client);
    await rememberTags(tags);
    const { id } = await client.saveMeetingRecord(schema, { id: meeting.twentyMeetingId, cadenceId: meeting.id, ...record });
    if (id !== meeting.twentyMeetingId) await prisma.meeting.update({ where: { id: meetingId }, data: { twentyMeetingId: id } });
    return id;
  }
  // No Meetings object: a note on its contacts and account, rewritten so a new contact is linked too.
  const personIds = [...new Set(meeting.attendees.flatMap((a) => (a.personId ? [a.personId] : [])))];
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

function keepForRetry(operation: string, payload: Record<string, unknown>, err: unknown, twentyId: string | null = null) {
  const message = err instanceof Error ? err.message : String(err);
  return prisma.twentyWrite.create({ data: { operation, objectType: 'meeting', twentyId, payload: payload as object, status: 'FAILED', error: message, attempts: 1, nextAttemptAt: new Date(Date.now() + retryDelayMs(1)) } }).catch(() => undefined);
}

/** Write it now, or keep it in the outbox the worker retries with backoff. */
export async function pushMeetingToCrm(meetingId: string): Promise<void> {
  try {
    await syncMeetingToCrm(meetingId);
  } catch (err) {
    console.warn(`[meetings] could not write meeting ${meetingId} to Twenty: ${err instanceof Error ? err.message : String(err)}`);
    await keepForRetry('syncMeeting', { meetingId }, err);
  }
}

/** A deleted meeting's record in Twenty goes too (or its note, from before the Meetings object). */
export async function removeMeetingFromCrm(meeting: { twentyMeetingId: string | null; twentyNoteId: string | null }): Promise<void> {
  try {
    const client = await getTwentyClient();
    if (meeting.twentyMeetingId) {
      const schema = await client.meetingSchema();
      if (schema) await client.deleteMeetingRecord(schema, meeting.twentyMeetingId);
    }
    if (meeting.twentyNoteId) await client.deleteNote(meeting.twentyNoteId);
  } catch (err) {
    if (meeting.twentyMeetingId) await keepForRetry('deleteMeetingRecord', { id: meeting.twentyMeetingId }, err, meeting.twentyMeetingId);
    else if (meeting.twentyNoteId) await keepForRetry('deleteNote', { id: meeting.twentyNoteId }, err, meeting.twentyNoteId);
  }
}

/**
 * Which fields Cadence found in Twenty's Meetings and Meeting contacts objects. When it changes (an
 * admin added "Meeting Number", say), every meeting is written again so the new field fills in.
 */
export function meetingSchemaShape(schema: TwentyMeetingSchema): string {
  const names = (fields: object) => Object.entries(fields).filter(([, v]) => v).map(([k]) => k).sort().join(',');
  return `${names(schema.fields)}|${schema.contact ? names(schema.contact.fields) : 'no contacts'}`;
}

/**
 * Once the workspace has a Meetings object, every meeting already in Cadence goes into it. Returns
 * null when there is no Meetings object yet (try again later), else how many were written.
 */
export async function backfillMeetingsToCrm(options: { all?: boolean } = {}): Promise<number | null> {
  const client = await getTwentyClient();
  if (!(await client.meetingSchema())) return null;
  const pending = await prisma.meeting.findMany({ where: { review: 'APPROVED', ...(options.all ? {} : { twentyMeetingId: null }) }, orderBy: { occurredAt: 'asc' }, select: { id: true } });
  for (const m of pending) await pushMeetingToCrm(m.id);
  return pending.length;
}
