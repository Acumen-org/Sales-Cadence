import { prisma } from '../db';
import { coldRef, personRef, subjectHref } from '../subject';
import type { ContactResult } from './bellwether-api';

/*
 * Cold outreach > From Bellwether (PLAN 4.8, B057): every push, newest first, with how many contacts
 * were added, merged into one already here, already in the CRM, refused and left unclaimed, and what
 * became of each contact and why.
 */

export const PUSHES_PAGE = 25;

export type PushContactRow = { key: string; name: string; href: string | null; result: string; tone: 'green' | 'blue' | 'sky' | 'red' | 'amber'; why: string | null };
export type PushRow = {
  id: string; at: Date; by: string; owner: string | null; state: string; count: number;
  added: number; merged: number; inCrm: number; refused: number; unclaimed: number;
  contacts: PushContactRow[];
};

const RESULT_WORDS: Record<ContactResult['result'], { words: string; tone: PushContactRow['tone'] }> = {
  created: { words: 'Added', tone: 'green' },
  duplicate_in_sandbox: { words: 'Already here: empty details filled', tone: 'blue' },
  already_in_crm: { words: 'Already in CRM', tone: 'sky' },
  rejected: { words: 'Refused', tone: 'red' },
};

/** A refusal's code in words, for the pushes that carry no sentence of their own. */
const REASON_WORDS: Record<string, string> = {
  suppressed: 'Asked not to be contacted, or Do not contact',
  internal_contact: 'One of our own team or firm',
  blocked_account: 'Their firm is blocked in Cadence',
  internal_error: 'Cadence failed on this contact; Bellwether can send it again',
  invalid_field: 'A detail Cadence could not read',
  duplicate_in_request: 'Sent twice in the same push',
  do_not_contact: 'Do not contact in the CRM',
  owner_not_found: 'Its owner is not a sales rep in Cadence',
};

export async function listPushes(page: number): Promise<{ rows: PushRow[]; total: number; pages: number; page: number }> {
  const total = await prisma.bellwetherPush.count();
  const pages = Math.max(1, Math.ceil(total / PUSHES_PAGE));
  const p = Math.min(Math.max(1, page), pages);
  const pushes = await prisma.bellwetherPush.findMany({ orderBy: { createdAt: 'desc' }, skip: (p - 1) * PUSHES_PAGE, take: PUSHES_PAGE, include: { items: { orderBy: { createdAt: 'asc' } } } });
  const contactIds = [...new Set(pushes.flatMap((x) => x.items.flatMap((i) => (i.sandboxContactId ? [i.sandboxContactId] : []))))];
  const personIds = [...new Set(pushes.flatMap((x) => x.items.flatMap((i) => (i.crmPersonId ? [i.crmPersonId] : []))))];
  const emails = [...new Set(pushes.map((x) => x.pushedByEmail.toLowerCase()))];
  const ownerIds = [...new Set(pushes.flatMap((x) => (x.ownerId ? [x.ownerId] : [])))];
  const [contacts, people, pushers, owners] = await Promise.all([
    contactIds.length ? prisma.sandboxContact.findMany({ where: { id: { in: contactIds } }, select: { id: true, firstName: true, lastName: true, ownerId: true, status: true } }) : [],
    personIds.length ? prisma.personCache.findMany({ where: { id: { in: personIds } }, select: { id: true, firstName: true, lastName: true } }) : [],
    prisma.user.findMany({ where: { email: { in: emails, mode: 'insensitive' } }, select: { email: true, name: true } }),
    ownerIds.length ? prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } }) : [],
  ]);
  const contactOf = new Map(contacts.map((c) => [c.id, c]));
  const personOf = new Map(people.map((x) => [x.id, `${x.firstName} ${x.lastName}`.trim()]));
  const rows = pushes.map<PushRow>((push) => {
    // The stored answer has each contact's own sentence; it is cleared when the push key expires.
    const answers = new Map(((push.response as { results?: ContactResult[] } | null)?.results ?? []).map((r) => [r.bellwetherContactId, r]));
    const list = push.items.map<PushContactRow>((i) => {
      const result = (i.result in RESULT_WORDS ? i.result : 'rejected') as ContactResult['result'];
      const answer = answers.get(i.bellwetherContactId);
      const contact = i.sandboxContactId ? contactOf.get(i.sandboxContactId) : null;
      const name = contact ? `${contact.firstName} ${contact.lastName}`.trim() || 'Removed contact' : i.crmPersonId && personOf.get(i.crmPersonId) ? personOf.get(i.crmPersonId)! : `Bellwether contact ${i.bellwetherContactId}`;
      const href = contact ? subjectHref(coldRef(contact.id)) : i.crmPersonId ? subjectHref(personRef(i.crmPersonId)) : null;
      const unclaimed = result === 'created' && contact && !contact.ownerId;
      const warn = answer?.warnings?.map((w) => w.detail).filter(Boolean).join(' ') || null;
      return { key: i.id, name, href, result: `${RESULT_WORDS[result].words}${unclaimed ? ', unclaimed' : ''}`, tone: unclaimed ? 'amber' : RESULT_WORDS[result].tone, why: answer?.detail ?? (i.reason ? REASON_WORDS[i.reason] ?? i.reason.replace(/_/g, ' ') : null) ?? warn };
    });
    const n = (r: ContactResult['result']) => push.items.filter((i) => i.result === r).length;
    return {
      id: push.id, at: push.createdAt, by: pushers.find((u) => u.email.toLowerCase() === push.pushedByEmail.toLowerCase())?.name ?? push.pushedByEmail, owner: owners.find((o) => o.id === push.ownerId)?.name ?? null,
      state: push.state, count: push.contactCount, added: n('created'), merged: n('duplicate_in_sandbox'), inCrm: n('already_in_crm'), refused: n('rejected'),
      unclaimed: push.items.filter((i) => i.result === 'created' && i.sandboxContactId && !contactOf.get(i.sandboxContactId)?.ownerId).length, contacts: list,
    };
  });
  return { rows, total, pages, page: p };
}
