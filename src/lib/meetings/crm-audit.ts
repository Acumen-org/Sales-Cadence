import { prisma } from '../db';
import { getTwentyClient, type TwentyClient } from '../twenty';
import type { TwentyMeetingRecord } from '../twenty/types';
import { isCounted } from './counted';
import { meetingDay } from './day';
import { meetingFacts } from './crm';

/*
 * Owner, 22 Nov 2026: "check the CRM please, verify all the no." A read-only audit: every record in
 * the CRM's Meetings object against Cadence. Nothing is written to the CRM; the meetings check
 * (crm-check.ts, every ten minutes) is what puts a difference right. The last result is kept for
 * Settings > Meetings and email.
 */

export const CRM_AUDIT_KEY = 'meetingsCrmAudit';

export type AuditProblemKind =
  | 'number_differs'      // the CRM's Meeting Number is not Cadence's
  | 'first_differs'       // the CRM's First Meeting box is not Cadence's
  | 'day_differs'         // the CRM's date is not the meeting's day
  | 'missing'             // a meeting that counts has no record in the CRM
  | 'waiting_in_crm'      // a meeting waiting for approval is in the CRM
  | 'declined_in_crm'     // a declined (or removed) meeting is in the CRM
  | 'deleted_in_crm'      // the record's Cadence meeting no longer exists
  | 'duplicate';          // a second record for the same meeting

export type AuditProblem = { kind: AuditProblemKind; meetingId: string | null; recordId: string | null; title: string; day: string | null; bookedBy: string | null; cadence: string | null; crm: string | null };

export type MeetingsCrmAudit = {
  at: string;
  /** Records in the CRM's Meetings object, and how many Cadence wrote. */
  records: number; fromCadence: number; notFromCadence: number;
  /** Meetings in Cadence that count (should each have one record), and how many match on every check. */
  counted: number; matched: number;
  /** Which checks the CRM could be read for: a field it does not have cannot be compared. */
  fields: { meetingNumber: boolean; firstMeeting: boolean; date: boolean };
  problems: AuditProblem[];
};

function cadenceIdOf(f: { cadenceId: string | null; cadenceLink: string | null }, r: TwentyMeetingRecord): string | null {
  const id = f.cadenceId ? r.data[f.cadenceId] : null;
  if (typeof id === 'string' && id.trim()) return id.trim();
  const link = f.cadenceLink ? (r.data[f.cadenceLink] as { primaryLinkUrl?: unknown } | null)?.primaryLinkUrl : null;
  return typeof link === 'string' ? /\/meetings\/([0-9a-f-]{36})/i.exec(link)?.[1] ?? null : null;
}

const numberOf = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export async function auditMeetingsInCrm(options: { client?: TwentyClient; now?: Date } = {}): Promise<MeetingsCrmAudit | { error: string }> {
  const client = options.client ?? (await getTwentyClient());
  const schema = await client.meetingSchema();
  if (!schema) return { error: 'The CRM has no Meetings object Cadence can read.' };
  const f = schema.fields;
  const [records, meetings] = await Promise.all([
    client.listMeetingRecords(schema),
    prisma.meeting.findMany({ select: { id: true, title: true, occurredAt: true, review: true, approval: true, meetingNumber: true, bookedBy: { select: { name: true } } } }),
  ]);
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const problems: AuditProblem[] = [];
  const seen = new Map<string, string>();
  const ok = new Set<string>();
  let fromCadence = 0;

  for (const r of records) {
    const id = cadenceIdOf(f, r);
    if (!id) continue;
    fromCadence++;
    const m = byId.get(id);
    const name = String(r.data.name ?? '').trim();
    const crmDay = meetingFacts(schema, r.data, []).day;
    if (!m) { problems.push({ kind: 'deleted_in_crm', meetingId: id, recordId: r.id, title: name || 'A meeting', day: crmDay, bookedBy: null, cadence: 'Deleted in Cadence', crm: 'In the CRM' }); continue; }
    const base = { meetingId: m.id, recordId: r.id, title: m.title, day: meetingDay(m.occurredAt), bookedBy: m.bookedBy?.name ?? null };
    if (seen.has(id)) { problems.push({ ...base, kind: 'duplicate', cadence: '1 record', crm: `Another record (${seen.get(id)})` }); continue; }
    seen.set(id, r.id);
    if (m.approval === 'WAITING' && m.review === 'APPROVED') { problems.push({ ...base, kind: 'waiting_in_crm', cadence: 'Waiting for approval', crm: 'In the CRM' }); continue; }
    if (!isCounted(m)) { problems.push({ ...base, kind: 'declined_in_crm', cadence: m.approval === 'DECLINED' ? 'Declined' : 'Removed', crm: 'In the CRM' }); continue; }
    let good = true;
    if (f.meetingNumber) {
      const n = numberOf(r.data[f.meetingNumber]);
      if (n !== (m.meetingNumber ?? null)) { good = false; problems.push({ ...base, kind: 'number_differs', cadence: m.meetingNumber ? String(m.meetingNumber) : 'No number', crm: n === null ? 'Empty' : String(n) }); }
    }
    if (f.firstMeeting) {
      const first = Boolean(r.data[f.firstMeeting]);
      if (first !== (m.meetingNumber === 1)) { good = false; problems.push({ ...base, kind: 'first_differs', cadence: m.meetingNumber === 1 ? 'First meeting' : 'Not a first meeting', crm: first ? 'Ticked' : 'Not ticked' }); }
    }
    if (f.date && crmDay && crmDay !== base.day) { good = false; problems.push({ ...base, kind: 'day_differs', cadence: base.day, crm: crmDay }); }
    if (good) ok.add(m.id);
  }
  const counted = meetings.filter(isCounted);
  for (const m of counted) {
    if (!seen.has(m.id)) problems.push({ kind: 'missing', meetingId: m.id, recordId: null, title: m.title, day: meetingDay(m.occurredAt), bookedBy: m.bookedBy?.name ?? null, cadence: m.meetingNumber ? `Meeting ${m.meetingNumber}` : 'No number', crm: 'Not in the CRM' });
  }
  const order: AuditProblemKind[] = ['waiting_in_crm', 'declined_in_crm', 'deleted_in_crm', 'duplicate', 'missing', 'number_differs', 'first_differs', 'day_differs'];
  problems.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (b.day ?? '').localeCompare(a.day ?? ''));
  const audit: MeetingsCrmAudit = {
    at: (options.now ?? new Date()).toISOString(),
    records: records.length, fromCadence, notFromCadence: records.length - fromCadence,
    counted: counted.length, matched: counted.filter((m) => ok.has(m.id)).length,
    fields: { meetingNumber: Boolean(f.meetingNumber), firstMeeting: Boolean(f.firstMeeting), date: Boolean(f.date) },
    problems: problems.slice(0, 300),
  };
  await prisma.setting.upsert({ where: { key: CRM_AUDIT_KEY }, create: { key: CRM_AUDIT_KEY, value: audit as object }, update: { value: audit as object } });
  return audit;
}

export async function lastMeetingsCrmAudit(): Promise<MeetingsCrmAudit | null> {
  const row = await prisma.setting.findUnique({ where: { key: CRM_AUDIT_KEY } });
  return (row?.value as MeetingsCrmAudit | null) ?? null;
}
