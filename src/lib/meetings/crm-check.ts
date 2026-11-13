import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, SYSTEM_ACTOR } from '../audit';
import { externalPeopleWhere } from '../internal-organizations';
import { getSettings, isExternalEmail } from '../settings';
import { getTwentyClient, type TwentyClient } from '../twenty';
import type { TwentyMeetingRecord } from '../twenty/types';
import { meetingFacts, pushMeetingToCrm, type MeetingFacts } from './crm';
import { meetingDay } from './day';
import { renumberProspects } from './numbering';
import { refreshMeetingAccounts } from './account';

/**
 * Twenty keeps the record and Cadence writes it (owner, 2 November 2026: "Cadence is not a record
 * keeper, it writes the data to CRM. and CRM data is used for reports"). Meetings are added and
 * changed in Cadence and written to Twenty's Meetings object; nothing flows back. This pass makes
 * sure Twenty holds what Cadence wrote, and that every meeting has its number:
 *
 * - an older meeting with no prospect (its people typed in before the form had a prospects list)
 *   has them linked to their Twenty person, by address or by a name only one person there has;
 * - every prospect's meetings are counted again by date, so a number is never left stale;
 * - every meeting's account is worked out again from its prospects (src/lib/meetings/account.ts);
 * - the Meetings object is read back, and every meeting whose record is missing, whose number,
 *   First Meeting box or contacts are not Cadence's, or whose record someone changed in Twenty, is
 *   written again as Cadence has it;
 * - a record Cadence did not write is left alone, and listed in Settings > Twenty.
 *
 * Run by the worker every ten minutes, and at its next tick after Twenty reports a change to a meeting.
 */

/** Writes per pass; the rest follow at the next tick. Twenty allows 100 requests a minute. */
const MAX_WRITES = 60;

export type MeetingsInCrmStats = { read: number; linked: number; written: number; waiting: number; notFromCadence: number; duplicatesRemoved?: number };

/**
 * N15: a record that still differs from what Cadence wrote, though nobody has changed it since Cadence
 * last wrote it, can never match (a field Twenty stores another way): it is written again at most
 * once in this long, not at every pass.
 */
const UNMATCHABLE_RETRY_MS = 3_600_000;

/** A tag's name and its value read the same: "Karson Reed" is KARSON_REED. */
const slug = (s: string) => s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
const sameList = (a: string[], b: string[]) => a.map(slug).sort().join('\n') === b.map(slug).sort().join('\n');

/** The fields whose value in Twenty is no longer what Cadence wrote there. */
export function changedInTwenty(wrote: MeetingFacts, now: MeetingFacts): (keyof MeetingFacts)[] {
  const keys: (keyof MeetingFacts)[] = ['name', 'day', 'bookedBy', 'products', 'team', 'recording', 'contacts'];
  return keys.filter((k) => {
    const a = wrote[k];
    const b = now[k];
    if (a === null) return false;
    if (Array.isArray(a)) return !Array.isArray(b) || (k === 'contacts' ? a.join() !== b.join() : !sameList(a, b));
    return a !== b;
  });
}

/** The Cadence meeting a record was written for, by its Cadence ID or its link back. */
function cadenceIdOf(f: { cadenceId: string | null; cadenceLink: string | null }, r: TwentyMeetingRecord): string | null {
  const id = f.cadenceId ? r.data[f.cadenceId] : null;
  if (typeof id === 'string' && id.trim()) return id.trim();
  const link = f.cadenceLink ? (r.data[f.cadenceLink] as { primaryLinkUrl?: unknown } | null)?.primaryLinkUrl : null;
  return typeof link === 'string' ? /\/meetings\/([0-9a-f-]{36})/i.exec(link)?.[1] ?? null : null;
}

/**
 * The prospects of a meeting that has none: each person outside the team who is in Twenty, by their
 * address or by a name only one person there has. Returns their ids.
 */
