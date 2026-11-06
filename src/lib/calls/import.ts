import { prisma } from '../db';
import { logAudit, SYSTEM_ACTOR } from '../audit';
import { getTwilioReader, type TwilioCall, type TwilioReader } from './twilio';
import { hasClientEnd, upsertImportedCall, type RepUser } from './call-log';

/**
 * The worker job `twilioImport` (plan 9.3): every 2 minutes, read-only. Calls.json from the
 * watermark minus 10 minutes (the overlap catches calls that started just before the last run),
 * unfinished calls read again, then the recordings of ended calls. Nothing is written to Twilio.
 * One run at a time (B166): a run holds a lease, and a second run says so instead of racing it.
 * Recordings are looked for until 48 hours after the call, then marked not found (N050).
 */

export const WATERMARK_KEY = 'twilioImport.watermark';
export const STATUS_KEY = 'twilioImport.status';
/** Calls that started before the first good import run are logged without asking anyone for a form. */
export const FORMS_FROM_KEY = 'twilioImport.formsFrom';
/** The lease a run holds (B166). */
export const LEASE_KEY = 'twilioImport.lease';
const OVERLAP_MS = 10 * 60_000;
const FIRST_RUN_MS = 24 * 3600_000;
/** How long after a call ends Cadence keeps looking for its recording (N050). */
export const RECORDING_WINDOW_MS = 48 * 3600_000;
/** A run that died keeps its lease no longer than this. */
const LEASE_MS = 10 * 60_000;

export const IMPORT_RUNNING = 'An import is already running. Its calls show here when it ends.';

export type ImportStats = { ran: boolean; reason?: string; busy?: boolean; read: number; stored: number; created: number; forms: number; recordings: number; skippedLegs: number; error?: string };

async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  const v = row?.value as { at?: string } | null;
  return v?.at ?? null;
}
async function putSetting(key: string, value: Record<string, unknown>) {
  await prisma.setting.upsert({ where: { key }, create: { key, value: value as object }, update: { value: value as object } });
}

/** Take the import's lease, unless a live run holds it: one statement, so two runs cannot both win. */
async function takeLease(now: Date): Promise<string | null> {
  const token = `${now.toISOString()}:${Math.random().toString(36).slice(2)}`;
  const until = new Date(now.getTime() + LEASE_MS).toISOString();
  const rows = await prisma.$queryRaw<{ key: string }[]>`
    INSERT INTO "Setting" (key, value, "updatedAt") VALUES (${LEASE_KEY}, jsonb_build_object('token', ${token}::text, 'until', ${until}::text), now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()
    WHERE ("Setting".value->>'until') IS NULL OR ("Setting".value->>'until')::timestamptz < ${now}
    RETURNING key`;
  return rows.length ? token : null;
}

async function dropLease(token: string) {
  await prisma.$executeRaw`DELETE FROM "Setting" WHERE key = ${LEASE_KEY} AND value->>'token' = ${token}`;
}

export async function importStatus(): Promise<{ lastRunAt: string | null; lastError: string | null; stats: Partial<ImportStats> | null; failedInARow: number }> {
  const row = await prisma.setting.findUnique({ where: { key: STATUS_KEY } });
  const v = (row?.value ?? null) as { at?: string; error?: string | null; stats?: Partial<ImportStats>; failedInARow?: number } | null;
  return { lastRunAt: v?.at ?? null, lastError: v?.error ?? null, stats: v?.stats ?? null, failedInARow: v?.failedInARow ?? 0 };
}

