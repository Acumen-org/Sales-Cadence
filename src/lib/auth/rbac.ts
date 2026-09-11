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

/** Reduce any user-like object (SessionUser, Prisma User + pods) to an Actor. */
export function toActor(user: { id: string; role: Role; podIds: string[] }): Actor {
  return { id: user.id, role: user.role, podIds: user.podIds };
}

export const isAdmin = (a: Actor) => a.role === 'ADMIN';
export const isSeniorFo = (a: Actor) => a.role === 'SENIOR_FO';
export const isSalesLeader = (a: Actor) => a.role === 'SALES_LEADER';
export const isPodManager = (a: Actor) => a.role === 'POD_MANAGER';
export const isJuniorFo = (a: Actor) => a.role === 'JUNIOR_FO';
export const isBizOps = (a: Actor) => a.role === 'BIZ_OPS';
/** Leads pods: every pod-level write in their own pods. */
export const isPodLeader = (a: Actor) => isSeniorFo(a) || isSalesLeader(a) || isPodManager(a);
/** Reads every pod. Admins write too; Biz Ops only look. Reading is never the same test as writing. */
export const canSeeAllPods = (a: Actor) => isAdmin(a) || isBizOps(a);
/** Roles that do or run sales work, and so belong to at least one pod. */
export const ROLES_NEEDING_POD: Role[] = ['JUNIOR_FO', 'SENIOR_FO', 'SALES_LEADER', 'POD_MANAGER'];
export const needsPod = (role: Role) => ROLES_NEEDING_POD.includes(role);

/** Admin: every pod. Pod leaders: own pods. Everyone else: none. */
export function canManagePod(a: Actor, podId: string | null | undefined): boolean {
  if (isAdmin(a)) return true;
  if (isPodLeader(a) && podId) return a.podIds.includes(podId);
  return false;
}

/** Pods whose reports and task lists this user may browse. Null = all pods. */
export function visiblePodIds(a: Actor): string[] | null {
  if (canSeeAllPods(a)) return null;
  return a.podIds;
}

/**
 * What a section shows before any filter is touched. A junior opens their pod and their own
 * name; anyone who leads a pod opens the pod; admins and Biz Ops open everything.
 */
export function defaultFilters(a: Actor): { pod: boolean; self: boolean } {
  if (isJuniorFo(a)) return { pod: true, self: true };
  if (isPodLeader(a)) return { pod: true, self: false };
  return { pod: false, self: false };
}

export function canEnroll(a: Actor, podId?: string | null): boolean {
  if (isAdmin(a)) return true;
  if (!isPodLeader(a)) return false;
  return podId ? a.podIds.includes(podId) : a.podIds.length > 0;
}

export function canManageEnrollment(a: Actor, e: { foUserId: string; podId: string | null }): boolean {
  if (isAdmin(a)) return true;
  if (isPodLeader(a)) return (e.podId ? a.podIds.includes(e.podId) : false) || e.foUserId === a.id;
  return false;
}

/** Junior FOs may only work their own tasks; Seniors also tasks in their pods. */
export function canActOnTask(a: Actor, t: { foUserId: string; podId: string | null }): boolean {
  if (t.foUserId === a.id) return true;
  if (isAdmin(a)) return true;
  if (isPodLeader(a) && t.podId) return a.podIds.includes(t.podId);
  return false;
}

export function canViewTasksOf(a: Actor, foUserId: string, podId: string | null): boolean {
  return canActOnTask(a, { foUserId, podId });
}

export const canEditSequences = (a: Actor) => isAdmin(a) || isPodLeader(a);
export const canManageSettings = (a: Actor) => isAdmin(a);
export const canManageUsers = (a: Actor) => isAdmin(a);
export const canManageCampaigns = (a: Actor, podId?: string | null) => canEnroll(a, podId);
export const canViewReports = (a: Actor) => canSeeAllPods(a) || isPodLeader(a);
export const canApproveCampaign = (a: Actor, podId: string | null) => isAdmin(a) || ((isSalesLeader(a) || isPodManager(a)) && canManagePod(a, podId));

/** Junior FOs may snooze only to the next working day; others may pick a date. */
export const canSnoozeFreely = (a: Actor) => !isJuniorFo(a);

export function assertAllowed(condition: boolean, message?: string): asserts condition {
  if (!condition) throw new ForbiddenError(message);
}

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Admin',
  SALES_LEADER: 'Sales Leader',
  POD_MANAGER: 'Pod Manager',
  SENIOR_FO: 'Senior FO',
  JUNIOR_FO: 'Junior FO',
  BIZ_OPS: 'Biz Ops',
};
