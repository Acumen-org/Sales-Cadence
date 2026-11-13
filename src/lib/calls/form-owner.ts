import { prisma } from '../db';
import { ROLES_NEEDING_POD } from '../auth/rbac';
import { canAct, effectiveOwner, loadSubject, type GuardActor } from '../outreach/guard';
import { coldRef } from '../subject';

/**
 * Who a cold contact can be given to from the post-call form (owner, 10 Nov 2026): anyone active in
 * its pod, themselves included, but only as far as the Assign action would let whoever fills the
 * form (audit V01): a Junior FO cannot take a colleague's contact, a Senior FO gives only their own
 * or one in a pod they lead. The form's next step then belongs to the new owner.
 */
export async function formOwnerChoices(contactId: string, guard: GuardActor | null): Promise<{ podId: string | null; choices: { id: string; name: string }[] }> {
  const c = await prisma.sandboxContact.findUnique({ where: { id: contactId }, select: { podId: true } });
  if (!c?.podId || !guard) return { podId: c?.podId ?? null, choices: [] };
  const subject = await loadSubject(coldRef(contactId));
  if (!subject || subject.kind !== 'cold') return { podId: c.podId, choices: [] };
  const users = await prisma.user.findMany({ where: { active: true, role: { in: ROLES_NEEDING_POD }, pods: { some: { podId: c.podId } } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  const owner = effectiveOwner(subject);
  return { podId: c.podId, choices: users.filter((u) => u.id === owner || canAct(guard, subject, 'assign', { toUserId: u.id }).ok) };
}
