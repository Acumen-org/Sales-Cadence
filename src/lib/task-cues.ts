import { isWorkingDay, nextWorkingDay } from './engine/clock';
import { isLocalDate, type LocalDate } from './dates';

/*
 * The small cues a task carries (cold outreach PLAN 4.3), as plain words a test can read: the same
 * for a CRM person and a cold contact, so both lists say the same thing the same way.
 */

const dayWords = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
/** "Mon 9 Nov". */
export const shortDay = (date: LocalDate) => dayWords.format(new Date(`${date}T12:00:00Z`)).replace(',', '');

/**
 * A date that is not a working day (N103): what to say under the date, and the working day it could
 * move to. Null for a working day, or for a date not filled in yet.
 */
export function workingDayHint(date: string | null | undefined, workingDays: number[]): { words: string; moveTo: LocalDate } | null {
  if (!date || !isLocalDate(date) || !workingDays.length || isWorkingDay(date, workingDays)) return null;
  const moveTo = nextWorkingDay(date, workingDays);
  return { words: `${shortDay(date)} is not a working day.`, moveTo };
}

/**
 * Why Done is off for one module (N056, N077): an email step with no email address, or a LinkedIn
 * step with no profile, has nothing to send to. The rep adds the detail or skips the step.
 */
export function channelBlock(action: string, who: { firstName: string | null; email: string | null; linkedinUrl: string | null }): string | null {
  const name = who.firstName?.trim() || 'this person';
  if (action === 'EMAIL' && !who.email) return `No email for ${name}: add one or skip this step.`;
  if ((action === 'LINKEDIN_CONNECT' || action === 'LINKEDIN_MESSAGE') && !who.linkedinUrl) return `No LinkedIn profile for ${name}: add one or skip this step.`;
  return null;
}

/** What "Asked not to be contacted" does, asked before it is done (B059, N042). Null for any other reason. */
export function optOutConfirm(exit: string | null | undefined, name: string): { title: string; effects: string[]; confirmLabel: string; tone: 'danger' } | null {
  if (exit !== 'opted_out') return null;
  return {
    title: `${name} asked not to be contacted?`,
    effects: [`${name} is opted out for good: Cadence never calls, emails or messages them again.`, 'This sequence ends as Opted out.', 'Their other open steps and next steps are cancelled.'],
    confirmLabel: 'Opt out',
    tone: 'danger',
  };
}

/** Accessible names that say which contact a control is for (N105): "Done: Email 1 for Jane Doe". */
export const rowControlLabel = (verb: string, step: string, name: string) => `${verb}: ${step} for ${name}`;

/** B197: a task's own label, unless it only repeats what its action says ("Email · Email"). */
export const labelBeyond = (label: string | null | undefined, actionWords: string): string | null => (label?.trim() && label.trim().toLowerCase() !== actionWords.trim().toLowerCase() ? label.trim() : null);

/** What a Home "Up next" row says after its action: the campaign, or a task's own label when it adds something, then the firm or the rep (B197). */
export function upNextWords(t: { kind: 'step' | 'task'; campaign: string | null; company: string | null; fo: string | null }, actionWords: string, forTeam: boolean): string {
  const what = t.kind === 'task' ? labelBeyond(t.campaign, actionWords) : t.campaign ?? 'No campaign';
  return [what, forTeam && t.fo ? t.fo : t.company].filter(Boolean).join(' · ');
}
