import type { Prisma } from '@prisma/client';
import { prisma } from './db';

/** The summary a logged call takes when the person answered: the one outbound touch that is a reply. */
export const ANSWERED_CALL_PREFIX = 'Answered call:';

/**
 * A reply is a response from the person: a message that came in - an inbound email, call or
 * LinkedIn touch, machine answers (out-of-office, bounces, receipts, stored as `Auto-reply:`)
 * left out - or a call we made that they answered. This is the one place that says so, for Home,
 * Reports and the Accounts directory alike; the Accounts list repeats it in SQL.
 */
export const REPLY_TOUCH_WHERE: Prisma.TouchWhereInput = {
  OR: [
    { direction: 'INBOUND', channel: { in: ['EMAIL', 'CALL', 'LINKEDIN'] }, NOT: { summary: { startsWith: 'Auto-reply:' } } },
    { channel: 'CALL', summary: { startsWith: ANSWERED_CALL_PREFIX } },
  ],
};

/** What a reply is credited to: the person's most recent enrollment, with what Reports groups by. */
export type CreditedEnrollment = { id: string; foUserId: string; podId: string | null; campaignId: string | null; sequenceId: string };

/**
 * The enrollment a person's reply is credited to: their most recent one - the one whose outreach
 * the reply answers. One query for the whole page, never one per row. A person nobody has ever
 * enrolled has no entry; callers fall back to the FO who owns them in Twenty.
 */
export async function enrollmentByPerson(personIds: string[]): Promise<Map<string, CreditedEnrollment>> {
  if (!personIds.length) return new Map();
  const rows = await prisma.enrollment.findMany({
    where: { personId: { in: [...new Set(personIds)] } },
    select: { id: true, personId: true, foUserId: true, podId: true, campaignId: true, sequenceId: true, startDate: true },
    orderBy: { startDate: 'desc' },
  });
  const by = new Map<string, CreditedEnrollment>();
  for (const r of rows) if (!by.has(r.personId)) by.set(r.personId, { id: r.id, foUserId: r.foUserId, podId: r.podId, campaignId: r.campaignId, sequenceId: r.sequenceId });
  return by;
}

/** Who a person's reply is credited to: the FO of the credited enrollment. */
export async function enrollmentFoByPerson(personIds: string[]): Promise<Map<string, string>> {
  const by = await enrollmentByPerson(personIds);
  return new Map([...by.entries()].map(([personId, e]) => [personId, e.foUserId]));
}
