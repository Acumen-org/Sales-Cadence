import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { Role } from '@prisma/client';
import { prisma } from '../db';
import { mayBeLegacyToken, readSessionToken, rekeySession, storedToken } from './session';
import { ForbiddenError, isAdmin, type Actor } from './rbac';
import { workspaceTimezone } from '../workspace';

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** False until an admin gives someone who joined through Microsoft their title; absent means they have one. */
  roleAssigned?: boolean;
  timezone: string;
  twentyMemberId: string | null;
  dailyCap: number | null;
  podIds: string[];
  pods: { id: string; name: string }[];
};

/** The logged-in user for this request, or null. Memoised per request. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = await readSessionToken();
  if (!token) return null;
  const include = { user: { include: { pods: { where: { pod: { archived: false } }, include: { pod: { select: { id: true, name: true } } } } } } } as const;
  // Q12: rows hold the token's hash; a token from before that is found once and re-keyed.
  let session = await prisma.session.findUnique({ where: { token: storedToken(token) }, include });
  if (!session && mayBeLegacyToken(token)) {
    session = await prisma.session.findUnique({ where: { token }, include });
    if (session) await rekeySession(session.id, token);
    // Another request of the same browser re-keyed it between our two reads: the hash finds it now.
    else session = await prisma.session.findUnique({ where: { token: storedToken(token) }, include });
  }
  if (!session || session.expiresAt < new Date() || !session.user.active) return null;
  const u = session.user;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    roleAssigned: u.roleAssigned,
    timezone: workspaceTimezone(),
    twentyMemberId: u.twentyMemberId,
    dailyCap: u.dailyCap,
    podIds: u.pods.map((p) => p.podId),
    pods: u.pods.map((p) => p.pod),
  };
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (!isAdmin(user)) throw new ForbiddenError('Admin only.');
  return user;
}

export function toActor(user: SessionUser): Actor {
  return { id: user.id, role: user.role, podIds: user.podIds };
}
