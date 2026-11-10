import { prisma } from '../db';
import { ROLES_NEEDING_POD } from '../auth/rbac';

/**
 * Who a cold contact can be given to from the post-call form (owner, 10 Nov 2026): whoever fills the
 * form, the owner or not, may hand the contact to anyone active in its pod, themselves included. The
 * form's next step then belongs to the new owner.
 */
export async function formOwnerChoices(contactId: string): Promise<{ podId: string | null; choices: { id: string; name: string }[] }> {
  const c = await prisma.sandboxContact.findUnique({ where: { id: contactId }, select: { podId: true } });
  if (!c?.podId) return { podId: null, choices: [] };
  const users = await prisma.user.findMany({ where: { active: true, role: { in: ROLES_NEEDING_POD }, pods: { some: { podId: c.podId } } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  return { podId: c.podId, choices: users };
}
