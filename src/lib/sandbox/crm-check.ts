import type { SandboxContact } from '@prisma/client';
import { prisma } from '../db';
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
      await prisma.sandboxContact.update({ where: { id: c.id }, data: { crmMatchPersonId: match.person.id, crmMatchedOn: match.matchedOn, crmMatchedAt: now, statusChangedAt: now } });
      const stopped = await stopOutreach(c.id, actor, now);
      await logAudit({ entityType: 'sandbox_contact', entityId: c.id, action: FLAGGED_ACTION, actor, details: { personId: match.person.id, matchedOn: match.matchedOn, campaignsEnded: stopped.ended, nextActionsClosed: stopped.closed } });
      stats.flagged++;
    } else if (!match && c.crmMatchPersonId) {
      // The person left Twenty (deleted, merged). The flag goes; stopped outreach is not restarted.
      await prisma.sandboxContact.update({ where: { id: c.id }, data: { crmMatchPersonId: null, crmMatchedOn: null, crmMatchedAt: null, statusChangedAt: now } });
      await logAudit({ entityType: 'sandbox_contact', entityId: c.id, action: CLEARED_ACTION, actor, details: { personId: c.crmMatchPersonId } });
      stats.cleared++;
    }
  }
  return stats;
}
