import type { Prisma, SandboxContact } from '@prisma/client';
import { databaseNow, prisma } from '../db';
import { logAudit, SYSTEM_ACTOR, type AuditActor } from '../audit';
import { getTwentyClient, type TwentyClient } from '../twenty';
import { exitEnrollment, OCCUPYING_STATUSES } from '../engine/enrollment';
import { AUTO_SOURCES } from './crm-cleanup';
import { crmMatches, refreshCrmCopyFor, type DedupeInput } from './dedupe';
import { readExtraPhones } from './normalize';

/**
 * The daily check (3 Nov): a push is refused when Twenty has the person, but someone can add them
 * to Twenty afterwards, by hand or by import. Each night every active sandbox contact is matched
 * against Twenty again, by the push's own rule (14.6 rule 4), with Twenty asked directly first.
 * A contact Twenty now has is flagged "Also in CRM" and its outreach stops: a running sandbox
 * campaign ends, its open next action closes, and no sandbox campaign takes it again. Bellwether
 * reads it as already_in_crm. The owner then uses Move to CRM, which attaches the history.
 *
 * A person Twenty's mail or calendar sync created is left to the cleanup (crm-cleanup.ts), which
 * removes it within minutes when nobody worked it; one it kept, because someone did, counts here.
 */

export const EXIT_REASON = 'in_crm';
export const FLAGGED_ACTION = 'sandbox_in_crm';
export const CLEARED_ACTION = 'sandbox_in_crm_cleared';
/** A night has room: Twenty is asked for longer than a push may wait. */
export const LIVE_BUDGET_MS = 15 * 60_000;

export type CrmCheckStats = { checked: number; flagged: number; cleared: number; asked: boolean };

export function dedupeInputOf(c: SandboxContact): DedupeInput {
  return {
    bellwetherContactId: c.bellwetherContactId, firstName: c.firstName, lastName: c.lastName, email: c.email, additionalEmails: c.additionalEmails,
    phone: c.phone, phoneType: c.phoneType ?? 'unknown', additionalPhones: readExtraPhones(c.additionalPhones), linkedinUrl: c.linkedinUrl,
    individualCrd: c.individualCrd, companyName: c.companyName, companyDomain: c.companyDomain, companyCrd: c.companyCrd, companyPhone: c.companyPhone,
  };
}

const isAutoSource = (s: string | null | undefined) => AUTO_SOURCES.includes(String(s ?? '').toUpperCase() as (typeof AUTO_SOURCES)[number]);

/** End the contact's sandbox campaign and close its open next action. */
async function stopOutreach(contactId: string, actor: AuditActor, now: Date): Promise<{ ended: number; closed: number }> {
  const running = await prisma.enrollment.findMany({ where: { sandboxContactId: contactId, personId: null, status: { in: OCCUPYING_STATUSES } }, select: { id: true } });
  for (const e of running) await exitEnrollment(e.id, { reason: EXIT_REASON, actor, now });
  const closed = await prisma.nextAction.updateMany({ where: { sandboxContactId: contactId, personId: null, state: 'OPEN' }, data: { state: 'CANCELLED', closedAt: now } });
  return { ended: running.length, closed: closed.count };
}

