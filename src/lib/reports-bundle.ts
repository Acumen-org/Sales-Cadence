import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { ROLES_NEEDING_POD, visiblePodIds } from './auth/rbac';
import { diffDays, todayIn } from './dates';
import { filterParam, sectionDefaults } from './default-filters';
import { listCampaigns } from './campaigns-query';
import { buildReports, comparisonRange, reportingRange, reportingTimezone, type Reports } from './reports-query';
import type { RunningCampaign } from '@/components/reports/report-document';

/**
 * Everything the Reports page and the exported report both need, loaded once: this period, the
 * period just before it, the filter options, and the campaigns running.
 */
export type ReportBundle = {
  today: string;
  range: ReturnType<typeof reportingRange>;
  previousRange: { from: string; to: string };
  podId: string | null;
  foUserId: string | null;
  pods: { id: string; name: string }[];
  users: { id: string; name: string }[];
  reports: Reports;
  previous: Reports;
  campaigns: RunningCampaign[];
  scope: string;
};

export async function loadReportBundle(user: SessionUser, sp: { from?: string; to?: string; pod?: string; fo?: string }): Promise<ReportBundle> {
  const today = todayIn(reportingTimezone());
  const range = reportingRange(sp.from, sp.to, today);
  const before = comparisonRange(range.from, range.to);
  const previousRange = reportingRange(before.from, before.to, today);
  const visiblePods = visiblePodIds(user);
  const defaults = await sectionDefaults(user);
  const wantedPod = filterParam(sp.pod, defaults.podId);
  const wantedFo = filterParam(sp.fo, defaults.foUserId);
  // A pod or FO the address names but this reader cannot pick (an old link, a typo) is no filter at
  // all: a filter nobody can see on the screen must not be quietly emptying every figure.
  const [pods, fo] = await Promise.all([
    prisma.pod.findMany({ where: { archived: false, ...(visiblePods === null ? {} : { id: { in: visiblePods } }) }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    wantedFo ? prisma.user.findUnique({ where: { id: wantedFo }, select: { id: true, pods: { select: { podId: true } } } }) : Promise.resolve(null),
  ]);
  const podId = wantedPod && pods.some((p) => p.id === wantedPod) ? wantedPod : defaults.podId && pods.some((p) => p.id === defaults.podId) ? defaults.podId : null;
  const foUserId = fo && (!podId || fo.pods.some((p) => p.podId === podId)) ? fo.id : null;
  const [users, reports, previous, running] = await Promise.all([
    prisma.user.findMany({
      // FOs, and anyone who still has outreach of their own: exactly the people the FO table can show.
      where: { AND: [{ OR: [{ role: { in: ROLES_NEEDING_POD }, active: true }, { enrollments: { some: {} } }] }, visiblePods === null ? {} : { OR: [{ id: user.id }, { pods: { some: { podId: { in: visiblePods } } } }] }, ...(podId ? [{ pods: { some: { podId } } }] : [])] },
      select: { id: true, name: true }, orderBy: { name: 'asc' },
    }),
    buildReports(user, today, { range, podId, foUserId }),
    buildReports(user, today, { range: previousRange, podId, foUserId }),
    listCampaigns(user, { podId, foUserId, statuses: ['ACTIVE', 'PAUSED'] }),
  ]);
  const campaigns: RunningCampaign[] = running
    .map((c) => ({ id: c.id, name: c.name, podName: c.podName, products: c.productInterest, paused: c.status === 'PAUSED', startDate: c.startDate, endDate: c.endDate, day: diffDays(c.startDate, today) + 1, total: c.endDate ? diffDays(c.startDate, c.endDate) + 1 : null, touchesDone: c.touches.done, touchesPlanned: c.touches.planned }));
  const scope = [podId ? pods.find((p) => p.id === podId)?.name : 'All pods', foUserId ? users.find((u) => u.id === foUserId)?.name : null].filter(Boolean).join(' · ');
  return { today, range, previousRange: { from: previousRange.from, to: previousRange.to }, podId, foUserId, pods, users, reports, previous, campaigns, scope };
}
