import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, SYSTEM_ACTOR } from '../audit';
import { ROLES_NEEDING_POD } from '../auth/rbac';
import { getSettings, isExternalEmail } from '../settings';
import { getTwentyClient, type TwentyClient } from '../twenty';
import type { TwentyCalendarEvent, TwentyCalendarParticipant } from '../twenty/types';
import { resolveAttendees, type AttendeeSelection } from './attendees';
import { parseMeetingLink } from './providers';

/**
 * Meetings come from the team's calendars by themselves (owner, 25 September 2026: "It is not
 * easy to add a meeting and is very manual at this point"). Twenty syncs the calendars; every event
 * with someone from our side and a contact from the CRM on it becomes a meeting in Cadence - its
 * title, time, length, join link, account and attendees - and a reschedule, a new guest or a
 * cancellation updates that same meeting. The FO who booked it is the organiser when they carry
 * outreach, else the first such FO on the invite. What people add by hand - notes, a recording,
 * a transcript, products - is never overwritten.
 */
export type CalendarImport = { result: 'created' | 'updated' | 'linked' | 'removed' | 'skipped'; reason?: string; meetingId?: string };

type Team = { id: string; name: string; email: string; aliases: string[]; twentyMemberId: string | null; role: string }[];

const skipped = (reason: string): CalendarImport => ({ result: 'skipped', reason });

/**
 * Safe to take away when its event goes: made from the calendar, still ahead, and nothing anyone
 * did to it - no notes, recording, transcript, products, edit or star. Anything else stays.
 */
const disposable = (m: { createdById: string | null; editedAt: Date | null; occurredAt: Date; notes: string | null; transcript: string | null; mediaUrl: string | null; sourceUrl: string; analysisStatus: string; products: string[]; _count: { favourites: number } }) =>
  !m.createdById && !m.editedAt && m.occurredAt > new Date() && !m.notes && !m.transcript && !m.mediaUrl && m.analysisStatus === 'NONE' && !m.products.length && !m._count.favourites && (!m.sourceUrl || parseMeetingLink(m.sourceUrl).isJoinLink);

async function removeImported(meetingId: string | null, reason: string): Promise<CalendarImport> {
  if (!meetingId) return skipped(reason);
  const m = await prisma.meeting.findUnique({ where: { id: meetingId }, select: { id: true, createdById: true, editedAt: true, occurredAt: true, notes: true, transcript: true, mediaUrl: true, sourceUrl: true, analysisStatus: true, products: true, _count: { select: { favourites: true } } } });
  if (!m) return skipped(reason);
  if (!disposable(m)) return { result: 'skipped', reason: `${reason}; kept because it has already happened or someone worked on it`, meetingId };
  await prisma.meeting.delete({ where: { id: m.id } });
  await logAudit({ entityType: 'meeting', entityId: m.id, action: 'removed_from_calendar', actor: SYSTEM_ACTOR, details: { reason } });
  return { result: 'removed', reason, meetingId: m.id };
}

function whoIs(p: TwentyCalendarParticipant, team: Team) {
  const handle = p.handle.trim().toLowerCase();
  return (p.workspaceMemberId ? team.find((u) => u.twentyMemberId === p.workspaceMemberId) : undefined) ?? (handle ? team.find((u) => [u.email, ...u.aliases].some((a) => a.trim().toLowerCase() === handle)) : undefined) ?? null;
}

