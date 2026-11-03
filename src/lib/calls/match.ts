import { prisma } from '../db';
import { getSettings } from '../settings';
import { readExtraPhones } from '../sandbox/normalize';

/**
 * Who made a call and who it was with (plan 9.3 and 9.4). The rep: the caller number assigned to
 * them in Twilio (User.callerNumber, confirmed by an admin), then the dialpad's tw_ handle. The
 * other party: an ACTIVE sandbox contact's direct or mobile number, or a CRM person's number.
 */

export type RepMatch = { userId: string | null; by: 'caller_number' | 'alias' | null };
type RepUser = { id: string; callerNumber: string | null; aliases: string[] };

/** The client identity a leg carries, e.g. "tw_alyssa" from "client:tw_alyssa". */
export const identityOf = (...numbers: (string | null | undefined)[]): string | null => {
  for (const n of numbers) if (n && /^client:/i.test(n)) return n.slice('client:'.length).trim().toLowerCase() || null;
  return null;
};

export function matchRep(call: { direction: 'OUTBOUND' | 'INBOUND'; fromNumber: string | null; toNumber: string | null; repIdentity: string | null }, users: RepUser[]): RepMatch {
  const ours = call.direction === 'OUTBOUND' ? call.fromNumber : call.toNumber;
  if (ours) {
    const byNumber = users.find((u) => u.callerNumber && u.callerNumber === ours);
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

/** The other party's number against sandbox contacts (direct and mobile only) and CRM people. */
export async function matchContact(number: string | null, repUserId: string | null): Promise<ContactMatch> {
  if (!number || !number.startsWith('+')) return { matchedBy: 'none' };
  const { rules } = await getSettings();
  const sandbox = (await prisma.sandboxContact.findMany({
    where: { status: 'ACTIVE', OR: [{ phone: number }, { additionalPhones: { array_contains: [{ number }] } }] },
    select: { id: true, firstName: true, lastName: true, phone: true, phoneType: true, additionalPhones: true },
    take: 20,
  })).filter((c) => (c.phone === number && (c.phoneType === 'direct' || c.phoneType === 'mobile')) || readExtraPhones(c.additionalPhones).some((p) => p.number === number && (p.type === 'direct' || p.type === 'mobile')));
  const people = (await prisma.personCache.findMany({ where: { deletedAt: null, OR: [{ phoneE164: number }, { additionalPhoneE164: number }] }, select: { id: true, firstName: true, lastName: true, email: true }, take: 20 }))
    .filter((p) => !p.email || !rules.internalDomains.some((d) => p.email!.toLowerCase().endsWith(`@${d}`)));
  const candidates = [
    ...sandbox.map((c) => ({ kind: 'sandbox' as const, id: c.id, name: `${c.firstName} ${c.lastName}`.trim() })),
    ...people.map((p) => ({ kind: 'person' as const, id: p.id, name: `${p.firstName} ${p.lastName}`.trim() })),
  ];
  if (!candidates.length) return { matchedBy: 'none' };
  const pick = (c: (typeof candidates)[number]): ContactMatch => ({ matchedBy: 'number', personId: c.kind === 'person' ? c.id : null, sandboxContactId: c.kind === 'sandbox' ? c.id : null });
  if (candidates.length === 1) return pick(candidates[0]);
  // A shared line: the contact whose open step or next action belongs to the caller decides.
  if (repUserId) {
    const mine: typeof candidates = [];
    for (const c of candidates) {
      const subject = c.kind === 'person' ? { personId: c.id } : { sandboxContactId: c.id, personId: null };
      const open = (await prisma.task.count({ where: { foUserId: repUserId, state: 'PENDING', enrollment: subject } })) + (await prisma.nextAction.count({ where: { foUserId: repUserId, state: 'OPEN', ...subject } }));
      if (open) mine.push(c);
    }
    if (mine.length === 1) return pick(mine[0]);
  }
  return { matchedBy: 'ambiguous', candidates };
}