export async function checkSandboxAgainstCrm(opts: { now?: Date; client?: TwentyClient | null; budgetMs?: number; actor?: AuditActor } = {}): Promise<CrmCheckStats> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const contacts = await prisma.sandboxContact.findMany({ where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  let client = opts.client;
  if (client === undefined) { try { client = await getTwentyClient(); } catch { client = null; } }
  const asked = Boolean(client && contacts.length && await refreshCrmCopyFor(contacts.map(dedupeInputOf), client, opts.budgetMs ?? LIVE_BUDGET_MS));
  const stats: CrmCheckStats = { checked: contacts.length, flagged: 0, cleared: 0, asked };
  for (const c of contacts) {
    // B156: a person Twenty's mail or calendar sync created is the cleanup's to remove (it flags the
    // ones it keeps on crmAutoPersonId), so the check reads past it to a real CRM person behind it.
    const matches = await crmMatches(dedupeInputOf(c));
    const sources = new Map((await prisma.personCache.findMany({ where: { id: { in: matches.map((m) => m.person.id) } }, select: { id: true, createdBySource: true } })).map((p) => [p.id, p.createdBySource]));
    const match = matches.find((m) => !isAutoSource(sources.get(m.person.id)) || c.crmAutoPersonId === m.person.id) ?? null;
    if (match && c.crmMatchPersonId !== match.person.id) {
      // B062: stamped with the database clock at the write, never the nightly run's start.
      await prisma.sandboxContact.update({ where: { id: c.id }, data: { crmMatchPersonId: match.person.id, crmMatchedOn: match.matchedOn, crmMatchedAt: now, statusChangedAt: await databaseNow() } });
      const stopped = await stopOutreach(c.id, actor, now);
      await logAudit({ entityType: 'sandbox_contact', entityId: c.id, action: FLAGGED_ACTION, actor, details: { personId: match.person.id, matchedOn: match.matchedOn, campaignsEnded: stopped.ended, nextActionsClosed: stopped.closed } });
      stats.flagged++;
    } else if (!match && c.crmMatchPersonId) {
      // The person left Twenty (deleted, merged). The flag goes; stopped outreach is not restarted.
      await prisma.sandboxContact.update({ where: { id: c.id }, data: { crmMatchPersonId: null, crmMatchedOn: null, crmMatchedAt: null, statusChangedAt: await databaseNow() } });
      await logAudit({ entityType: 'sandbox_contact', entityId: c.id, action: CLEARED_ACTION, actor, details: { personId: c.crmMatchPersonId } });
      stats.cleared++;
    }
  }
  return stats;
}

/** The last run, for Settings > Cold outreach (B168): when, who started it, what it found or why it failed. */
export const CRM_CHECK_KEY = 'coldOutreachCrmCheck';
const CRM_CHECK_LEASE = 'coldOutreachCrmCheck.lease';
/** A run that died keeps its lease no longer than its own budget allows, plus the matching after it. */
const CRM_CHECK_LEASE_MS = LIVE_BUDGET_MS + 15 * 60_000;
/** "Run now" waits on the page, so it asks the CRM for a shorter while than the night does. */
export const RUN_NOW_BUDGET_MS = 90_000;
export const CRM_CHECK_RUNNING = 'The CRM check is already running. Its results show here when it ends.';

export type CrmCheckRun = { at: string; finishedAt: string; by: string; stats: CrmCheckStats | null; error: string | null };

/** "Checked 120 contacts: 2 newly found in the CRM, 1 no longer found there." */
export function crmCheckWords(stats: CrmCheckStats): string {
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  const found = [`${n(stats.flagged, 'contact')} newly found in the CRM`, ...(stats.cleared ? [`${stats.cleared} no longer found there`] : [])];
  const unasked = stats.checked && !stats.asked ? " The CRM was not asked: the check used Cadence's copy of it." : '';
  return `Checked ${n(stats.checked, 'contact')}: ${found.join(', ')}.${unasked}`;
}

export async function lastCrmCheck(): Promise<CrmCheckRun | null> {
  const row = await prisma.setting.findUnique({ where: { key: CRM_CHECK_KEY } });
  return (row?.value as unknown as CrmCheckRun | null) ?? null;
}

/**
 * The check as the nightly job and Settings' "Run now" start it: one run at a time (a second one says
 * so), and every run, failed or not, recorded under CRM_CHECK_KEY with who started it.
 */
export async function runCrmCheck(opts: { by: string; now?: Date; actor?: AuditActor; client?: TwentyClient | null; budgetMs?: number }): Promise<{ ran: boolean; busy?: boolean; stats?: CrmCheckStats; error?: string }> {
  const now = opts.now ?? new Date();
  const token = `${now.toISOString()}:${Math.random().toString(36).slice(2)}`;
  const until = new Date(now.getTime() + CRM_CHECK_LEASE_MS).toISOString();
  // One statement takes the lease, so two runs cannot both win (the Twilio import's pattern, B166).
  const won = await prisma.$queryRaw<{ key: string }[]>`
    INSERT INTO "Setting" (key, value, "updatedAt") VALUES (${CRM_CHECK_LEASE}, jsonb_build_object('token', ${token}::text, 'until', ${until}::text), now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()
    WHERE ("Setting".value->>'until') IS NULL OR ("Setting".value->>'until')::timestamptz < ${now}
    RETURNING key`;
  if (!won.length) return { ran: false, busy: true, error: CRM_CHECK_RUNNING };
  const record = async (stats: CrmCheckStats | null, error: string | null) => {
    const run: CrmCheckRun = { at: now.toISOString(), finishedAt: new Date().toISOString(), by: opts.by, stats, error };
    const value = run as unknown as Prisma.InputJsonValue;
    await prisma.setting.upsert({ where: { key: CRM_CHECK_KEY }, create: { key: CRM_CHECK_KEY, value }, update: { value } });
  };
  try {
    const stats = await checkSandboxAgainstCrm({ now, actor: opts.actor, client: opts.client, budgetMs: opts.budgetMs });
    await record(stats, null);
    return { ran: true, stats };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await record(null, error).catch(() => undefined);
    return { ran: true, error };
  } finally {
    await prisma.$executeRaw`DELETE FROM "Setting" WHERE key = ${CRM_CHECK_LEASE} AND value->>'token' = ${token}`.catch(() => undefined);
  }
}
