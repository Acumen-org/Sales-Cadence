import { env } from '../env';
import { normalizeLinkedin } from '../sandbox/normalize';

/**
 * LinkedIn in Cadence (Notes/linkedin-2026-11-12/PLAN.md). Cadence never acts on LinkedIn (owner, 12 Nov
 * 2026: "we cannot have anything that can cause reason for ban. Not at all allowed"): teammates act by
 * hand in the LinkedIn Console, the Console reports what it saw, and Cadence closes and opens tasks from
 * that. Everything here only reads.
 */

/** linkedin.com/in/<slug> for a profile link or a bare public id; null when neither is a person profile. */
export function profileKeyOf(profileUrl: string | null | undefined, publicId?: string | null): string | null {
  return normalizeLinkedin(profileUrl) ?? (publicId ? normalizeLinkedin(`linkedin.com/in/${publicId}`) : null);
}

/** The public id (the slug) of a profile key. */
export const slugOf = (key: string) => key.replace(/^linkedin\.com\/in\//, '');

/** "Jane van der Berg" as a first and a last name. */
export function splitName(name: string | null | undefined): { firstName: string; lastName: string } {
  const parts = (name ?? '').trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (!parts.length) return { firstName: 'LinkedIn', lastName: 'member' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/** The Console's address, without a trailing slash; null when it is not configured. */
export function consoleUrl(): string | null {
  const url = env().LINKEDIN_CONSOLE_URL?.trim();
  return url ? url.replace(/\/+$/, '') : null;
}

/**
 * Where a teammate does the work, by hand: the Console's Live LinkedIn on the person's profile, from the
 * account the task names (the Console's change C7). Opening it only shows the page; nothing is sent.
 */
export function consoleProfileLink(accountId: string | null | undefined, profileKey: string | null | undefined): string | null {
  const base = consoleUrl();
  if (!base) return null;
  if (accountId && profileKey) return `${base}/accounts/${encodeURIComponent(accountId)}/live?profile=${encodeURIComponent(slugOf(profileKey))}`;
  if (accountId) return `${base}/accounts/${encodeURIComponent(accountId)}/live`;
  // No account used with them yet: the accounts list, where the teammate picks the one to work from.
  return `${base}/accounts`;
}
