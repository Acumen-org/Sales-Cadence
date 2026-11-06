import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { ROLES_NEEDING_POD, visiblePodIds } from './auth/rbac';
import { diffDays, todayIn } from './dates';
import { filterParam, sectionDefaults } from './default-filters';
import { listCampaigns } from './campaigns-query';
import type { AudienceScope } from './subject';
import { buildReports, comparisonRange, parseReportAudience, REPORT_AUDIENCES, reportingRange, reportingTimezone, type Reports } from './reports-query';
import type { RunningCampaign } from '@/components/reports/report-document';

/**
 * Everything the Reports page and the exported report both need, loaded once: this period, the
 * period just before it, the filter options, and the campaigns running, for one audience (PLAN 6:
 * All outreach, CRM or Cold outreach).
 */
export type ReportBundle = {
  today: string;
  range: ReturnType<typeof reportingRange>;
  previousRange: { from: string; to: string };
  podId: string | null;
  foUserId: string | null;
  audience: AudienceScope;
  pods: { id: string; name: string }[];
  users: { id: string; name: string }[];
  reports: Reports;
  previous: Reports;
  campaigns: RunningCampaign[];
  scope: string;
};

export type ReportSearch = { from?: string; to?: string; pod?: string; fo?: string; audience?: string };

export async function loadReportBundle(user: SessionUser, sp: ReportSearch): Promise<ReportBundle> {
  const today = todayIn(reportingTimezone());
  const range = reportingRange(sp.from, sp.to, today);
  const before = comparisonRange(range.from, range.to);
  const previousRange = reportingRange(before.from, before.to, today);
  const audience = parseReportAudience(sp.audience);
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
  // B038: "All pods" is a choice, and it sticks: only a pod the reader cannot see falls back to none.
  const podId = wantedPod && pods.some((p) => p.id === wantedPod) ? wantedPod : null;
  const foUserId = fo && (!podId || fo.pods.some((p) => p.podId === podId)) ? fo.id : null;
  const [reports, previous, running] = await Promise.all([
    buildReports(user, today, { range, podId, foUserId, audience }),
    buildReports(user, today, { range: previousRange, podId, foUserId, audience }),
    // The campaigns of the audience shown: both kinds in All outreach.
    Promise.all((audience === 'all' ? (['CRM', 'SANDBOX'] as const) : audience === 'crm' ? (['CRM'] as const) : (['SANDBOX'] as const)).map((a) => listCampaigns(user, { podId, foUserId, statuses: ['ACTIVE', 'PAUSED'], audience: a }).then((list) => list.map((c) => ({ ...c, cold: a === 'SANDBOX' }))))).then((lists) => lists.flat()),
  ]);
  // The FO list: reps of a pod, anyone with outreach of their own, and (N065) a rep who has left but
  // has figures in this period, marked "(removed)", so every row of the table can be picked.
  const withFigures = [...new Set(reports.byFo.map((r) => r.key).filter((k) => k !== 'none'))];
  const users = await prisma.user.findMany({
    where: { AND: [{ OR: [{ role: { in: ROLES_NEEDING_POD }, active: true }, { enrollments: { some: {} } }, { id: { in: withFigures } }] }, visiblePods === null ? {} : { OR: [{ id: user.id }, { pods: { some: { podId: { in: visiblePods } } } }] }, ...(podId ? [{ OR: [{ pods: { some: { podId } } }, { id: { in: withFigures } }] }] : [])] },
    select: { id: true, name: true, active: true }, orderBy: { name: 'asc' },
  });
  const campaigns: RunningCampaign[] = running
    .map((c) => ({ id: c.id, name: c.name, podName: c.podName, products: c.productInterest, paused: c.status === 'PAUSED', startDate: c.startDate, endDate: c.endDate, day: diffDays(c.startDate, today) + 1, total: c.endDate ? diffDays(c.startDate, c.endDate) + 1 : null, touchesDone: c.touches.done, touchesPlanned: c.touches.planned, cold: c.cold }));
  const names = users.map((u) => ({ id: u.id, name: u.active ? u.name : `${u.name} (removed)` }));
  const scope = [REPORT_AUDIENCES.find((a) => a.key === audience)!.label, podId ? pods.find((p) => p.id === podId)?.name : 'All pods', foUserId ? names.find((u) => u.id === foUserId)?.name : null].filter(Boolean).join(' · ');
  return { today, range, previousRange: { from: previousRange.from, to: previousRange.to }, podId, foUserId, audience, pods, users: names, reports, previous, campaigns, scope };
}
