import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { isAdmin } from './auth/rbac';

/**
 * Most-important people. Twenty says who they are (the `MIP` tag); the pod says how much each one
 * matters, as one to three stars kept here and never written back. Nobody is starred until
 * somebody in the person's pod says so, and only that pod - or an admin - can say.
 */
export const MIP_TAG = 'MIP';
export const isMip = (tags: readonly string[]) => tags.some((t) => t.toUpperCase() === MIP_TAG);

export async function mipStarsFor(personIds: string[]): Promise<Map<string, number>> {
  if (!personIds.length) return new Map();
  const rows = await prisma.mipStars.findMany({ where: { personId: { in: personIds } }, select: { personId: true, stars: true } });
  return new Map(rows.map((r) => [r.personId, r.stars]));
}

/** The pods this user may star for: every pod for an admin, their own for everyone else. */
export async function ratablePodOwners(user: SessionUser): Promise<Set<string> | null> {
  if (isAdmin(user)) return null;
  if (!user.podIds.length) return new Set();
  const pods = await prisma.pod.findMany({ where: { id: { in: user.podIds } }, select: { podOwnerValue: true } });
  return new Set(pods.map((p) => p.podOwnerValue));
}

export const canRate = (allowed: Set<string> | null, podOwner: string | null) => allowed === null || (Boolean(podOwner) && allowed.has(podOwner!));

export async function setMipStars(user: SessionUser, personId: string, stars: number): Promise<{ stars: number }> {
  if (!Number.isInteger(stars) || stars < 0 || stars > 3) throw new Error('Stars run from none to three.');
  const person = await prisma.personCache.findUnique({ where: { id: personId }, select: { id: true, podOwner: true, tags: true, deletedAt: true } });
  if (!person || person.deletedAt) throw new Error('This person is not in the directory.');
  if (!isMip(person.tags)) throw new Error('Only someone tagged MIP in Twenty can be starred.');
  if (!canRate(await ratablePodOwners(user), person.podOwner)) throw new Error("Only that pod, or an admin, can star this person.");
  if (stars === 0) { await prisma.mipStars.deleteMany({ where: { personId } }); return { stars: 0 }; }
  await prisma.mipStars.upsert({ where: { personId }, create: { personId, stars, updatedById: user.id }, update: { stars, updatedById: user.id } });
  return { stars };
}
