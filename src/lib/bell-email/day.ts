import type { Role } from '@prisma/client';
import { prisma } from '../db';
import { todayIn } from '../dates';
import { workspaceTimezone } from '../workspace';
import { dueCounts } from '../tasks-query';
import { scoreboard } from '../meetings/scoreboard';
import { COLD_CAMPAIGNS_HREF } from '../subject';
import { DUE_TODAY, OVERDUE, type DayFigures, type DayTile } from './template';

/*
 * "Your day" in the morning summary (owner, 24 Nov 2026): numbers only, the same ones the screens
 * show. Tasks are counted on the company's day, exactly as the Tasks tabs and the sidebar badge count
 * them (dueCounts), so the email and the screen agree; the person's own time zone only decides when
 * the email arrives. Meetings come from the Meetings scoreboard.
 *
 *   An FO: due today, overdue, campaigns they have people in; their meetings against the goal.
 *   A Sales Leader or Pod Manager: their own due and overdue if they have any, overdue across the FOs
 *     of their pods, campaigns running in their pods; their pods' meetings against the target.
 *   An admin or Biz Ops: their own due and overdue if any, every campaign running; the company's
 *     meetings against the target.
 */

const FO_ROLES: Role[] = ['JUNIOR_FO', 'SENIOR_FO'];
const LEADER_ROLES: Role[] = ['SALES_LEADER', 'POD_MANAGER'];

const monthName = (first: string) => new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(`${first}T12:00:00Z`));
function footWords(toGo: number, workdaysLeft: number) {
  if (toGo <= 0) return 'Goal reached this month';
  return `${toGo} to go, ${workdaysLeft} workday${workdaysLeft === 1 ? '' : 's'} left`;
}

/** Overdue work across the active FOs of these pods. */
async function overdueInPods(podIds: string[], today: string): Promise<number> {
  if (!podIds.length) return 0;
  const fos = await prisma.user.findMany({ where: { active: true, role: { in: FO_ROLES }, pods: { some: { podId: { in: podIds } } } }, select: { id: true } });
  const counts = await Promise.all(fos.map((f) => dueCounts(f.id, 'all', today)));
  return counts.reduce((sum, c) => sum + c.overdue, 0);
}

export async function dayFigures(u: { id: string; role: Role; podIds: string[] }, now = new Date()): Promise<DayFigures> {
  const today = todayIn(workspaceTimezone(), now);
  const fo = FO_ROLES.includes(u.role);
  const leader = LEADER_ROLES.includes(u.role);
  const [own, board, campaigns, podOverdue] = await Promise.all([
    dueCounts(u.id, 'all', today),
    scoreboard(u, now),
    // Running: started and not paused (the screens' Active tab holds paused ones too), CRM and cold alike.
    prisma.campaign.groupBy({ by: ['audience'], where: { status: 'ACTIVE', ...(fo ? { enrollments: { some: { foUserId: u.id, status: 'ACTIVE' } } } : leader ? { podId: { in: u.podIds } } : {}) }, _count: { _all: true } }),
    leader ? overdueInPods(u.podIds, today) : Promise.resolve(0),
  ]);

  const tiles: DayTile[] = [];
  if (fo || own.today || own.overdue) {
    tiles.push({ label: DUE_TODAY, value: own.today, href: '/tasks?tab=today' });
    tiles.push({ label: OVERDUE, value: own.overdue, href: '/tasks?tab=overdue', warn: true });
  }
  if (leader) tiles.push({ label: 'Overdue in your pods', value: podOverdue, href: '/home', warn: true });
  // The page that holds them: Cold outreach's campaigns when every running one is cold.
  const running = (a: string) => campaigns.find((g) => g.audience === a)?._count._all ?? 0;
  const crm = running('CRM'), cold = running('SANDBOX');
  tiles.push({ label: 'Campaigns running', value: crm + cold, href: cold && !crm ? `${COLD_CAMPAIGNS_HREF}?tab=active` : '/campaigns?tab=active' });

  const month = monthName(board.month.first);
  const meetings: DayFigures['meetings'] = fo && board.me
    ? { label: `Meetings in ${month}`, count: board.me.meetings, goal: board.goal, foot: footWords(board.me.toGo, board.month.workdaysLeft), href: '/meetings' }
    : !fo && board.team.target > 0
      ? { label: leader ? `Your pods' meetings in ${month}` : `Meetings in ${month}`, count: board.team.meetings, goal: board.team.target, foot: footWords(board.team.toGo, board.month.workdaysLeft), href: '/meetings' }
      : null;
  return { tiles, meetings };
}

/** Whether "Your day" holds anything to say: the summary goes on a workday when one number is not zero. */
export const dayHasNews = (d: DayFigures) => d.tiles.some((t) => t.value > 0) || (d.meetings?.count ?? 0) > 0;
