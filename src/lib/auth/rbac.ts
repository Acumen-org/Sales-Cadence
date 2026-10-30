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
/** Checks the meeting numbers people doubt, sets one when it is wrong, and closes the check. */
export const canCheckMeetingNumbers = (a: Actor) => isBizOps(a) || a.role === 'ADMIN';
/** Leads pods: every pod-level write in their own pods. */
export const isPodLeader = (a: Actor) => isSeniorFo(a) || isSalesLeader(a) || isPodManager(a);
/**
 * Everyone reads every pod. The owner's rule (12 September 2026): an FO in Alisa's pod opens each
 * section with Alisa's pod and their own name already selected, and may clear both and see all of
 * it. Reading was never the same test as writing, and the write gates below still ask who leads
 * which pod. Biz Ops is the role that only reads.
 */
export const canSeeAllPods = (_a: Actor) => true;
/** Roles that do or run sales work, and so belong to at least one pod. */
export const ROLES_NEEDING_POD: Role[] = ['JUNIOR_FO', 'SENIOR_FO', 'SALES_LEADER', 'POD_MANAGER'];
export const needsPod = (role: Role) => ROLES_NEEDING_POD.includes(role);

/** Admin: every pod. Pod leaders: own pods. Everyone else: none. */
export function canManagePod(a: Actor, podId: string | null | undefined): boolean {
  if (isAdmin(a)) return true;
  if (isPodLeader(a) && podId) return a.podIds.includes(podId);
  return false;
}

/**
 * Who may put people into a campaign or take them out (owner, 24 September 2026): the FOs working
 * that campaign, the Sales Leader and Pod Manager of its pod, and admins. Biz Ops reads; a Senior
 * FO who is not on the campaign does not move its people.
 */
export function canChangeCampaignPeople(a: Actor, c: { podId: string | null | undefined; foIds: readonly string[]; /** A campaign from before the studio that has not run has no team of its own: everyone who works its pod, as it always was. */ podWide?: boolean }): boolean {
  if (isAdmin(a)) return true;
  if ((isSalesLeader(a) || isPodManager(a)) && c.podId && a.podIds.includes(c.podId)) return true;
  if (c.podWide) return needsPod(a.role) && !!c.podId && a.podIds.includes(c.podId);
  return needsPod(a.role) && c.foIds.includes(a.id);
}
/** Whether this reader might change some campaign's people at all, for showing the controls. */
export const mayChangeCampaignPeople = (a: Actor) => isAdmin(a) || needsPod(a.role);

/** Pods whose reports and task lists this user may browse. Null = all pods, which is everyone now. */
export function visiblePodIds(_a: Actor): string[] | null {
  return null;
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
  if (isBizOps(a)) return false;
  if (t.foUserId === a.id) return true;
  if (isAdmin(a)) return true;
  if (isPodLeader(a) && t.podId) return a.podIds.includes(t.podId);
  return false;
}

export function canViewTasksOf(a: Actor, foUserId: string, podId: string | null): boolean {
  return canActOnTask(a, { foUserId, podId });
}

export const canEditSequences = (a: Actor) => isAdmin(a) || isPodLeader(a);
export const canCreateMeeting = (a: Actor) => !isBizOps(a);
export const canManageSettings = (a: Actor) => isAdmin(a);
export const canManageUsers = (a: Actor) => isAdmin(a);
export const canManageCampaigns = (a: Actor, podId?: string | null) => canEnroll(a, podId);
/**
 * Who may start a campaign (owner, 15 October 2026): anyone who works in a pod, for the pods they
 * are in, and admins for any pod. Biz Ops reads. Running it stays with canManageCampaigns.
 */
export function canCreateCampaign(a: Actor, podId?: string | null): boolean {
  if (isAdmin(a)) return true;
  if (!needsPod(a.role)) return false;
  return podId ? a.podIds.includes(podId) : a.podIds.length > 0;
}
/** Who may change a campaign's plan before it starts: the pod's campaign managers, and whoever created it. */
export function canEditCampaign(a: Actor, c: { podId: string | null; createdById: string | null }): boolean {
  return canManageCampaigns(a, c.podId) || (!!c.createdById && c.createdById === a.id && canCreateCampaign(a, c.podId));
}
/**
 * Who may put contacts from any pod in a campaign's audience (owner, 15 October 2026): Pod
 * Managers, and admins. Everyone else picks from the campaign's pod. A contact owned by an FO who
 * cannot work this pod's campaign stays out whoever picks them.
 */
export const canAddFromAnyPod = (a: Actor) => isAdmin(a) || isPodManager(a);
/** Reports stay with the roles that run pods and the ones that oversee them. */
export const canViewReports = (a: Actor) => isAdmin(a) || isBizOps(a) || isPodLeader(a);
/**
 * Who may erase a campaign. The pod's campaign managers, and whoever created it, may delete a
 * draft (or one waiting for approval) that never put anyone in outreach; an admin may also erase
 * one that was stopped or finished. A published or running campaign is stopped first; history is
 * an admin's call.
 */
