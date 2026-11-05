import type { Prisma } from '@prisma/client';

/**
 * Who fills a call's form (N010): the rep who made the call, unless the form was handed to someone
 * else (CallLog.formUserId): the replacement after the rep's access was removed, or a colleague a
 * leader chose. The call itself keeps its rep.
 */
export const formHolderOf = (call: { userId: string | null; formUserId: string | null }) => call.formUserId ?? call.userId;

/** Calls whose form this user must fill and has not: their own, and forms handed to them. */
export const formsHeldBy = (userId: string): Prisma.CallLogWhereInput => ({ formDueAt: { not: null }, formDoneAt: null, discardedAt: null, OR: [{ formUserId: userId }, { formUserId: null, userId }] });