export async function importCalendarEvent(event: TwentyCalendarEvent): Promise<CalendarImport> {
  const existing = await prisma.meeting.findUnique({ where: { calendarEventId: event.id }, select: { id: true, sourceUrl: true, bookedById: true, companyId: true, editedAt: true, attendees: { select: { email: true, personId: true, userId: true } } } });
  if (event.isCanceled) return removeImported(existing?.id ?? null, 'The meeting was cancelled');
  if (event.isFullDay || !event.startsAt) return removeImported(existing?.id ?? null, 'Not a meeting at a time');
  const startsAt = new Date(event.startsAt);
  if (Number.isNaN(startsAt.getTime())) return skipped('No start time');

  const [settings, team] = await Promise.all([
    getSettings(),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true, email: true, aliases: true, twentyMemberId: true, role: true } }),
  ]);
  const ours = (p: TwentyCalendarParticipant) => Boolean(p.workspaceMemberId || whoIs(p, team) || (p.handle && !isExternalEmail(p.handle, settings.rules.internalDomains)));
  const us = event.participants.filter(ours);
  const guests = event.participants.filter((p) => !ours(p));
  const guestEmails = guests.map((g) => g.handle.trim().toLowerCase()).filter(Boolean);
  const contacts = guests.length
    ? await prisma.personCache.findMany({ where: { deletedAt: null, OR: [{ id: { in: guests.flatMap((g) => (g.personId ? [g.personId] : [])) } }, ...(guestEmails.length ? [{ email: { in: guestEmails, mode: 'insensitive' as const } }] : [])] }, select: { id: true, email: true, firstName: true, lastName: true, companyId: true, companyName: true } })
    : [];
  if (!us.length || !contacts.length) return removeImported(existing?.id ?? null, 'Nobody from the team and a contact from the CRM on it');

  // Who booked it: the organiser if they carry outreach, else the first FO on the invite.
  const fo = (u: Team[number] | null) => (u && (ROLES_NEEDING_POD as readonly string[]).includes(u.role) ? u : null);
  const organiser = us.find((p) => p.isOrganizer);
  const bookedBy = fo(organiser ? whoIs(organiser, team) : null) ?? us.map((p) => fo(whoIs(p, team))).find(Boolean) ?? null;

  const contactFor = (g: TwentyCalendarParticipant) => contacts.find((c) => c.id === g.personId) ?? contacts.find((c) => c.email && c.email.toLowerCase() === g.handle.trim().toLowerCase()) ?? null;
  const entries: AttendeeSelection[] = event.participants.map((p) => {
    const user = whoIs(p, team);
    const contact = user ? null : contactFor(p);
    return { userId: user?.id ?? null, personId: contact?.id ?? null, name: p.displayName ?? (contact ? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim() || null : null), email: p.handle.trim() || null };
  });
  const attendees = await resolveAttendees(entries, existing?.bookedById ?? bookedBy?.id ?? null);
  const account = contacts.find((c) => c.companyId) ?? null;
  const link = event.conferenceUrl ? parseMeetingLink(event.conferenceUrl) : null;
  const durationSec = event.endsAt ? Math.max(0, Math.round((new Date(event.endsAt).getTime() - startsAt.getTime()) / 1000)) || null : null;
  const firstGuest = contacts[0];
  const title = event.title?.trim() || `Meeting with ${[firstGuest.firstName, firstGuest.lastName].filter(Boolean).join(' ') || firstGuest.email || 'a contact'}`;

  if (existing) {
    // The join link follows the invite until someone puts a recording there.
    const keepLink = existing.sourceUrl && !parseMeetingLink(existing.sourceUrl).isJoinLink;
    // Edited by hand: only a reschedule follows the invite; the title, length and guests are theirs.
    if (existing.editedAt) {
      await prisma.meeting.update({ where: { id: existing.id }, data: { occurredAt: startsAt } });
      return { result: 'updated', meetingId: existing.id };
    }
    await prisma.meeting.update({
      where: { id: existing.id },
      data: {
        title,
        occurredAt: startsAt,
        durationSec,
        ...(keepLink ? {} : { sourceUrl: event.conferenceUrl ?? '', provider: link?.provider ?? 'OTHER', embedUrl: link?.embedUrl ?? null }),
        ...(existing.companyId || !account?.companyId ? {} : { companyId: account.companyId, companyName: account.companyName }),
        ...(existing.bookedById || !bookedBy ? {} : { bookedById: bookedBy.id }),
      },
    });
    // New guests join the list; nobody is taken off it, in case they were added by hand.
    const known = (a: { email: string | null; personId: string | null; userId: string | null }) => existing.attendees.some((x) => (a.userId && x.userId === a.userId) || (a.personId && x.personId === a.personId) || (a.email && x.email?.toLowerCase() === a.email.toLowerCase()));
    const added = attendees.filter((a) => !known(a));
    if (added.length) await prisma.meetingAttendee.createMany({ data: added.map((a) => ({ ...a, meetingId: existing.id })), skipDuplicates: true });
    return { result: 'updated', meetingId: existing.id };
  }

  // Someone may already have added this meeting by hand: the same time, and the same join link or
  // one of the same contacts. A shared title alone is not enough - two FOs can each have a "Discovery call".
  const window = 15 * 60_000;
  const manual = await prisma.meeting.findFirst({
    where: { calendarEventId: null, occurredAt: { gte: new Date(startsAt.getTime() - window), lte: new Date(startsAt.getTime() + window) }, OR: [...(event.conferenceUrl ? [{ sourceUrl: event.conferenceUrl }] : []), { attendees: { some: { personId: { in: contacts.map((c) => c.id) } } } }] },
    select: { id: true },
  });
  if (manual) {
    await prisma.meeting.update({ where: { id: manual.id }, data: { calendarEventId: event.id } });
    return { result: 'linked', meetingId: manual.id };
  }

  let meeting: { id: string };
  try {
    meeting = await prisma.meeting.create({
    data: {
      title,
      calendarEventId: event.id,
      provider: link?.provider ?? 'OTHER',
      sourceUrl: event.conferenceUrl ?? '',
      embedUrl: link?.embedUrl ?? null,
      occurredAt: startsAt,
      durationSec,
      companyId: account?.companyId ?? null,
      companyName: account?.companyName ?? null,
      bookedById: bookedBy?.id ?? null,
      attendees: { create: attendees },
    },
  });
  } catch (err) {
    // The same event came in twice at once (its guests' webhooks): the other one made it; update that.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return importCalendarEvent(event);
    throw err;
  }
  await logAudit({ entityType: 'meeting', entityId: meeting.id, action: 'created_from_calendar', actor: SYSTEM_ACTOR, details: { title, calendarEventId: event.id, attendees: attendees.length } });
  return { result: 'created', meetingId: meeting.id };
}

