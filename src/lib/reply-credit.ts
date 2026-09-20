import { toLocalDate } from './dates';
import { workspaceTimezone } from './workspace';
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

/** Credit each reply to the latest sequence that had started when it arrived.
 * Later campaigns must never take credit for historical responses. */
export async function enrollmentByReply(replies: Array<{ id: string; personId: string; occurredAt: Date }>): Promise<Map<string, CreditedEnrollment>> {
  if (!replies.length) return new Map();
  const rows = await prisma.enrollment.findMany({
    where: { personId: { in: [...new Set(replies.map(reply => reply.personId))] } },
    select: { id: true, personId: true, foUserId: true, podId: true, campaignId: true, sequenceId: true, startDate: true },
    orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
  });
  const byPerson = new Map<string, typeof rows>();
  for (const row of rows) { const list = byPerson.get(row.personId) ?? []; list.push(row); byPerson.set(row.personId, list); }
  const by = new Map<string, CreditedEnrollment>();
  for (const reply of replies) {
    const day = toLocalDate(reply.occurredAt, workspaceTimezone());
    const row = byPerson.get(reply.personId)?.find(enrollment => enrollment.startDate <= day);
    if (row) by.set(reply.id, row);
  }
  return by;
}
