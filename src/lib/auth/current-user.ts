import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { Role } from '@prisma/client';
import { prisma } from '../db';
import { readSessionToken } from './session';
import { ForbiddenError, isAdmin, type Actor } from './rbac';
import { WORKSPACE_TIMEZONE } from '../workspace';

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
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
  const session = await prisma.session.findUnique({
    where: { token },
    include: { user: { include: { pods: { where: { pod: { archived: false } }, include: { pod: { select: { id: true, name: true } } } } } } },
  });
  if (!session || session.expiresAt < new Date() || !session.user.active) return null;
  const u = session.user;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    timezone: WORKSPACE_TIMEZONE,
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
