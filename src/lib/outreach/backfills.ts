import { prisma } from '../db';
import { logAudit, SYSTEM_ACTOR } from '../audit';
import { isRoleEmail } from '../sandbox/normalize';
import { optOutPerson } from '../sandbox/opt-out';
import { addSuppressions, suppressionHash, widenedKeys } from '../sandbox/suppression';

/**
 * The cold outreach release's clean-ups that need Cadence's own code (PLAN 9.7); the migrations hold
 * everything plain SQL can do. The worker runs them once, at its first tick after the release, and
 * records the result under COLD_OUTREACH_BACKFILL. Each is idempotent, so a run cut short simply
 * runs again: nothing is ever done twice. Each writes an audit row with what it did and what it left
 * for a person to look at, so nothing changes silently.
 */
export const COLD_OUTREACH_BACKFILL = 'coldOutreachBackfill20261105';

const PAGE = 500;

/**
 * 9.7 step 6: every opt-out made before the release is re-hashed under the wider keys (B001, B002).
 * Every phone of every type, not only direct and mobile: an office, main or unknown line for that
 * one person only (phone_subject), so a shared line never blocks a colleague; and the individual
 * CRD, which follows the person to another firm. A contact whose details were already cleared
 * cannot be re-hashed: those are listed.
 */
export async function widenOptOutSuppressions(): Promise<{ contacts: number; added: number; cleared: string[] }> {
  let contacts = 0;
  let added = 0;
  let after: string | null = null;
  for (;;) {
    const page: Awaited<ReturnType<typeof optedOutPage>> = await optedOutPage(after);
    if (!page.length) break;
    for (const c of page) {
      // A contact opted out after it moved is protected as the CRM person it became.
      const subjectId = c.status === 'MOVED' ? c.twentyPersonId ?? c.id : c.id;
      added += await addSuppressions(widenedKeys(c, subjectId), { reason: 'opted_out', source: c.optOutSource, sandboxContactId: c.id, personId: c.status === 'MOVED' ? c.twentyPersonId : null });
      contacts++;
    }
    after = page[page.length - 1].id;
  }
  const cleared = (await prisma.sandboxContact.findMany({ where: { optedOutAt: { not: null }, piiClearedAt: { not: null } }, select: { id: true }, orderBy: { id: 'asc' }, take: PAGE })).map((c) => c.id);
  if (added || cleared.length) await logAudit({ entityType: 'settings', entityId: 'suppression', action: 'suppression_widened', actor: SYSTEM_ACTOR, details: { contacts, added, detailsAlreadyCleared: cleared } });
  return { contacts, added, cleared };
}

function optedOutPage(after: string | null) {
  return prisma.sandboxContact.findMany({
    where: { optedOutAt: { not: null }, piiClearedAt: null, status: { in: ['OPTED_OUT', 'MOVED'] }, ...(after ? { id: { gt: after } } : {}) },
    orderBy: { id: 'asc' }, take: PAGE,
  });
}

/**
 * B011: the suppression list run again against the CRM copy, comparing emails in lower case. A CRM
 * person whose cached address had capitals was never opted out by a matching entry. Personal
 * addresses only: a match on a shared inbox (info@, sales@) is listed for a person to decide,
 * because several people use it.
 */
export async function rerunSuppressionAgainstCrm(): Promise<{ checked: number; optedOut: string[]; sharedInbox: string[] }> {
  let checked = 0;
  const optedOut: string[] = [];
  const sharedInbox: string[] = [];
  let after: string | null = null;
  for (;;) {
    const page: { id: string; emailNorm: string | null; additionalEmailsNorm: string[] }[] = await prisma.personCache.findMany({
      where: { deletedAt: null, optedOut: false, OR: [{ emailNorm: { not: null } }, { additionalEmailsNorm: { isEmpty: false } }], ...(after ? { id: { gt: after } } : {}) },
      select: { id: true, emailNorm: true, additionalEmailsNorm: true }, orderBy: { id: 'asc' }, take: PAGE,
    });
    if (!page.length) break;
    const emailsOf = (p: (typeof page)[number]) => [p.emailNorm, ...p.additionalEmailsNorm].filter((e): e is string => Boolean(e));
    const hashes = [...new Set(page.flatMap((p) => emailsOf(p).map((e) => suppressionHash('email', e))))];
    const hit = new Set((await prisma.suppression.findMany({ where: { kind: 'email', subjectId: null, valueHash: { in: hashes } }, select: { valueHash: true } })).map((r) => r.valueHash));
    for (const p of page) {
      checked++;
      const matched = emailsOf(p).filter((e) => hit.has(suppressionHash('email', e)));
      if (!matched.length) continue;
      if (matched.every(isRoleEmail)) { sharedInbox.push(p.id); continue; }
      const r = await optOutPerson(p.id, { source: 'suppression_list', actor: SYSTEM_ACTOR, reason: 'Their email is on the suppression list (matched without regard to capitals).' });
      if (r.changed) optedOut.push(p.id);
    }
    after = page[page.length - 1].id;
  }
  if (optedOut.length || sharedInbox.length) await logAudit({ entityType: 'settings', entityId: 'suppression', action: 'suppression_rerun_crm', actor: SYSTEM_ACTOR, details: { checked, optedOut, sharedInbox } });
  return { checked, optedOut, sharedInbox };
}

/** Both, in order: the wider keys first, so the re-run already sees them. */
export async function runColdOutreachBackfill() {
  const widened = await widenOptOutSuppressions();
  const crm = await rerunSuppressionAgainstCrm();
  return { widened: { contacts: widened.contacts, added: widened.added, detailsAlreadyCleared: widened.cleared.length }, crm: { checked: crm.checked, optedOut: crm.optedOut.length, sharedInbox: crm.sharedInbox.length } };
}
