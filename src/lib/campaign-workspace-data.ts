import { prisma } from './db';
import { isAdmin, ROLES_NEEDING_POD } from './auth/rbac';
import type { SessionUser } from './auth/current-user';
import { outreachRecipe } from './campaign-starter';

export async function campaignWorkspaceData(user: SessionUser) {
  const pods = await
    prisma.pod.findMany({ where: { archived: false, ...(isAdmin(user) ? {} : { id: { in: user.podIds } }) }, orderBy: { name: 'asc' }, include: { users: { include: { user: true } } } });
  return {
    pods: pods.map(p => ({ id: p.id, name: p.name, podOwnerValue: p.podOwnerValue, fos: p.users.filter(u => u.user.active && ROLES_NEEDING_POD.includes(u.user.role)).map(u => ({ id: u.user.id, name: u.user.name })) })),
    defaultSteps: outreachRecipe(1),
  };
}
