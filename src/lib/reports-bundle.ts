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
 * period of the same length just before it, the filter options, and the campaigns running.
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
  const podId = filterParam(sp.pod, defaults.podId);
  const foUserId = filterParam(sp.fo, defaults.foUserId);
  const [pods, users, reports, previous, running] = await Promise.all([
    prisma.pod.findMany({ where: visiblePods === null ? {} : { id: { in: visiblePods } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.user.findMany({
      // FOs, and anyone who still has outreach of their own: exactly the people the FO table can show.
      where: { AND: [{ OR: [{ role: { in: ROLES_NEEDING_POD } }, { enrollments: { some: {} } }] }, visiblePods === null ? {} : { OR: [{ id: user.id }, { pods: { some: { podId: { in: visiblePods } } } }] }, ...(podId ? [{ pods: { some: { podId } } }] : [])] },
      select: { id: true, name: true }, orderBy: { name: 'asc' },
    }),
    buildReports(user, today, { range, podId, foUserId }),
    buildReports(user, today, { range: previousRange, podId, foUserId }),
    listCampaigns(user, { podId, foUserId }),
  ]);
  const campaigns: RunningCampaign[] = running
    .filter((c) => c.status === 'ACTIVE' || c.status === 'PAUSED')
    .map((c) => ({ id: c.id, name: c.name, podName: c.podName, startDate: c.startDate, endDate: c.endDate, day: Math.max(1, diffDays(c.startDate, today) + 1), total: c.endDate ? diffDays(c.startDate, c.endDate) + 1 : null, touchesDone: c.touches.done, touchesPlanned: c.touches.planned, replied: c.counts.replied, meetings: c.counts.meeting }));
  const scope = [podId ? pods.find((p) => p.id === podId)?.name : 'All pods', foUserId ? users.find((u) => u.id === foUserId)?.name : null].filter(Boolean).join(' · ');
  return { today, range, previousRange: { from: previousRange.from, to: previousRange.to }, podId, foUserId, pods, users, reports, previous, campaigns, scope };
}