/** A calendar event Twenty says was deleted: its meeting goes with it, unless someone worked on it. */
export async function removeCalendarEvent(eventId: string): Promise<CalendarImport> {
  const m = await prisma.meeting.findUnique({ where: { calendarEventId: eventId }, select: { id: true } });
  return removeImported(m?.id ?? null, 'The event was deleted');
}

/**
 * Every event in a window of days, for the first import and the nightly check: a meeting booked
 * a week ago for next Thursday has not changed since, so a scan by change date alone misses it.
 */
export async function importCalendarWindow(options: { from: Date; to: Date; client?: TwentyClient }): Promise<Record<CalendarImport['result'], number>> {
  const client = options.client ?? (await getTwentyClient());
  const stats = { created: 0, updated: 0, linked: 0, removed: 0, skipped: 0 };
  let after: string | null = null;
  for (let pages = 0; pages < 200; pages++) {
    const page = await client.listCalendarEvents({ startsFrom: options.from.toISOString(), startsBefore: options.to.toISOString(), after });
    // One event that will not import never stops the rest.
    for (const event of page.items) {
      try { stats[(await importCalendarEvent(event)).result] += 1; } catch (err) { stats.skipped += 1; console.warn('[calendar] could not import', event.id, err); }
    }
    if (!page.hasNextPage || !page.endCursor) break;
    after = page.endCursor;
  }
  return stats;
}

/**
 * The part of a join link that names the meeting: host and path, without the ?authuser=1 or
 * tracking a browser adds. "meet.google.com/abc-defg-hij" whatever was around it.
 */
export function linkKey(url: string): string | null {
  try {
    const u = new URL(url.trim());
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep it as written */ }
    const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^[a-z0-9-]+\.zoom\.us$/, 'zoom.us');
    return `${host}${path.replace(/\/+$/, '').toLowerCase()}`;
  } catch {
    return null;
  }
}

/**
 * What to search the stored links for: the link's longest run of letters and digits (a Meet code,
 * a Zoom number, a Teams meeting id), which reads the same whether the link was stored encoded or not.
 */
export function linkNeedle(url: string): string | null {
  const key = linkKey(url);
  if (!key) return null;
  const path = key.slice(key.indexOf('/'));
  const runs = path.match(/[a-z0-9_-]{6,}/g) ?? [];
  return runs.sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * A meeting's calendar event, found by the join link someone pasted: the same link however it was
 * copied, never a cancelled event, and for a link used again and again (a personal room), the
 * occurrence nearest to now.
 */
export async function calendarEventForLink(url: string, client?: TwentyClient, now = new Date()): Promise<TwentyCalendarEvent | null> {
  const key = linkKey(url);
  const needle = linkNeedle(url);
  if (!key || !needle) return null;
  const c = client ?? (await getTwentyClient());
  try {
    const found = (await c.listCalendarEvents({ conferenceUrl: needle, startsFrom: new Date(now.getTime() - 30 * 86_400_000).toISOString(), limit: 60 })).items.filter((e) => !e.isCanceled && e.startsAt && e.conferenceUrl && linkKey(e.conferenceUrl) === key);
    return found.sort((a, b) => Math.abs(new Date(a.startsAt!).getTime() - now.getTime()) - Math.abs(new Date(b.startsAt!).getTime() - now.getTime()))[0] ?? null;
  } catch {
    return null;
  }
}

/** Guests' webhooks come in bursts for one event: it is read once, not once per guest. */
const lastRead = new Map<string, number>();
export function readRecently(eventId: string, now = Date.now(), withinMs = 10_000): boolean {
  const at = lastRead.get(eventId);
  if (at !== undefined && now - at < withinMs) return true;
  lastRead.set(eventId, now);
  if (lastRead.size > 5000) for (const [id, t] of lastRead) if (now - t > withinMs) lastRead.delete(id);
  return false;
}
