import type { SandboxContact } from '@prisma/client';
import { prisma } from '../db';
import type { SandboxSettings } from '../settings';
import { personalPhone, readExtraPhones, toE164 } from './normalize';

/**
 * CRM-ready rules (plan 8.1): a contact may move to Twenty only when every required rule passes.
 * Checked live as the contact is edited and shown as "Ready" or as what is missing, in plain words.
 * The checks that need the CRM or the blocked list (a live match, a blocked firm) are added by
 * Move to CRM's preflight.
 */

export type ReadyItem = { key: string; text: string };
export type Readiness = { ready: boolean; missing: ReadyItem[]; warnings: ReadyItem[] };

type ReadyContact = Pick<SandboxContact, 'firstName' | 'lastName' | 'companyName' | 'email' | 'emailVerification' | 'badEmail' | 'phone' | 'phoneType' | 'badPhone' | 'additionalPhones' | 'status' | 'jobTitle' | 'linkedinUrl' | 'city' | 'productInterest' | 'ownerId' | 'podId'>;

const realName = (v: string) => Boolean(v.trim()) && !v.includes('@') && v.trim().toLowerCase() !== 'unknown';

export function hasReachablePhone(c: Pick<SandboxContact, 'phone' | 'phoneType' | 'badPhone' | 'additionalPhones'>): boolean {
  if (c.badPhone) return false;
  if (c.phone && personalPhone(c.phoneType) && toE164(c.phone)) return true;
  return readExtraPhones(c.additionalPhones).some((p) => personalPhone(p.type) && Boolean(toE164(p.number)));
}

export const hasUsableEmail = (c: Pick<SandboxContact, 'email' | 'badEmail' | 'emailVerification'>) => Boolean(c.email) && !c.badEmail && c.emailVerification !== 'invalid';

export function checkReady(c: ReadyContact, ctx: { owner: { twentyMemberId: string | null; name: string; active?: boolean } | null; podName: string | null; settings: SandboxSettings }): Readiness {
  const missing: ReadyItem[] = [];
  const warnings: ReadyItem[] = [];
  if (!realName(c.firstName)) missing.push({ key: 'firstName', text: 'First name' });
  if (!realName(c.lastName)) missing.push({ key: 'lastName', text: 'Last name' });
  if (ctx.settings.requireFirm && !c.companyName?.trim()) missing.push({ key: 'companyName', text: 'Firm' });
  if (ctx.settings.requireEmailOrPhone && !hasUsableEmail(c) && !hasReachablePhone(c)) missing.push({ key: 'email', text: 'An email or a direct or mobile phone' });
  if (!c.ownerId) missing.push({ key: 'owner', text: 'An owner' });
  // N017: an owner whose access was removed counts as missing.
  else if (ctx.owner?.active === false) missing.push({ key: 'owner', text: `${ctx.owner.name} has left: assign a new owner` });
  else if (ctx.settings.requireOwnerLogin && !ctx.owner?.twentyMemberId) missing.push({ key: 'owner', text: `${ctx.owner?.name ?? 'The owner'} has no CRM login` });
  if (ctx.settings.requirePod && !c.podId) missing.push({ key: 'pod', text: 'A pod' });
  if (c.status !== 'ACTIVE') missing.push({ key: 'status', text: c.status === 'OPTED_OUT' ? 'Opted out' : c.status === 'MOVED' ? 'Already moved' : 'Removed' });
  if (!c.jobTitle?.trim()) warnings.push({ key: 'jobTitle', text: 'No job title' });
  if (!c.linkedinUrl) warnings.push({ key: 'linkedinUrl', text: 'No LinkedIn' });
  if (!c.city?.trim()) warnings.push({ key: 'city', text: 'No city' });
  if (c.email && c.emailVerification === 'risky') warnings.push({ key: 'email', text: 'Email is only risky' });
  if (!c.productInterest.length) warnings.push({ key: 'productInterest', text: 'No product interest' });
  return { ready: missing.length === 0, missing, warnings };
}

/** "Ready", or the first missing item and how many more. */
export function readyLabel(r: Readiness): string {
  if (r.ready) return 'Ready';
  return r.missing.length > 1 ? `${r.missing[0].text} +${r.missing.length - 1}` : r.missing[0].text;
}

