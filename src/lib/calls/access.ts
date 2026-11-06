import { canViewCalls, type Actor } from '../auth/rbac';
import { prisma } from '../db';

/**
 * Who may see what a call holds (N051): its notes, the numbers, the cost and the recording. The rep
 * who made it (or holds its form), the contact's owner, and those who see Reports. Everyone else sees
 * that the call happened and its outcome. One rule for the recording, the call page and the timelines.
 */
export function mayHearCall(actor: Actor, call: { userId: string | null; formUserId?: string | null; ownerId?: string | null }): boolean {
  return canViewCalls(actor) || call.userId === actor.id || call.formUserId === actor.id || (Boolean(call.ownerId) && call.ownerId === actor.id);
}

export const HIDDEN_CALL = 'Only the rep, the contact\'s owner and those who see Reports can see this call\'s notes, numbers and recording.';

/** The owner a call's subject has: a cold contact's owner, or the Cadence user behind a CRM person's owner. */
export async function callOwnerId(call: { personId: string | null; sandboxContactId: string | null }): Promise<string | null> {
  if (call.sandboxContactId && !call.personId) return (await prisma.sandboxContact.findUnique({ where: { id: call.sandboxContactId }, select: { ownerId: true } }))?.ownerId ?? null;
  if (!call.personId) return null;
  const p = await prisma.personCache.findUnique({ where: { id: call.personId }, select: { ownerMemberId: true } });
  return p?.ownerMemberId ? (await prisma.user.findFirst({ where: { twentyMemberId: p.ownerMemberId }, select: { id: true } }))?.id ?? null : null;
}