export async function importTwilioCalls(opts: { now?: Date; reader?: TwilioReader | null } = {}): Promise<ImportStats> {
  const now = opts.now ?? new Date();
  const stats: ImportStats = { ran: false, read: 0, stored: 0, created: 0, forms: 0, recordings: 0, skippedLegs: 0 };
  let reader: TwilioReader | null;
  try { reader = opts.reader === undefined ? getTwilioReader() : opts.reader; } catch (err) { return { ...stats, reason: err instanceof Error ? err.message : String(err) }; }
  if (!reader) return { ...stats, reason: 'Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET).' };
  const lease = await takeLease(now);
  if (!lease) return { ...stats, busy: true, reason: IMPORT_RUNNING };
  stats.ran = true;
  try {
    const watermark = await getSetting(WATERMARK_KEY);
    // N049: until a run has gone through, nothing is due a form; the first good run starts the clock.
    const formsFrom = (await getSetting(FORMS_FROM_KEY)) ?? now.toISOString();
    const after = new Date((watermark ? Date.parse(watermark) : now.getTime() - FIRST_RUN_MS) - OVERLAP_MS);

    const legs = new Map<string, TwilioCall>();
    let page: string | null = null;
    for (let i = 0; i < 100; i++) {
      const r: { calls: TwilioCall[]; nextPage: string | null } = await reader.listCalls({ after, nextPage: page });
      for (const c of r.calls) legs.set(c.sid, c);
      page = r.nextPage;
      if (!page) break;
    }
    // A long call that began before the overlap still has to end (a hand-logged call joined to it too).
    const unfinished = await prisma.callLog.findMany({ where: { statusRank: { lt: 4 }, startedAt: { gte: new Date(now.getTime() - 6 * 3600_000) }, twilioCallSid: { not: null } }, select: { twilioCallSid: true } });
    for (const u of unfinished) if (!legs.has(u.twilioCallSid!)) { const c = await reader.getCall(u.twilioCallSid!); if (c) legs.set(c.sid, c); }
    stats.read = legs.size;

    const parents = new Map<string, TwilioCall | null>();
    const parentOf = async (c: TwilioCall) => {
      if (!c.parentCallSid) return null;
      if (legs.has(c.parentCallSid)) return legs.get(c.parentCallSid)!;
      if (!parents.has(c.parentCallSid)) parents.set(c.parentCallSid, await reader!.getCall(c.parentCallSid));
      return parents.get(c.parentCallSid) ?? null;
    };
    const users: RepUser[] = await prisma.user.findMany({ where: { active: true }, select: { id: true, callerNumber: true, callerNumberSince: true, aliases: true } });
    const ctx = { users, formsFrom: new Date(formsFrom), now };
    for (const leg of legs.values()) {
      // One row per conversation: the leg to the phone network. The dialpad's browser leg is folded in.
      if (hasClientEnd(leg)) { stats.skippedLegs++; continue; }
      const parent = await parentOf(leg);
      if (parent && !hasClientEnd(parent)) { stats.skippedLegs++; continue; }
      const r = await upsertImportedCall(leg, parent, ctx);
      stats.stored++;
      if (r.created) stats.created++;
      if (r.formOpened) stats.forms++;
    }

    // N050: every ended call without its recording is looked at again until 48 hours after it ended,
    // whenever it was first read; after that it is marked not found, so the call page can say so.
    // Only an answered call is recorded. A call two hours old is asked about every half hour, not every run.
    const waiting = await prisma.callLog.findMany({ where: { twilioCallSid: { not: null }, status: 'COMPLETED', recordingSid: null, recordingStatus: null, endedAt: { not: null } }, select: { id: true, twilioCallSid: true, parentCallSid: true, endedAt: true, importedAt: true }, take: 500 });
    for (const c of waiting) {
      const age = now.getTime() - c.endedAt!.getTime();
      if (age >= RECORDING_WINDOW_MS) { await prisma.callLog.update({ where: { id: c.id }, data: { recordingStatus: 'not_found' } }); continue; }
      // (A call read again in this very run is asked about now.)
      const lastAsked = c.importedAt && c.importedAt.getTime() !== now.getTime() ? now.getTime() - c.importedAt.getTime() : Infinity;
      if (age >= 2 * 3600_000 && lastAsked < 30 * 60_000) continue;
      const recordings = [...(await reader.listRecordings(c.twilioCallSid!)), ...(c.parentCallSid ? await reader.listRecordings(c.parentCallSid) : [])].filter((x) => x.status === 'completed');
      const latest = recordings.sort((a, b) => (b.dateCreated ?? '').localeCompare(a.dateCreated ?? ''))[0];
      if (latest) {
        await prisma.callLog.update({ where: { id: c.id }, data: { recordingSid: latest.sid, recordingSec: latest.durationSec, recordingCount: recordings.length, recordingStatus: 'found' } });
        stats.recordings++;
      } else if (age >= 2 * 3600_000) await prisma.callLog.update({ where: { id: c.id }, data: { importedAt: now } });
    }
    await putSetting(WATERMARK_KEY, { at: now.toISOString() });
    // N049: the clock for forms starts with the first run that went through, never a failed one.
    if (!(await getSetting(FORMS_FROM_KEY))) await putSetting(FORMS_FROM_KEY, { at: formsFrom });
    await putSetting(STATUS_KEY, { at: now.toISOString(), error: null, stats, failedInARow: 0 });
    return stats;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Runs that failed one after another, for the health card (PLAN 4.7: two in a row ring the admins).
    const before = (await prisma.setting.findUnique({ where: { key: STATUS_KEY } }))?.value as { failedInARow?: number } | null;
    await putSetting(STATUS_KEY, { at: now.toISOString(), error: message.slice(0, 500), stats, failedInARow: (before?.failedInARow ?? 0) + 1 });
    await logAudit({ entityType: 'call', entityId: 'twilio-import', action: 'import_failed', actor: SYSTEM_ACTOR, details: { message: message.slice(0, 500) } }).catch(() => undefined);
    return { ...stats, error: message };
  } finally {
    await dropLease(lease).catch(() => undefined);
  }
}
