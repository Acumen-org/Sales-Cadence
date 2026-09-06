import type { Role } from '@prisma/client';

/** The minimum we need to know about the acting user to make a permission decision. */
export type Actor = {
  id: string;
  role: Role;
  podIds: string[];
};

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = 'You do not have permission to do that.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export const isAdmin = (a: Actor) => a.role === 'ADMIN';
export const isSeniorFo = (a: Actor) => a.role === 'SENIOR_FO';
export const isJuniorFo = (a: Actor) => a.role === 'JUNIOR_FO';

/** Admin: every pod. Senior FO: own pods. Junior FO: none (they see their own tasks only). */
export function canManagePod(a: Actor, podId: string | null | undefined): boolean {
  if (isAdmin(a)) return true;
  if (isSeniorFo(a) && podId) return a.podIds.includes(podId);
  return false;
}

/** Pods whose reports and task lists this user may browse. Null = all pods. */
export function visiblePodIds(a: Actor): string[] | null {
  if (isAdmin(a)) return null;
  return a.podIds;
}

export function canEnroll(a: Actor, podId?: string | null): boolean {
  if (isAdmin(a)) return true;
  if (!isSeniorFo(a)) return false;
  return podId ? a.podIds.includes(podId) : a.podIds.length > 0;
}

export function canManageEnrollment(a: Actor, e: { foUserId: string; podId: string | null }): boolean {
  if (isAdmin(a)) return true;
  if (isSeniorFo(a)) return (e.podId ? a.podIds.includes(e.podId) : false) || e.foUserId === a.id;
  return false;
}

/** Junior FOs may only work their own tasks; Seniors also tasks in their pods. */
export function canActOnTask(a: Actor, t: { foUserId: string; podId: string | null }): boolean {
  if (t.foUserId === a.id) return true;
  if (isAdmin(a)) return true;
  if (isSeniorFo(a) && t.podId) return a.podIds.includes(t.podId);
  return false;
}

export function canViewTasksOf(a: Actor, foUserId: string, podId: string | null): boolean {
  return canActOnTask(a, { foUserId, podId });
}

export const canEditSequences = (a: Actor) => isAdmin(a);
export const canManageSettings = (a: Actor) => isAdmin(a);
export const canManageUsers = (a: Actor) => isAdmin(a);
export const canManageCampaigns = (a: Actor, podId?: string | null) => canEnroll(a, podId);
export const canViewReports = (a: Actor) => isAdmin(a) || isSeniorFo(a);

/** Junior FOs may snooze only to the next working day; others may pick a date. */
export const canSnoozeFreely = (a: Actor) => !isJuniorFo(a);

export function assertAllowed(condition: boolean, message?: string): asserts condition {
  if (!condition) throw new ForbiddenError(message);
}

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Admin',
  SENIOR_FO: 'Senior FO',
  JUNIOR_FO: 'Junior FO',
};