/** The two signals of "Ready to move" (D3), per contact. */
export type MoveSignal = {
  /** The positive outcome that makes a contact with complete details "Ready to move", in words; null when none. */
  positive: string | null;
  /** "Not interested" or "Wrong number" was the last word, with no next step set since: the contact is Closed. */
  closed: { outcome: string; at: Date | null } | null;
};

const POSITIVE_INTEREST = new Set(['warm', 'hot']);
const CLOSING = new Set(['not_interested', 'wrong_number']);
const CLOSING_WORDS: Record<string, string> = { not_interested: 'Not interested', wrong_number: 'Wrong number' };

/**
 * D3 (owner, 5 Nov): complete details are the hard rule for a move; the green "Ready to move" also
 * needs a positive outcome: Connected with warm or hot interest, Meeting booked, or a reply. After
 * "Not interested" or "Wrong number" the contact is Closed and never Ready, until someone sets a new
 * next step. A few queries for any number of contacts.
 */
export async function moveSignals(contactIds: string[]): Promise<Map<string, MoveSignal>> {
  const out = new Map<string, MoveSignal>();
  if (!contactIds.length) return out;
  const [forms, replies, enrollments, meetings, contacts, nexts] = await Promise.all([
    prisma.callForm.findMany({ where: { call: { sandboxContactId: { in: contactIds } } }, select: { outcome: true, interest: true, submittedAt: true, call: { select: { sandboxContactId: true } } }, orderBy: { submittedAt: 'asc' } }),
    prisma.sandboxEmail.findMany({ where: { sandboxContactId: { in: contactIds }, kind: 'REPLY' }, select: { sandboxContactId: true }, distinct: ['sandboxContactId'] }),
    prisma.enrollment.findMany({ where: { sandboxContactId: { in: contactIds }, status: { in: ['REPLIED', 'MEETING'] } }, select: { sandboxContactId: true, status: true } }),
    prisma.nextAction.findMany({ where: { sandboxContactId: { in: contactIds }, kind: 'MEETING', state: { in: ['OPEN', 'DONE'] } }, select: { sandboxContactId: true } }),
    prisma.sandboxContact.findMany({ where: { id: { in: contactIds } }, select: { id: true, lastOutcome: true, lastOutcomeAt: true } }),
    prisma.nextAction.findMany({ where: { sandboxContactId: { in: contactIds }, personId: null, state: 'OPEN' }, select: { sandboxContactId: true, createdAt: true, updatedAt: true } }),
  ]);
  for (const c of contacts) {
    const mine = forms.filter((f) => f.call.sandboxContactId === c.id);
    const latest = mine[mine.length - 1];
    const lastOutcome = latest?.outcome ?? c.lastOutcome;
    const lastAt = latest?.submittedAt ?? c.lastOutcomeAt;
    const next = nexts.find((n) => n.sandboxContactId === c.id);
    // A next step set after the closing outcome reopens the contact (D3).
    const reopened = Boolean(next && (!lastAt || next.updatedAt > lastAt));
    const closed = lastOutcome && CLOSING.has(lastOutcome) && !reopened ? { outcome: CLOSING_WORDS[lastOutcome] ?? lastOutcome, at: lastAt ?? null } : null;
    let positive: string | null = null;
    if (!closed) {
      if (mine.some((f) => f.outcome === 'meeting_booked') || meetings.some((m) => m.sandboxContactId === c.id) || enrollments.some((e) => e.sandboxContactId === c.id && e.status === 'MEETING')) positive = 'Meeting booked';
      else if (replies.some((r) => r.sandboxContactId === c.id) || enrollments.some((e) => e.sandboxContactId === c.id && e.status === 'REPLIED' && !mine.length)) positive = 'They replied';
      else {
        const warm = [...mine].reverse().find((f) => f.outcome === 'connected' && f.interest && POSITIVE_INTEREST.has(f.interest));
        if (warm) positive = `Connected, ${warm.interest} interest`;
      }
    }
    out.set(c.id, { positive, closed });
  }
  return out;
}