export function canDeleteCampaign(a: Actor, c: { status: string; podId: string | null; createdById: string | null; everLaunched: boolean }): boolean {
  if (isAdmin(a)) return ['DRAFT', 'PENDING_APPROVAL', 'STOPPED', 'COMPLETED'].includes(c.status);
  return canEditCampaign(a, c) && ['DRAFT', 'PENDING_APPROVAL'].includes(c.status) && !c.everLaunched;
}
export const canApproveCampaign = (a: Actor, podId: string | null) => isAdmin(a) || ((isSalesLeader(a) || isPodManager(a)) && canManagePod(a, podId));

/** Junior FOs may snooze only to the next working day; others may pick a date. */
export const canSnoozeFreely = (a: Actor) => !isJuniorFo(a);

/*
 * Refusals in words (owner, 15 October 2026: "state clearly"). Each says why this person cannot do
 * this, and who can, so nobody has to guess. Null when they can. "Pod leader" is spelled out
 * everywhere because nobody outside this file knows the term.
 */
const leadersOf = (pod: string) => `the Senior FOs, Sales Leaders and Pod Managers of ${pod}`;
const bizOpsReads = (what: string) => `Biz Ops can view ${what} but cannot change them.`;

export function whyNotCreateCampaign(a: Actor, pod?: { id: string; name: string } | null): string | null {
  if (canCreateCampaign(a, pod?.id)) return null;
  if (isBizOps(a)) return 'Biz Ops can view campaigns but cannot create them.';
  if (!a.podIds.length) return 'You are not in a pod yet, so you cannot create campaigns. Ask an admin to add you to one.';
  return `You are not in ${pod?.name ?? 'this pod'}, so you cannot create campaigns for it. You can create them only for the pods you are in.`;
}

export function whyNotEditCampaign(a: Actor, c: { podId: string | null; createdById: string | null }, podName: string, creatorName?: string | null): string | null {
  if (canEditCampaign(a, c)) return null;
  if (isBizOps(a)) return bizOpsReads('campaigns');
  if (c.createdById === a.id) return `You created this campaign, but you are no longer in ${podName}, so only ${leadersOf(podName)}, and admins, can change it.`;
  return `Only ${creatorName ? `${creatorName}, who created this campaign,` : 'the person who created this campaign,'} ${leadersOf(podName)}, and admins can change it.`;
}

/** `what` is the action, as in "pause, resume or stop it". */
export function whyNotManageCampaign(a: Actor, podId: string | null, podName: string, what: string): string | null {
  if (canManageCampaigns(a, podId)) return null;
  if (isBizOps(a)) return bizOpsReads('campaigns');
  return `Only ${leadersOf(podName)}, and admins, can ${what}.`;
}

export function whyNotApproveCampaign(a: Actor, podId: string | null, podName: string): string | null {
  if (canApproveCampaign(a, podId)) return null;
  return `Only the Sales Leaders and Pod Managers of ${podName}, and admins, can approve this campaign.`;
}

export function whyNotDeleteCampaign(a: Actor, c: { status: string; podId: string | null; createdById: string | null; everLaunched: boolean }, podName: string): string | null {
  if (canDeleteCampaign(a, c)) return null;
  if (isAdmin(a)) return 'This campaign is still published. Stop it first, then delete it.';
  if (isBizOps(a)) return 'Biz Ops can view campaigns but cannot delete them.';
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(c.status)) return 'Only an admin can delete a campaign once it has been published.';
  if (c.everLaunched) return 'This campaign has run before, so only an admin can delete it.';
  return `Only the person who created this draft, ${leadersOf(podName)}, and admins can delete it.`;
}

export function whyNotChangeCampaignPeople(a: Actor, c: Parameters<typeof canChangeCampaignPeople>[1], podName: string): string | null {
  if (canChangeCampaignPeople(a, c)) return null;
  if (isBizOps(a)) return 'Biz Ops can view campaigns but cannot change who is in them.';
  return `Only the FOs on this campaign, the Sales Leaders and Pod Managers of ${podName}, and admins can change who is in it.`;
}

/** A task (or next action) someone else owns. `podName` is the pod it belongs to, when there is one. */
export function whyNotWorkTask(a: Actor, foName: string, podName?: string | null): string {
  if (isBizOps(a)) return 'Biz Ops can view tasks but cannot work them.';
  if (isJuniorFo(a)) return `This is ${foName}'s task. Junior FOs can work only their own tasks.`;
  return podName ? `This is ${foName}'s task in ${podName}, which is not one of your pods. You can work other people's tasks only in your own pods.` : `This is ${foName}'s task, and ${foName} is not in one of your pods.`;
}

/** `foName`: the FO whose task it is, when they may act on it too. */
export function whyNotManageEnrollment(a: Actor, podName: string, foName?: string | null): string {
  if (isBizOps(a)) return 'Biz Ops can view sequences but cannot change them.';
  return foName ? `Only ${foName}, whose task this is, ${leadersOf(podName)}, and admins can change this person's sequence.` : `Only ${leadersOf(podName)}, and admins, can change this person's sequence.`;
}

/** `what` is the action, as in "delete this meeting". */
export function whyNotManageMeeting(a: Actor, what: string): string {
  if (isBizOps(a)) return bizOpsReads('meetings');
  return `Only the person who recorded this meeting, admins, and the Senior FOs, Sales Leaders and Pod Managers of a pod whose contact attended can ${what}.`;
}

/** Enrichment belongs to the roles that lead pods. */
export const ENRICHMENT_ROLES = 'Senior FOs, Sales Leaders, Pod Managers and admins';

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