async function linkTypedIn(meetingId: string, attendees: { id: string; personId: string | null; userId: string | null; name: string | null; email: string | null }[], internalDomains: string[], notTeam: Prisma.PersonCacheWhereInput, companyId: string | null = null): Promise<string[]> {
  const linked: string[] = [];
  for (const a of attendees) {
    if (a.userId || (a.email && !isExternalEmail(a.email, internalDomains))) continue;
    let personId = a.personId;
    if (!personId) {
      const [first, ...rest] = (a.name ?? '').trim().split(/\s+/);
      const match = a.email
        ? { email: { equals: a.email.trim(), mode: 'insensitive' as const } }
        // N24: a name alone, when the meeting has an account, only matches someone at that account.
        : first && rest.length ? { firstName: { equals: first, mode: 'insensitive' as const }, lastName: { equals: rest.join(' '), mode: 'insensitive' as const }, ...(companyId ? { companyId } : {}) } : null;
      if (!match) continue;
      const hits = await prisma.personCache.findMany({ where: { AND: [{ deletedAt: null }, match, notTeam] }, select: { id: true }, take: 2 });
      if (hits.length !== 1) continue;
      personId = hits[0].id;
    } else if (!(await prisma.personCache.count({ where: { AND: [{ id: personId, deletedAt: null }, notTeam] } }))) continue;
    if (linked.includes(personId)) continue;
    await prisma.meetingAttendee.update({ where: { id: a.id }, data: { personId, prospect: true } });
    linked.push(personId);
  }
  if (linked.length) await logAudit({ entityType: 'meeting', entityId: meetingId, action: 'prospects_linked', actor: SYSTEM_ACTOR, details: { prospects: linked.length } });
  return linked;
}

const pendingWrites = async () => new Set((await prisma.twentyWrite.findMany({ where: { operation: 'syncMeeting', dryRun: false, status: { in: ['FAILED', 'RETRYING'] } }, select: { payload: true } })).map((w) => String((w.payload as { meetingId?: unknown } | null)?.meetingId ?? '')));

export const NOT_FROM_CADENCE_KEY = 'meetingsNotFromCadence';
export type NotFromCadence = { count: number; items: { id: string; name: string; day: string | null }[] };

