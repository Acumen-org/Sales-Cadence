import type { MeetingApproval, Prisma } from '@prisma/client';

/**
 * Which meetings are numbered and written to the CRM (owner, 21 Nov 2026: "they get counted in the
 * CRM only when they are approved"). A meeting removed from the calendar or declined never is; one
 * with no recording link waiting for its Sales Leader is not yet. It still shows in Cadence's lists,
 * with its badge, and gets its number and its CRM record when it is approved or its link is added.
 */
export const isCounted = (m: { review: string; approval: MeetingApproval | null }) => m.review === 'APPROVED' && m.approval !== 'WAITING';

/** The same, as a where clause (a plain `not: 'WAITING'` would drop meetings with no approval). */
export const COUNTED_WHERE: Prisma.MeetingWhereInput = { review: 'APPROVED', OR: [{ approval: null }, { approval: { not: 'WAITING' } }] };
