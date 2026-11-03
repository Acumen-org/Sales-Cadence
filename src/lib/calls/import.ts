import { prisma } from '../db';
import { logAudit, SYSTEM_ACTOR } from '../audit';
import { getTwilioReader, type TwilioCall, type TwilioReader } from './twilio';
import { hasClientEnd, isFinal, upsertImportedCall, type RepUser } from './call-log';

/**
 * The worker job `twilioImport` (plan 9.3): every 2 minutes, read-only. Calls.json from the
 * watermark minus 10 minutes (the overlap catches calls that started just before the last run),
 * unfinished calls read again, then each ended call's recordings. Nothing is written to Twilio.
 */

export const WATERMARK_KEY = 'twilioImport.watermark';
export const STATUS_KEY = 'twilioImport.status';
/** Calls that started before the first import run are logged without asking anyone for a form. */
export const FORMS_FROM_KEY = 'twilioImport.formsFrom';
const OVERLAP_MS = 10 * 60_000;
const FIRST_RUN_MS = 24 * 3600_000;

export type ImportStats = { ran: boolean; reason?: string; read: number; stored: number; created: number; forms: number; recordings: number; skippedLegs: number; error?: string };

async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  const v = row?.value as { at?: string } | null;
  return v?.at ?? null;
}
async function putSetting(key: string, value: Record<string, unknown>) {
  await prisma.setting.upsert({ where: { key }, create: { key, value: value as object }, update: { value: value as object } });
}

export async function importStatus(): Promise<{ lastRunAt: string | null; lastError: string | null; stats: Partial<ImportStats> | null }> {
  const row = await prisma.setting.findUnique({ where: { key: STATUS_KEY } });
  const v = (row?.value ?? null) as { at?: string; error?: string | null; stats?: Partial<ImportStats> } | null;
  return { lastRunAt: v?.at ?? null, lastError: v?.error ?? null, stats: v?.stats ?? null };
}

export async function importTwilioCalls(opts: { now?: Date; reader?: TwilioReader | null } = {}): Promise<ImportStats> {
  const now = opts.now ?? new Date();
  const stats: ImportStats = { ran: false, read: 0, stored: 0, created: 0, forms: 0, recordings: 0, skippedLegs: 0 };
  let reader: TwilioReader | null;
  try { reader = opts.reader === undefined ? getTwilioReader() : opts.reader; } catch (err) { return { ...stats, reason: err instanceof Error ? err.message : String(err) }; }
  if (!reader) return { ...stats, reason: 'Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET).' };
  stats.ran = true;
  try {
    const watermark = await getSetting(WATERMARK_KEY);
    let formsFrom = await getSetting(FORMS_FROM_KEY);
    if (!formsFrom) { formsFrom = now.toISOString(); await putSetting(FORMS_FROM_KEY, { at: formsFrom }); }
    const after = new Date((watermark ? Date.parse(watermark) : now.getTime() - FIRST_RUN_MS) - OVERLAP_MS);

    const legs = new Map<string, TwilioCall>();
    let page: string | null = null;
    for (let i = 0; i < 100; i++) {
      const r: { calls: TwilioCall[]; nextPage: string | null } = await reader.listCalls({ after, nextPage: page });
      for (const c of r.calls) legs.set(c.sid, c);
      page = r.nextPage;
      if (!page) break;
    }
    // A long call that began before the overlap still has to end.
    const unfinished = await prisma.callLog.findMany({ where: { source: 'TWILIO_IMPORT', statusRank: { lt: 4 }, startedAt: { gte: new Date(now.getTime() - 6 * 3600_000) }, twilioCallSid: { not: null } }, select: { twilioCallSid: true } });
    for (const u of unfinished) if (!legs.has(u.twilioCallSid!)) { const c = await reader.getCall(u.twilioCallSid!); if (c) legs.set(c.sid, c); }
    stats.read = legs.size;

    const parents = new Map<string, TwilioCall | null>();
    const parentOf = async (c: TwilioCall) => {
      if (!c.parentCallSid) return null;
      if (legs.has(c.parentCallSid)) return legs.get(c.parentCallSid)!;
      if (!parents.has(c.parentCallSid)) parents.set(c.parentCallSid, await reader!.getCall(c.parentCallSid));
      return parents.get(c.parentCallSid) ?? null;
    };
    const users: RepUser[] = await prisma.user.findMany({ where: { active: true }, select: { id: true, callerNumber: true, aliases: true } });
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
      if (isFinal(r.call.status) && !r.call.recordingSid && (!r.call.endedAt || now.getTime() - r.call.endedAt.getTime() < 2 * 3600_000)) {
        const recordings = [...(await reader.listRecordings(leg.sid)), ...(leg.parentCallSid ? await reader.listRecordings(leg.parentCallSid) : [])].filter((x) => x.status === 'completed');
        const latest = recordings.sort((a, b) => (b.dateCreated ?? '').localeCompare(a.dateCreated ?? ''))[0];
        if (latest) {
          await prisma.callLog.update({ where: { id: r.call.id }, data: { recordingSid: latest.sid, recordingSec: latest.durationSec, recordingCount: recordings.length } });
          stats.recordings++;
        }
      }
    }
    await putSetting(WATERMARK_KEY, { at: now.toISOString() });
    await putSetting(STATUS_KEY, { at: now.toISOString(), error: null, stats });
    return stats;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await putSetting(STATUS_KEY, { at: now.toISOString(), error: message.slice(0, 500), stats });
    await logAudit({ entityType: 'call', entityId: 'twilio-import', action: 'import_failed', actor: SYSTEM_ACTOR, details: { message: message.slice(0, 500) } }).catch(() => undefined);
    return { ...stats, error: message };
  }
}
