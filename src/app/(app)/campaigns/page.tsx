import Link from 'next/link';
import { PageFrame } from '@/components/page-frame';
import { formatLocalDate, todayIn, diffDays } from '@/lib/dates';
import { requireUser } from '@/lib/auth/current-user';
import { canEnroll, canApproveCampaign, needsPod, visiblePodIds } from '@/lib/auth/rbac';
import { listCampaigns, type CampaignSummary } from '@/lib/campaigns-query';
import { prisma } from '@/lib/db';
import { defaultTwentySchema } from '@/lib/twenty/twenty-schema';
import { optionLabel } from '@/lib/twenty/labels';
import { approveCampaignAction, rejectCampaignAction } from '@/lib/actions/campaigns';
import { ActionButton } from '@/components/action-form';
import { CampaignsToolbar } from '@/components/campaigns/campaigns-toolbar';
import { IconCampaigns, IconPlus } from '@/components/icons';
import { Badge, Count, Empty, EmptyState, Surface, Tabs, Toolbar, ViewHeader } from '@/components/ui';
import { campaignStatusLabel } from '@/lib/campaign-status';

/**
 * Three lists, because they are three different things. Upcoming is a plan with an audience and
 * a capacity; Active is work in progress with a day count and touches done; Finished is a result.
 * Active opens first, Upcoming when nothing is active.
 */
