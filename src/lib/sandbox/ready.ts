import type { SandboxContact } from '@prisma/client';
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

export function checkReady(c: ReadyContact, ctx: { owner: { twentyMemberId: string | null; name: string } | null; podName: string | null; settings: SandboxSettings }): Readiness {
  const missing: ReadyItem[] = [];
  const warnings: ReadyItem[] = [];
  if (!realName(c.firstName)) missing.push({ key: 'firstName', text: 'First name' });
  if (!realName(c.lastName)) missing.push({ key: 'lastName', text: 'Last name' });
  if (ctx.settings.requireFirm && !c.companyName?.trim()) missing.push({ key: 'companyName', text: 'Firm' });
  if (ctx.settings.requireEmailOrPhone && !hasUsableEmail(c) && !hasReachablePhone(c)) missing.push({ key: 'email', text: 'An email or a direct or mobile phone' });
  if (!c.ownerId) missing.push({ key: 'owner', text: 'An owner' });
  else if (ctx.settings.requireOwnerLogin && !ctx.owner?.twentyMemberId) missing.push({ key: 'owner', text: `${ctx.owner?.name ?? 'The owner'} has no Twenty login` });
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
