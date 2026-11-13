import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import type { SessionUser } from '../auth/current-user';
import { isAdmin, toActor } from '../auth/rbac';
import { addDays, startOfLocalDay, todayIn, type LocalDate } from '../dates';
import { getSettings } from '../settings';
import { coldContactSelect, DONE_TAB_DAYS, TASK_TABS, type TaskFilters, type TaskTab } from '../tasks-query';
import type { AudienceScope } from '../subject';

/**
 * LinkedIn tasks Cadence opened (follow-ups) on the Tasks screen, in the same tabs as campaign steps and
 * next actions and counted with them, under LinkedIn. One with no owner is not in anyone's tabs: it waits
 * in "Needs an owner" until someone takes it.
 */

export const followUpInclude = {
  person: { select: { id: true, firstName: true, lastName: true, companyName: true, email: true, phone: true, jobTitle: true, linkedinUrl: true, linkedinKey: true } },
  sandboxContact: { select: coldContactSelect },
  fo: { select: { id: true, name: true } },
  link: { select: { profileKey: true, accountId: true, status: true, invitedAt: true, acceptedAt: true, withdrawnAt: true, resends: true } },
} satisfies Prisma.LinkedInFollowUpInclude;
export type FollowUpRow = Prisma.LinkedInFollowUpGetPayload<{ include: typeof followUpInclude }>;

function audienceWhere(scope: AudienceScope): Prisma.LinkedInFollowUpWhereInput {
  const crm = { personId: { not: null } };
  const cold = { personId: null, sandboxContact: { status: 'ACTIVE' as const } };
  return scope === 'crm' ? crm : scope === 'cold' ? cold : { OR: [crm, cold] };
}

/** In view of the Tasks filters: whose, which pod (a CRM person's by the FO's pods, a cold contact's by its own), which audience. */
export function followUpScopeWhere(f: { podId?: string | null; foUserId?: string | null; audience?: AudienceScope }): Prisma.LinkedInFollowUpWhereInput {
  return {
    AND: [
      audienceWhere(f.audience ?? 'all'),
      f.foUserId ? { foUserId: f.foUserId } : {},
      f.podId ? { OR: [{ personId: { not: null }, fo: { pods: { some: { podId: f.podId } } } }, { personId: null, sandboxContact: { podId: f.podId } }] } : {},
    ],
  };
}

const tabWhere = (tab: TaskTab, today: LocalDate, recentDone: Date): Prisma.LinkedInFollowUpWhereInput =>
  tab === 'done' ? { state: 'DONE', completedAt: { gte: recentDone }, foUserId: { not: null } } : { state: 'OPEN', foUserId: { not: null }, dueDate: tab === 'overdue' ? { lt: today } : tab === 'today' ? today : { gt: today } };

/** One tab's follow-ups, and counts for every tab from the database. Only under All types and LinkedIn. */
export async function listFollowUpItems(user: SessionUser, filters: TaskFilters, now = new Date(), limit = 200) {
  const today = todayIn(user.timezone, now);
  const counts: Record<TaskTab, number> = { today: 0, overdue: 0, upcoming: 0, done: 0 };
  if (filters.channel && filters.channel !== 'LINKEDIN') {
    const linkedin = await prisma.linkedInFollowUp.count({ where: { AND: [followUpScopeWhere(filters), tabWhere(filters.tab, today, startOfLocalDay(addDays(today, -DONE_TAB_DAYS), user.timezone))] } });
    return { rows: [] as FollowUpRow[], counts, linkedin: filters.tab === 'done' ? 0 : linkedin };
  }
  const recentDone = startOfLocalDay(addDays(today, -DONE_TAB_DAYS), user.timezone);
  const scope = followUpScopeWhere(filters);
  const [byTab, rows] = await Promise.all([
    Promise.all(TASK_TABS.map((tab) => prisma.linkedInFollowUp.count({ where: { AND: [scope, tabWhere(tab, today, recentDone)] } }))),
    prisma.linkedInFollowUp.findMany({ where: { AND: [scope, tabWhere(filters.tab, today, recentDone)] }, include: followUpInclude, orderBy: filters.tab === 'done' ? { completedAt: 'desc' } : [{ dueDate: 'asc' }, { createdAt: 'asc' }], take: limit }),
  ]);
  TASK_TABS.forEach((tab, i) => { counts[tab] = byTab[i]; });
  return { rows, counts, linkedin: filters.tab === 'done' ? 0 : counts[filters.tab] };
}

/**
 * Follow-ups nobody owns yet: someone we reached on LinkedIn answered (accepted or wrote back) and has no
 * owner (owner, 12 Nov 2026: "cadence should watch and popup people and connections that have responded
 * back to be given a owner"). An admin sees all; everyone else, their pods' and those with no pod.
 */
export async function needsOwnerItems(user: SessionUser, limit = 100): Promise<FollowUpRow[]> {
  const pods = isAdmin(toActor(user)) ? null : user.podIds;
  return prisma.linkedInFollowUp.findMany({
    where: {
      state: 'OPEN', foUserId: null,
      OR: [{ personId: { not: null } }, { personId: null, sandboxContact: { status: 'ACTIVE' } }],
      ...(pods ? { AND: [{ OR: [{ personId: { not: null } }, { sandboxContact: { podId: null } }, { sandboxContact: { podId: { in: pods } } }] }] } : {}),
    },
    include: followUpInclude,
    orderBy: { triggeredAt: 'asc' },
    take: limit,
  });
}

export type AccountView = { id: string; name: string; invites: number; limit: number; atLimit: boolean; nearLimit: boolean };

/** The firm's LinkedIn accounts by id, with where each stands against its weekly request limit. */
export async function accountViews(ids?: string[]): Promise<Map<string, AccountView>> {
  const { linkedin } = await getSettings();
  const rows = await prisma.linkedInAccount.findMany({ where: ids ? { id: { in: [...new Set(ids)] } } : {}, orderBy: { name: 'asc' } });
  return new Map(rows.map((a) => {
    const limit = a.inviteWeeklyLimit ?? linkedin.inviteWeeklyLimit;
    return [a.id, { id: a.id, name: a.name, invites: a.invitesLast7Days, limit, atLimit: a.invitesLast7Days >= limit, nearLimit: a.invitesLast7Days >= Math.floor(limit * 0.9) }];
  }));
}