type Tab = 'upcoming' | 'active' | 'finished';
const TAB_OF: Record<string, Tab> = { DRAFT: 'upcoming', PENDING_APPROVAL: 'upcoming', SCHEDULED: 'upcoming', ACTIVE: 'active', PAUSED: 'active', STOPPED: 'finished', COMPLETED: 'finished' };
type Search = { tab?: string; q?: string; pod?: string; sequence?: string; product?: string; fo?: string; from?: string; to?: string };

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const today = todayIn(user.timezone);
  const visible = visiblePodIds(user);
  const values = defaultTwentySchema.personValues;
  const product = sp.product && (values.productInterest as readonly string[]).includes(sp.product) ? sp.product : '';
  const [all, pods, sequences] = await Promise.all([
    listCampaigns(user, { q: sp.q ?? '', podId: sp.pod || null, sequenceId: sp.sequence || null, product: product || null, foUserId: sp.fo || null, from: sp.from || null, to: sp.to || null }),
    prisma.pod.findMany({ where: { archived: false, ...(visible === null ? {} : { id: { in: visible } }) }, orderBy: { name: 'asc' }, include: { users: { include: { user: { select: { id: true, name: true, active: true, role: true } } } } } }),
    prisma.sequence.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ]);
  const fos = [...new Map(pods.flatMap((p) => p.users.filter((u) => u.user.active && needsPod(u.user.role)).map((u) => [u.user.id, { id: u.user.id, name: u.user.name }] as const))).values()].sort((a, b) => a.name.localeCompare(b.name));
  const byTab: Record<Tab, CampaignSummary[]> = { upcoming: [], active: [], finished: [] };
  for (const c of all) byTab[TAB_OF[c.status] ?? 'finished'].push(c);
  const requested = sp.tab === 'upcoming' || sp.tab === 'active' || sp.tab === 'finished' ? sp.tab : null;
  const tab: Tab = requested ?? (byTab.active.length ? 'active' : 'upcoming');
  const rows = byTab[tab];
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries({ q: sp.q, pod: sp.pod, sequence: sp.sequence, product, fo: sp.fo, from: sp.from, to: sp.to })) if (v) query.set(k, v);
  const tabHref = (t: Tab) => { const p = new URLSearchParams(query); p.set('tab', t); return `/campaigns?${p.toString()}`; };
  const filtered = Boolean(sp.q || sp.pod || sp.sequence || product || sp.fo || sp.from || sp.to);

  return (
    <PageFrame className="space-y-3 px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader title="All campaigns" actions={canEnroll(user) ? <Link href="/campaigns/new" className="btn-primary"><IconPlus size={14} />New campaign</Link> : null} />
        <Tabs inset={false} current={tab} tabs={[
          { key: 'upcoming', label: 'Upcoming', href: tabHref('upcoming'), count: byTab.upcoming.length },
          { key: 'active', label: 'Active', href: tabHref('active'), count: byTab.active.length },
          { key: 'finished', label: 'Finished', href: tabHref('finished'), count: byTab.finished.length },
        ]} />
        <Toolbar className="pt-3">
          <CampaignsToolbar q={sp.q ?? ''} pods={pods.map((p) => ({ id: p.id, name: p.name }))} sequences={sequences} fos={fos} products={[...values.productInterest]} pod={sp.pod ?? ''} sequence={sp.sequence ?? ''} fo={sp.fo ?? ''} product={product} from={sp.from ?? ''} to={sp.to ?? ''} />
        </Toolbar>
        {!rows.length ? (
          <EmptyState icon={<IconCampaigns size={22} />} title={filtered ? 'No campaigns match' : !byTab.upcoming.length && !byTab.active.length && !byTab.finished.length ? 'No campaigns yet' : tab === 'upcoming' ? 'Nothing scheduled' : tab === 'active' ? 'Nothing running' : 'Nothing finished yet'} action={!filtered && canEnroll(user) ? <Link href="/campaigns/new" className="btn-primary"><IconPlus size={14} />New campaign</Link> : undefined} />
        ) : tab === 'upcoming' ? (
          <div key="upcoming" className="overflow-x-auto"><table className="table table-dense w-full table-fixed">
            <colgroup>{['24%', '12%', '15%', '13%', '12%', '9%', '15%'].map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
            <thead><tr><th>Campaign</th><th>Pod</th><th>Outreach</th><th>Starts</th><th>Runs until</th><th className="num">People</th><th>State</th></tr></thead>
            <tbody>{rows.map((c) => {
              const daysUntil = diffDays(today, c.startDate);
              return <tr key={c.id}>
                <td><Link href={'/campaigns/' + c.id} className="block truncate text-[13px] font-medium text-ink-900 hover:text-brand-700">{c.name}</Link>{c.productInterest.length ? <div className="truncate text-[12px] text-ink-500">{c.productInterest.map(optionLabel).join(', ')}</div> : null}</td>
                <td className="truncate text-[12.5px]">{c.podName}</td>
                <td className="truncate text-[12.5px]"><Link href={'/campaigns/' + c.id} className="hover:text-brand-700">{c.sequenceName}</Link></td>
                <td className="text-[12.5px]"><div className="text-ink-900">{formatLocalDate(c.startDate)}</div><div className="text-[12px] text-ink-500">{daysUntil === 0 ? 'today' : daysUntil < 0 ? 'date passed' : daysUntil === 1 ? 'tomorrow' : `in ${daysUntil} days`}</div></td>
                <td className="text-[12.5px]">{c.endDate ? formatLocalDate(c.endDate) : <Empty />}</td>
                <td className="num"><Count value={c.audience} /></td>
                <td>{c.status === 'PENDING_APPROVAL' ? (canApproveCampaign(user, c.podId) ? c.calendarPlan ? <Link className="btn-primary btn-sm" href={`/campaigns/${c.id}/edit`}>Review</Link> : <span className="flex flex-wrap gap-1.5"><ActionButton action={approveCampaignAction} payload={{ campaignId: c.id }} className="btn-primary btn-sm">Approve</ActionButton><ActionButton action={rejectCampaignAction} payload={{ campaignId: c.id }} className="btn-ghost btn-sm">Decline</ActionButton></span> : <Badge tone="amber">Awaiting approval</Badge>) : <Badge tone={c.status === 'DRAFT' ? 'gray' : 'purple'}>{campaignStatusLabel(c.status)}</Badge>}</td>
              </tr>;
            })}</tbody>
          </table></div>
        ) : tab === 'active' ? (
          <div key="active" className="overflow-x-auto"><table className="table table-dense w-full table-fixed">
            <colgroup>{['25%', '10%', '17%', '11%', '9%', '8%', '9%', '11%'].map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
            <thead><tr><th>Campaign</th><th>Pod</th><th>Progress</th><th>Touches</th><th className="num">People</th><th className="num">Replied</th><th className="num">Meetings</th><th>State</th></tr></thead>
            <tbody>{rows.map((c) => {
              const total = c.endDate ? diffDays(c.startDate, c.endDate) + 1 : null;
              const day = Math.max(1, diffDays(c.startDate, today) + 1);
              const pct = total ? Math.min(100, Math.round((Math.min(day, total) / total) * 100)) : null;
              const touchesTotal = c.touches.planned;
              return <tr key={c.id}>
                <td><Link href={'/campaigns/' + c.id} className="block truncate text-[13px] font-medium text-ink-900 hover:text-brand-700">{c.name}</Link><div className="truncate text-[12px] text-ink-500">{c.sequenceName}</div></td>
                <td className="truncate text-[12.5px]">{c.podName}</td>
                <td className="text-[12px]">{total ? <><div className="flex flex-wrap items-baseline justify-between gap-x-2 text-ink-700"><span className="whitespace-nowrap">Day <span className="tabular-nums">{Math.min(day, total)}</span> of <span className="tabular-nums">{total}</span></span><span className="whitespace-nowrap text-ink-500">{c.endDate ? (day > total ? `ran over ${formatLocalDate(c.endDate)}` : `ends ${formatLocalDate(c.endDate)}`) : null}</span></div><div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-ink-100"><div className={`h-full rounded-full ${day > total ? 'bg-amber-500' : 'bg-brand-500'}`} style={{ width: `${pct}%` }} /></div></> : <span className="text-ink-500">Started {formatLocalDate(c.startDate)}</span>}</td>
                <td className="text-[12.5px] tabular-nums text-ink-700">{touchesTotal ? <><span className="text-ink-900">{c.touches.done.toLocaleString('en-US')}</span> of {touchesTotal.toLocaleString('en-US')}</> : <Empty />}</td>
                <td className="num"><Count value={c.counts.total} /></td>
                <td className="num"><Count value={c.counts.replied} /></td>
                <td className="num"><Count value={c.counts.meeting} /></td>
                <td><Badge tone={c.status === 'PAUSED' ? 'amber' : 'green'}>{campaignStatusLabel(c.status)}</Badge></td>
              </tr>;
            })}</tbody>
          </table></div>
        ) : (
          <div key="finished" className="overflow-x-auto"><table className="table table-dense w-full table-fixed">
            <colgroup>{['24%', '12%', '18%', '10%', '9%', '9%', '8%', '10%'].map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
            <thead><tr><th>Campaign</th><th>Pod</th><th>Ran</th><th className="num">People</th><th className="num">Replied</th><th className="num">Meetings</th><th className="num">Reply rate</th><th>Outcome</th></tr></thead>
            <tbody>{rows.map((c) => <tr key={c.id}>
              <td><Link href={'/campaigns/' + c.id} className="block truncate text-[13px] font-medium text-ink-900 hover:text-brand-700">{c.name}</Link><div className="truncate text-[12px] text-ink-500">{c.sequenceName}</div></td>
              <td className="truncate text-[12.5px]">{c.podName}</td>
              <td className="text-[12.5px] text-ink-700">{formatLocalDate(c.startDate)}{c.endDate ? <> → {formatLocalDate(c.endDate)}</> : null}</td>
              <td className="num"><Count value={c.counts.total} /></td>
              <td className="num"><Count value={c.counts.replied} /></td>
              <td className="num"><Count value={c.counts.meeting} /></td>
              <td className="num">{c.counts.total ? `${Math.round(c.replyRate * 100)}%` : <Empty />}</td>
              <td><Badge tone="gray">{campaignStatusLabel(c.status)}</Badge></td>
            </tr>)}</tbody>
          </table></div>
        )}
      </Surface>
    </PageFrame>
  );
}