export async function checkMeetingsInCrm(options: { client?: TwentyClient } = {}): Promise<MeetingsInCrmStats | null> {
  const client = options.client ?? (await getTwentyClient());
  const schema = await client.meetingSchema();
  if (!schema) return null;
  const f = schema.fields;
  const [records, pending, { rules }] = await Promise.all([client.listMeetingRecords(schema), pendingWrites(), getSettings()]);
  const stats: MeetingsInCrmStats = { read: records.length, linked: 0, written: 0, waiting: 0, notFromCadence: 0 };
  const first: string[] = [];

  // Older meetings with no prospect: linked to the people they were with, where Twenty knows them.
  const unlinked = await prisma.meeting.findMany({ where: { review: 'APPROVED', attendees: { none: { prospect: true } } }, select: { id: true, companyId: true, attendees: { select: { id: true, personId: true, userId: true, name: true, email: true } } } });
  const notTeam = unlinked.length ? await externalPeopleWhere({ keepBlocked: true }) : {};
  for (const m of unlinked) {
    const linked = await linkTypedIn(m.id, m.attendees, rules.internalDomains, notTeam, m.companyId).catch((err) => {
      console.warn(`[meetings] could not link the people on meeting ${m.id}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    });
    if (!linked.length) continue;
    first.push(m.id);
    stats.linked++;
  }

  // Every prospect counted again, not only the ones touched here.
  const everyone = await prisma.meetingAttendee.findMany({ where: { prospect: true, personId: { not: null } }, select: { personId: true }, distinct: ['personId'] });
  const moved = await renumberProspects(everyone.map((a) => a.personId));
  // Every meeting's account from its prospects, older meetings included (owner, 9 Nov 2026).
  moved.push(...(await refreshMeetingAccounts()));

  // What Twenty holds against what Cadence wrote.
  const meetings = await prisma.meeting.findMany({ select: { id: true, review: true, meetingNumber: true, twentyMeetingId: true, twentySnapshot: true, twentySyncedAt: true, attendees: { where: { prospect: true }, select: { personId: true } } } });
  const byRecord = new Map(records.map((r) => [r.id, r]));
  const byCadenceId = new Map(records.flatMap((r) => { const id = cadenceIdOf(f, r); return id ? [[id, r] as const] : []; }));
  const stale: string[] = [];
  const recordOf = new Map<string, string>();
  const nowMs = Date.now();
  for (const m of meetings) {
    if (m.review !== 'APPROVED') continue;
    const r = (m.twentyMeetingId ? byRecord.get(m.twentyMeetingId) : undefined) ?? byCadenceId.get(m.id);
    if (r) recordOf.set(m.id, r.id);
    if (r && r.id !== m.twentyMeetingId) await prisma.meeting.update({ where: { id: m.id }, data: { twentyMeetingId: r.id } });
    if (!r || !m.twentySnapshot) { stale.push(m.id); continue; }
    const n = m.meetingNumber ?? null;
    const number = f.meetingNumber && r.data[f.meetingNumber] != null ? Number(r.data[f.meetingNumber]) : null;
    const prospects = [...new Set(m.attendees.map((a) => a.personId!))].sort();
    const there = meetingFacts(schema, r.data, r.contactPersonIds);
    if (
      changedInTwenty(m.twentySnapshot as unknown as MeetingFacts, there).length ||
      (f.meetingNumber && number !== n) ||
      (f.firstMeeting && Boolean(r.data[f.firstMeeting]) !== (n === 1)) ||
      (there.contacts && prospects.join() !== there.contacts.join())
    ) {
      const editedSince = !m.twentySyncedAt || Date.parse(r.updatedAt) >= m.twentySyncedAt.getTime();
      if (editedSince || nowMs - m.twentySyncedAt!.getTime() >= UNMATCHABLE_RETRY_MS) stale.push(m.id);
    }
  }
  // N16: a second record carrying a meeting's Cadence ID (a create whose answer was lost) is a
  // duplicate of the meeting's own record: it would count twice on the bonus dashboard.
  const duplicates = records.filter((r) => { const id = cadenceIdOf(f, r); const own = id ? recordOf.get(id) : undefined; return Boolean(own && own !== r.id); });

  // Records Cadence did not write: left as they are, and listed for the admin.
  const written = new Set(meetings.flatMap((m) => (m.twentyMeetingId ? [m.twentyMeetingId] : [])));
  const others = records.filter((r) => !written.has(r.id) && !cadenceIdOf(f, r));
  stats.notFromCadence = others.length;
  const day = (r: TwentyMeetingRecord) => { const d = meetingFacts(schema, r.data, []).day; return d ?? (r.createdAt ? meetingDay(new Date(r.createdAt)) : null); };
  const listed: NotFromCadence = { count: others.length, items: others.slice(0, 50).map((r) => ({ id: r.id, name: String(r.data.name ?? '').trim(), day: day(r) })) };
  await prisma.setting.upsert({ where: { key: NOT_FROM_CADENCE_KEY }, create: { key: NOT_FROM_CADENCE_KEY, value: listed }, update: { value: listed } });

  if (client.kind === 'dry-run') return stats;
  for (const r of duplicates.slice(0, 10)) {
    try {
      await client.deleteMeetingRecord(schema, r.id);
      stats.duplicatesRemoved = (stats.duplicatesRemoved ?? 0) + 1;
      await logAudit({ entityType: 'meeting', entityId: cadenceIdOf(f, r)!, action: 'crm_duplicate_removed', actor: SYSTEM_ACTOR, details: { twentyMeetingId: r.id } });
    } catch (err) {
      console.warn(`[meetings] could not remove duplicate CRM meeting ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const approved = new Set(meetings.filter((m) => m.review === 'APPROVED').map((m) => m.id));
  const queue = [...new Set([...first, ...moved, ...stale])].filter((id) => approved.has(id) && !pending.has(id));
  for (const id of queue.slice(0, MAX_WRITES)) {
    await pushMeetingToCrm(id);
    stats.written++;
  }
  stats.waiting = Math.max(0, queue.length - MAX_WRITES);
  return stats;
}

/**
 * N15: Cadence's own write to a meeting makes Twenty send a meeting webhook. A record (or a meeting
 * contact row pointing at a record) Cadence wrote in the last two minutes is that echo, not a change.
 */
export async function ownMeetingEcho(recordId: string, record: Record<string, unknown>, now = Date.now()): Promise<boolean> {
  const recent = await prisma.meeting.findMany({ where: { twentySyncedAt: { gte: new Date(now - 120_000) }, twentyMeetingId: { not: null } }, select: { twentyMeetingId: true } });
  const ids = new Set(recent.map((m) => m.twentyMeetingId!));
  return ids.has(recordId) || Object.values(record).some((v) => typeof v === 'string' && ids.has(v));
}

/** Twenty told Cadence a meeting or a meeting contact changed: the worker checks them on its next tick. */
export const MEETINGS_CHANGED_KEY = 'meetingsChangedInTwenty';
export async function noteMeetingsChangedInTwenty(at = new Date()): Promise<void> {
  await prisma.setting.upsert({ where: { key: MEETINGS_CHANGED_KEY }, create: { key: MEETINGS_CHANGED_KEY, value: { at: at.toISOString() } }, update: { value: { at: at.toISOString() } } });
}

/** The records in Twenty's Meetings object that Cadence did not write, as the last check found them. */
export async function meetingsNotFromCadence(): Promise<NotFromCadence> {
  const row = await prisma.setting.findUnique({ where: { key: NOT_FROM_CADENCE_KEY } });
  return (row?.value as NotFromCadence | null) ?? { count: 0, items: [] };
}
