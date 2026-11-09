/**
 * Meetings are counted from 1 October 2026 (owner, 9 Nov 2026): a prospect's first meeting on or
 * after that day is their 1st, and meetings before it carry no number and count towards nothing.
 * Kept apart from numbering.ts so the meeting form (a client component) can read it.
 */
export const NUMBERING_STARTS = '2026-10-01';
export const NUMBERING_STARTS_WORDS = 'Oct 2026';

/** Whether a meeting on this day (YYYY-MM-DD, the workspace's date) is counted. */
export const isCountedDay = (day: string) => day >= NUMBERING_STARTS;
