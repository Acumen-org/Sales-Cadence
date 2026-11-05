import { prisma } from '../db';
import { getSettings } from '../settings';
import { readExtraPhones } from '../sandbox/normalize';

/**
 * Who made a call and who it was with (plan 9.3 and 9.4, cold outreach PLAN 8.7). The rep: the caller
 * number assigned to them in Twilio (User.callerNumber, confirmed by an admin) from the moment it was
 * assigned (B165), then the dialpad's tw_ handle. The other party: whoever holds the number, of any
 * type and any status (B029, B030): one live contact or CRM person matches; with none live, one opted-out
 * or removed contact matches and the form says so; a firm's main line always asks who it was (B018).
 */

export type RepMatch = { userId: string | null; by: 'caller_number' | 'alias' | null };
type RepUser = { id: string; callerNumber: string | null; callerNumberSince?: Date | null; aliases: string[] };

/** The client identity a leg carries, e.g. "tw_alyssa" from "client:tw_alyssa". */
export const identityOf = (...numbers: (string | null | undefined)[]): string | null => {
  for (const n of numbers) if (n && /^client:/i.test(n)) return n.slice('client:'.length).trim().toLowerCase() || null;
  return null;
};

export function matchRep(call: { direction: 'OUTBOUND' | 'INBOUND'; fromNumber: string | null; toNumber: string | null; repIdentity: string | null; startedAt?: Date | null }, users: RepUser[]): RepMatch {
  const ours = call.direction === 'OUTBOUND' ? call.fromNumber : call.toNumber;
  if (ours) {
    // B165: a number counts for its rep only from when it was assigned to them.
    const byNumber = users.find((u) => u.callerNumber && u.callerNumber === ours && (!u.callerNumberSince || !call.startedAt || call.startedAt >= u.callerNumberSince));
    if (byNumber) return { userId: byNumber.id, by: 'caller_number' };
  }
  if (call.repIdentity) {
    const handle = call.repIdentity.toLowerCase();
    const byAlias = users.find((u) => u.aliases.some((a) => a.trim().toLowerCase() === handle));
    if (byAlias) return { userId: byAlias.id, by: 'alias' };
  }
  return { userId: null, by: null };
}

export type ContactMatch =
  | { matchedBy: 'number'; personId: string | null; sandboxContactId: string | null }
  | { matchedBy: 'ambiguous'; candidates: { kind: 'person' | 'sandbox'; id: string; name: string }[] }
  | { matchedBy: 'none' };

/** Lines a whole firm shares: a call to one never pins a person (B018). */
const FIRM_LINES = new Set(['main', 'toll_free']);

/** The other party's number against cold contacts (any type, any status but moved) and CRM people. */
export async function matchContact(number: string | null, repUserId: string | null): Promise<ContactMatch> {
  if (!number || !number.startsWith('+')) return { matchedBy: 'none' };
  const { rules } = await getSettings();
  // A moved contact is its CRM person now, who is matched below.
  const coldRows = await prisma.sandboxContact.findMany({
    where: { status: { not: 'MOVED' }, OR: [{ phone: number }, { additionalPhones: { array_contains: [{ number }] } }, { companyPhone: number }] },
    select: { id: true, firstName: true, lastName: true, status: true, phone: true, phoneType: true, additionalPhones: true, companyPhone: true },
    take: 20,
  });
  const cold = coldRows.map((c) => {
    const types = [...(c.phone === number ? [c.phoneType ?? 'unknown'] : []), ...readExtraPhones(c.additionalPhones).filter((p) => p.number === number).map((p) => p.type), ...(c.companyPhone === number ? ['main'] : [])];
    return { kind: 'sandbox' as const, id: c.id, name: `${c.firstName} ${c.lastName}`.trim() || 'Removed contact', live: c.status === 'ACTIVE', firmLine: types.some((t) => FIRM_LINES.has(t)), mine: false };
  });
  const people = (await prisma.personCache.findMany({ where: { deletedAt: null, OR: [{ phoneE164: number }, { additionalPhoneE164: number }] }, select: { id: true, firstName: true, lastName: true, email: true }, take: 20 }))
    .filter((p) => !p.email || !rules.internalDomains.some((d) => p.email!.toLowerCase().endsWith(`@${d}`)))
    .map((p) => ({ kind: 'person' as const, id: p.id, name: `${p.firstName} ${p.lastName}`.trim(), live: true, firmLine: false, mine: false }));
  const all = [...cold, ...people];
  if (!all.length) return { matchedBy: 'none' };
  const asCandidates = (list: typeof all) => list.map((c) => ({ kind: c.kind, id: c.id, name: c.name }));
  const pick = (c: (typeof all)[number]): ContactMatch => ({ matchedBy: 'number', personId: c.kind === 'person' ? c.id : null, sandboxContactId: c.kind === 'sandbox' ? c.id : null });
  // B018: a firm's main line is never pinned to one person, even when one person is known on it.
  if (all.some((c) => c.firmLine)) return { matchedBy: 'ambiguous', candidates: asCandidates(all) };
  // B029, B030: live people first; a number only an opted-out or removed contact holds still matches it.
  const pool = all.some((c) => c.live) ? all.filter((c) => c.live) : all;
  if (pool.length === 1) return pick(pool[0]);
  // A shared line: the contact whose open step or next action belongs to the caller decides.
  if (repUserId) {
    const mine: typeof pool = [];
    for (const c of pool) {
      const subject = c.kind === 'person' ? { personId: c.id } : { sandboxContactId: c.id, personId: null };
      const open = (await prisma.task.count({ where: { foUserId: repUserId, state: 'PENDING', enrollment: subject } })) + (await prisma.nextAction.count({ where: { foUserId: repUserId, state: 'OPEN', ...subject } }));
      if (open) mine.push(c);
    }
    if (mine.length === 1) return pick(mine[0]);
  }
  return { matchedBy: 'ambiguous', candidates: asCandidates(pool) };
}
