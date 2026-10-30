import { prisma } from '../db';
import { meetingDay, meetingDayInstant, parseMeetingDay } from './day';

/**
 * How many times we have met each prospect (owner, 29 October 2026). A prospect's earliest meeting
 * in Cadence is their 1st, the next their 2nd, by date and then by when it was added; a meeting
 * removed or moved renumbers the rest. A meeting as a whole is the highest of its prospects'
 * numbers, so it counts as a first meeting only when everyone on it is new: Grant at 2 with
 * Alex at 1 is a 2nd meeting. The FO who booked it is credited once per meeting, however many
 * prospects were on it; the bonus counts first meetings and the 5th, 10th, 15th...
 *
 * The numbers are stored, not worked out on read, because Twenty keeps them too: every meeting
 * whose numbers move is written there again.
 */

/** One lock for all renumbering, so two saves never interleave their counts. */
const LOCK = 7_290_291;

type Row = { id: string; personId: string; meetingId: string; meetingNumber: number | null; occurredAt: Date; createdAt: Date; approved: boolean };

const ordered = (a: Row, b: Row) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.meetingId.localeCompare(b.meetingId);

/** The numbers each prospect's meetings should carry, by attendee row: null on a meeting not approved. */
export function numberRows(rows: Row[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const byPerson = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.approved) { out.set(r.id, null); continue; }
    byPerson.set(r.personId, [...(byPerson.get(r.personId) ?? []), r]);
  }
  for (const list of byPerson.values()) list.sort(ordered).forEach((r, i) => out.set(r.id, i + 1));
  return out;
}

/**
 * Number again every meeting with these prospects. Returns the meetings whose numbers changed,
 * which Twenty then needs to hear about.
 */
export async function renumberProspects(personIds: Iterable<string | null | undefined>): Promise<string[]> {
  const ids = [...new Set([...personIds].filter((id): id is string => Boolean(id)))];
  if (!ids.length) return [];
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK})`;
    const found = await tx.meetingAttendee.findMany({
      where: { personId: { in: ids }, prospect: true },
      select: { id: true, personId: true, meetingId: true, meetingNumber: true, meeting: { select: { occurredAt: true, createdAt: true, review: true } } },
    });
    const rows: Row[] = found.map((a) => ({ id: a.id, personId: a.personId!, meetingId: a.meetingId, meetingNumber: a.meetingNumber, occurredAt: a.meeting.occurredAt, createdAt: a.meeting.createdAt, approved: a.meeting.review === 'APPROVED' }));
    const numbers = numberRows(rows);
    const changed = new Set<string>();
    for (const r of rows) {
      const n = numbers.get(r.id) ?? null;
      if (n === r.meetingNumber) continue;
      await tx.meetingAttendee.update({ where: { id: r.id }, data: { meetingNumber: n } });
      changed.add(r.meetingId);
    }
    // Each meeting these people were on: the highest of all its prospects' numbers, theirs or not.
    const meetingIds = [...new Set(rows.map((r) => r.meetingId))];
    const meetings = await tx.meeting.findMany({ where: { id: { in: meetingIds } }, select: { id: true, meetingNumber: true, review: true, attendees: { where: { prospect: true }, select: { meetingNumber: true } } } });
    for (const m of meetings) {
      const top = m.review === 'APPROVED' ? Math.max(0, ...m.attendees.map((a) => a.meetingNumber ?? 0)) || null : null;
      if (top === m.meetingNumber) continue;
      await tx.meeting.update({ where: { id: m.id }, data: { meetingNumber: top } });
      changed.add(m.id);
    }
    return [...changed];
  });
}

/** A meeting with no prospects left (all removed) carries no number. */
export async function clearMeetingNumber(meetingId: string): Promise<boolean> {
  const { count } = await prisma.meeting.updateMany({ where: { id: meetingId, meetingNumber: { not: null }, attendees: { none: { prospect: true } } }, data: { meetingNumber: null } });
  return count > 0;
}

export type ProspectNumber = {
  personId: string;
  /** Which meeting with this person the one being added or edited will be. */
  number: number;
  /** The days (YYYY-MM-DD) of the meetings before it, oldest first. */
  earlier: string[];
  /** Meetings after it that move up one when it is saved. */
  later: number;
};

/**
 * For the form, before saving: which meeting with each prospect this one will be, counting itself.
 * A meeting on the same day as another goes after the ones added before it.
 */
export async function upcomingNumbers(personIds: string[], day: string, exceptMeetingId: string | null): Promise<ProspectNumber[]> {
  const ids = [...new Set(personIds.filter(Boolean))].slice(0, 100);
  const parsed = parseMeetingDay(day);
  if (!ids.length || !parsed) return [];
  const at = meetingDayInstant(parsed);
  const self = exceptMeetingId ? await prisma.meeting.findUnique({ where: { id: exceptMeetingId }, select: { createdAt: true } }) : null;
  const addedAt = self?.createdAt ?? new Date();
  const rows = await prisma.meetingAttendee.findMany({
    where: { personId: { in: ids }, prospect: true, meeting: { review: 'APPROVED', ...(exceptMeetingId ? { id: { not: exceptMeetingId } } : {}) } },
    select: { personId: true, meeting: { select: { occurredAt: true, createdAt: true } } },
  });
  return ids.map((personId) => {
    const theirs = rows.filter((r) => r.personId === personId).map((r) => r.meeting);
    const before = theirs.filter((m) => m.occurredAt < at || (m.occurredAt.getTime() === at.getTime() && m.createdAt < addedAt)).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    return { personId, number: before.length + 1, earlier: before.map((m) => meetingDay(m.occurredAt)), later: theirs.length - before.length };
  });
}

/** "1st", "2nd", "3rd", "11th", "22nd". */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}
