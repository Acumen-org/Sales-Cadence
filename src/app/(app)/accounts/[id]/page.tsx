import { meetingDay } from '@/lib/meetings/day';
import { canCreateMeeting, isAdmin } from '@/lib/auth/rbac';
import { ActionButton } from '@/components/action-form';
import { blockAccountAction, unblockAccountAction } from '@/lib/actions/blocked-accounts';
import Link from 'next/link';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { RecordSync } from '@/components/record-sync';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { accountDetail } from '@/lib/accounts-query';
import { addDays, formatInstant, formatLocalDate, toLocalDate, todayIn } from '@/lib/dates';
import { accentFor } from '@/lib/accent';
import { membershipFor, membershipLabel, primaryMembership } from '@/lib/campaign-membership';
import { OrgTree, type TreePerson } from '@/components/accounts/org-tree';
import { ActionIcon, IconExternal, IconLock, IconPlus } from '@/components/icons';
import { Badge, CAMPAIGN_TONE, Card, Count, enrollmentTone, Empty, EmptyState, IdentityCell, KeyValue, RecordHeader, Surface, Tabs, TierBadge, enrollmentStatusLabel } from '@/components/ui';
import { campaignStatusLabel } from '@/lib/campaign-status';
import { optionLabels } from '@/lib/twenty/labels';
import { blockAccountConfirm, unblockAccountConfirm } from '@/lib/confirms';
import { ActivityFeed } from '@/components/activity-feed';
import { kindOf, type FeedItem } from '@/lib/feed';
import { KIND_WORD, touchTitle } from '@/lib/person-feed';
import { getSettings } from '@/lib/settings';

/**
 * Six tabs (owner, 13 Nov 2026): People holds the list and the view by title, Activity is the one feed
 * every record page has, and Campaigns no longer repeats Meetings. Old links keep working.
 */
const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'people', label: 'People' },
  { key: 'activity', label: 'Activity' },
  { key: 'work', label: 'Campaigns' },
  { key: 'meetings', label: 'Meetings' },
  { key: 'tasks', label: 'Tasks' },
];
const ALIASES: Record<string, string> = { relationships: 'people', timeline: 'activity' };

const websiteHref = (domain: string) => (domain.startsWith('http') ? domain : `https://${domain}`);

export default async function AccountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; view?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const asked = ALIASES[sp.tab ?? ''] ?? sp.tab;
  const tab = TABS.some((t) => t.key === asked) ? asked! : 'overview';
  // People by title: the old tab, or the toggle on People.
  const byTitle = sp.tab === 'relationships' || sp.view === 'titles';
  const detail = await accountDetail(id, user);
  if (!detail) notFound();
  const { company, people, meetings, campaigns, timeline, openTasks, stats, ownerName, blocked } = detail;
  const today = todayIn(user.timezone);
  const settings = await getSettings();

  const toTreePerson = (p: (typeof people)[number]): TreePerson => ({
    id: p.id,
    name: p.name,
    jobTitle: p.jobTitle,
    dnd: p.dnd,
    optedOut: p.optedOut,
    enrollment: p.enrollment
      ? { status: p.enrollment.status, label: enrollmentStatusLabel(p.enrollment), tone: enrollmentTone(p.enrollment), foName: p.enrollment.foName, stepIndex: p.enrollment.stepIndex, steps: p.enrollment.steps }
      : null,
    lastTouch: p.lastTouchAt ? formatInstant(p.lastTouchAt, user.timezone) : null,
    touches: p.touches,
  });
  const membership = await membershipFor(people.map((p) => p.id));
  const upcomingHere = [...new Map([...membership.values()].flat().filter((m) => m.kind === 'upcoming').map((m) => [m.campaignId, m])).values()];
  const accent = accentFor(company.id);
  const horizon = addDays(today, 30);
  const dueSoon = openTasks.filter((t) => t.due <= horizon).sort((a, b) => a.due.localeCompare(b.due));
  // The one feed (lib/feed.ts): whom each event was about, who did it, what was said.
  const feed: FeedItem[] = timeline.map((it, i) => ({
    key: `${i}:${it.at.getTime()}`,
    at: it.at.toISOString(),
    kind: it.kind === 'state' ? 'campaign' : it.kind === 'meeting' ? 'meeting' : kindOf(it.icon),
    // A campaign step (done, skipped, cancelled) is a step, not a message sent.
    direction: it.kind === 'task' ? null : it.tone === 'in' ? 'in' : it.tone === 'out' ? 'out' : null,
    label: it.kind === 'task' ? `${KIND_WORD[kindOf(it.icon)]} step` : null,
    title: it.kind === 'touch' ? touchTitle(it.title, settings.matching.cadencePrefix) : it.title,
    href: it.kind === 'meeting' ? it.href : null,
    who: it.fields.find((f) => f.label === 'By')?.value ?? null,
    person: it.personId && it.personName ? { name: it.personName, href: `/people/${it.personId}` } : null,
    fields: it.fields.filter((f) => f.label !== 'By' && f.label !== 'Note'),
    body: it.fields.find((f) => f.label === 'Note')?.value ?? null,
  }));
  const statusOf = (p: (typeof people)[number]) => {
    if (p.dnd || p.optedOut) return { label: 'Do not contact', tone: 'red' as const };
    const m = primaryMembership(membership.get(p.id));
    return m ? membershipLabel(m) : null;
  };
  // People who are being worked first, then whoever was touched last.
  const ranked = [...people].sort((a, b) => Number(Boolean(b.enrollment)) - Number(Boolean(a.enrollment)) || (b.lastTouchAt?.getTime() ?? 0) - (a.lastTouchAt?.getTime() ?? 0) || a.name.localeCompare(b.name));
  const sub = [company.industry, company.city, company.domain ? <a key="d" href={websiteHref(company.domain)} target="_blank" rel="noreferrer" className="hover:text-brand-700 hover:underline">{company.domain.replace(/^https?:\/\/(www\.)?/, '')}</a> : null].filter(Boolean) as ReactNode[];

  return (
    <>
      <RecordSync kind="company" id={company.id} />
      <div className="px-6 pt-2">
        <RecordHeader
          name={company.name}
          shape="square"
          accent={accent}
          seed={company.id}
          stackOnPhone
          sub={sub.length ? <span className="flex flex-wrap items-center gap-x-1.5">{sub.map((s, i) => <span key={i} className="inline-flex items-center gap-1.5">{i ? <span aria-hidden className="text-ink-400">·</span> : null}{s}</span>)}</span> : null}
          badges={<>
            {detail.mine ? <Badge tone="blue">Mine</Badge> : null}
            {ownerName ? <Badge tone="gray">{`Owner ${ownerName}`}</Badge> : null}
          </>}
          actions={<>
            {company.domain ? <a href={websiteHref(company.domain)} target="_blank" rel="noreferrer" className="btn-secondary btn-sm"><IconExternal size={13} /> Website</a> : null}
            {company.linkedinUrl ? <a href={company.linkedinUrl} target="_blank" rel="noreferrer" className="btn-secondary btn-sm"><ActionIcon action="LINKEDIN_MESSAGE" size={13} /> LinkedIn</a> : null}
            {canCreateMeeting(user) && !blocked ? <Link href={`/meetings/new?account=${company.id}`} className="btn-secondary btn-sm"><IconPlus size={13} /> Meeting</Link> : null}
            {isAdmin(user) ? (
              blocked
                ? <ActionButton action={unblockAccountAction} payload={{ companyId: company.id }} confirm={unblockAccountConfirm(company.name)}>Unblock account</ActionButton>
                : <ActionButton action={blockAccountAction} payload={{ companyId: company.id }} confirm={blockAccountConfirm(company.name)} className="btn-ghost btn-sm !text-red-700 hover:!bg-red-50"><IconLock size={13} /> Block account</ActionButton>
            ) : null}
          </>}
        />
      </div>

      {blocked ? (
        <div className="px-6 pt-3">
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50/70 px-4 py-3 text-[13px] text-red-800">
            <IconLock size={15} />
            <span className="font-medium">Blocked account</span>
            <span className="text-red-700">{blocked.byName ? `${blocked.byName} · ` : ''}{formatInstant(blocked.at, user.timezone)}{blocked.reason ? ` · ${blocked.reason}` : ''}</span>
          </div>
        </div>
      ) : null}

      <div className="px-6 pt-3">
        <Surface flush>
          <Tabs inset={false} current={tab} tabs={TABS.map((t) => ({ ...t, href: `/accounts/${id}?tab=${t.key}`, count: t.key === 'people' ? stats.people : t.key === 'tasks' ? dueSoon.length : t.key === 'meetings' ? meetings.length : undefined }))} />
        </Surface>
      </div>

      <div className="space-y-3 px-6 pb-8 pt-3">
        {tab === 'overview' ? <>
          {/* The account's numbers in one quiet row, not six tiles. */}
          <Surface flush>
            <dl className="grid grid-cols-3 divide-x divide-y divide-line md:grid-cols-6 md:divide-y-0">
              {([['People', stats.people], ['In a campaign', stats.inSequence], ['Replies', stats.replied], ['Meetings', stats.meetings], ['Touches', stats.touches], ['Open tasks', stats.openTasks]] as const).map(([label, value]) => <div key={label} className="px-4 py-3">
                <dt className="text-[12px] text-ink-500">{label}</dt>
                <dd className="mt-0.5 text-[20px] font-semibold tabular-nums leading-tight text-ink-900">{value}</dd>
              </div>)}
            </dl>
          </Surface>
          <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 space-y-3">
              <Card title="People" actions={people.length ? <Link href={`/accounts/${id}?tab=people`} className="btn-ghost btn-sm">{people.length > 8 ? `All ${people.length}` : 'View all'}</Link> : null}>
                {ranked.length ? <ul className="divide-y divide-line">{ranked.slice(0, 8).map((p) => {
                  const s = statusOf(p);
                  return <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                    <div className="min-w-0 flex-1"><IdentityCell name={p.name} href={`/people/${p.id}`} shape="circle" size={30} sub={p.jobTitle} /></div>
                    {s ? <Badge tone={s.tone}>{s.label}</Badge> : null}
                    <span className="hidden w-28 shrink-0 text-right text-[12px] text-ink-500 sm:block">{p.lastTouchAt ? `Last ${formatLocalDate(toLocalDate(p.lastTouchAt, user.timezone))}` : 'Not contacted'}</span>
                  </li>;
                })}</ul> : <EmptyState title="Nobody at this account yet" />}
              </Card>
              <Card title="Recent activity" actions={feed.length ? <Link href={`/accounts/${id}?tab=activity`} className="btn-ghost btn-sm">View all</Link> : null}>
                <ActivityFeed items={feed} timezone={user.timezone} today={today} limit={6} showPerson empty="Nothing recorded yet." />
              </Card>
            </div>
            <aside className="min-w-0 space-y-3">
              <Card title="Account details">
                <div className="p-4">
                  <KeyValue items={[
                    { k: 'Industry', v: company.industry },
                    { k: 'City', v: company.city },
                    { k: 'Employees', v: company.employees },
                    { k: 'AUM', v: company.aum ? company.aum.toNumber().toLocaleString('en-US', { maximumFractionDigits: 0 }) : null },
                    { k: 'Owner', v: ownerName },
                    { k: 'Website', v: company.domain ? <a href={websiteHref(company.domain)} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">{company.domain.replace(/^https?:\/\/(www\.)?/, '')}</a> : null },
                    // The handle, not the whole URL, matching the person record.
                    { k: 'LinkedIn', v: company.linkedinUrl ? <a href={company.linkedinUrl} target="_blank" rel="noreferrer" title={company.linkedinUrl} className="text-brand-700 hover:underline">{company.linkedinUrl.replace(/^https?:\/\/(www\.)?linkedin\.com\//i, '')}</a> : null },
                  ].filter((i) => i.v !== null && i.v !== undefined && i.v !== '')} />
                </div>
                <div className="border-t border-line px-4 py-2.5 text-[11.5px] text-ink-500">CRM id <span className="font-mono">{company.id}</span>{company.syncedAt ? ` · synced ${formatInstant(company.syncedAt, user.timezone)}` : ''}</div>
              </Card>
              <Card title="Open tasks" actions={dueSoon.length > 5 ? <Link href={`/accounts/${id}?tab=tasks`} className="btn-ghost btn-sm">All {dueSoon.length}</Link> : null}>
                {dueSoon.length ? <ul className="divide-y divide-line">{dueSoon.slice(0, 5).map((t) => <li key={t.id} className="flex items-start gap-2.5 px-4 py-2.5 text-[13px]">
                  <ActionIcon action={t.action} size={14} className="mt-0.5 shrink-0 text-ink-500" />
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium text-ink-900">{t.label}</span><Link href={`/people/${t.personId}`} className="block truncate text-[12px] text-ink-600 hover:text-brand-700">{t.personName} · {t.foName}</Link></span>
                  <span className={clsx('shrink-0 text-[12px]', t.due < today ? 'font-medium text-red-700' : 'text-ink-500')}>{t.due < today ? 'Overdue' : formatLocalDate(t.due)}</span>
                </li>)}</ul> : <p className="p-4 text-[13px] text-ink-500">Nothing due in the next 30 days.</p>}
              </Card>
              {meetings.length ? <Card title="Meetings" actions={meetings.length > 3 ? <Link href={`/accounts/${id}?tab=meetings`} className="btn-ghost btn-sm">All {meetings.length}</Link> : null}>
                <ul className="divide-y divide-line">{meetings.slice(0, 3).map((m) => <li key={m.id} className="px-4 py-2.5 text-[13px]">
                  <Link href={`/meetings/${m.id}`} className="block truncate font-medium text-ink-900 hover:text-brand-700">{m.title}</Link>
                  <span className="text-[12px] text-ink-500">{formatLocalDate(meetingDay(m.occurredAt), 'long')} · {m.attendees.filter((a) => a.external).length} external</span>
                </li>)}</ul>
              </Card> : null}
              {campaigns.length ? <Card title="Campaigns" actions={<Link href={`/accounts/${id}?tab=work`} className="btn-ghost btn-sm">View all</Link>}>
                <ul className="divide-y divide-line">{campaigns.slice(0, 4).map((c) => <li key={c.id} className="flex items-center gap-2 px-4 py-2.5 text-[13px]">
                  <span className="min-w-0 flex-1"><Link href={`/campaigns/${c.id}`} className="block truncate font-medium text-ink-900 hover:text-brand-700">{c.name}</Link><span className="text-[12px] text-ink-500">{c.people} here{c.replied ? ` · ${c.replied} replied` : ''}</span></span>
                  <Badge tone={CAMPAIGN_TONE[c.status] ?? 'gray'}>{campaignStatusLabel(c.status)}</Badge>
                </li>)}</ul>
              </Card> : null}
            </aside>
          </div>
        </> : null}

        {tab === 'people' ? (
          <Surface flush>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <span className="text-[13px] text-ink-600">{people.length === 1 ? '1 person' : `${people.length} people`}</span>
              <div role="group" aria-label="View" className="inline-flex rounded-lg border border-line bg-canvas p-0.5 text-[12.5px] font-medium">
                <Link href={`/accounts/${id}?tab=people`} aria-current={!byTitle ? 'page' : undefined} className={clsx('rounded-md px-3 py-1', !byTitle ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-600 hover:text-ink-900')}>List</Link>
                <Link href={`/accounts/${id}?tab=people&view=titles`} aria-current={byTitle ? 'page' : undefined} className={clsx('rounded-md px-3 py-1', byTitle ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-600 hover:text-ink-900')}>By title</Link>
              </div>
            </div>
            {people.length === 0 ? <EmptyState title="Nobody at this account yet" /> : byTitle ? <div className="p-4"><OrgTree everyone={people.map(toTreePerson)} /></div> : (
              <div className="overflow-x-auto scroll-thin">
                <table className="table table-fixed">
                  <colgroup><col style={{ width: '24%' }} /><col style={{ width: '8%' }} /><col style={{ width: '10%' }} /><col style={{ width: '15%' }} /><col style={{ width: '17%' }} /><col style={{ width: '14%' }} /><col style={{ width: '12%' }} /></colgroup>
                  <thead><tr><th>Person</th><th>Tier</th><th>Type</th><th>Next in the CRM</th><th>Campaign</th><th>Sequence</th><th>Last touch</th></tr></thead>
                  <tbody>
                    {people.map((p) => {
                      const m = primaryMembership(membership.get(p.id));
                      const label = m ? membershipLabel(m) : null;
                      return <tr key={p.id}>
                        <td><IdentityCell name={p.name} href={`/people/${p.id}`} shape="circle" size={28} sub={p.jobTitle} /></td>
                        <td><TierBadge tier={p.tier} /></td>
                        <td className="text-[12.5px]">{optionLabels(p.contactType, ' / ') || <Empty />}</td>
                        <td className="text-[12px]">{p.nextAction || p.nextActionDueDate ? <><div className="max-w-[10rem] truncate text-ink-700">{p.nextAction ?? '-'}</div>{p.nextActionDueDate ? <div className="text-ink-500">{formatLocalDate(p.nextActionDueDate)}</div> : null}</> : <Empty />}</td>
                        <td className="text-[12.5px]">{m && label ? <><div className="truncate font-medium text-ink-900"><Link href={`/campaigns/${m.campaignId}`} className="hover:text-brand-700">{m.campaignName}</Link></div><Badge tone={label.tone}>{label.label}</Badge></> : p.dnd || p.optedOut ? <Badge tone="red">Do not contact</Badge> : <Empty />}</td>
                        <td className="text-[12.5px]">{m ? <><div className="truncate text-ink-900"><Link href={`/sequences/${m.sequenceId}`} className="hover:text-brand-700">{m.sequenceName}</Link></div><div className="text-[12px] text-ink-500">{m.step === null ? 'Not started' : `Step ${m.step + 1} of ${m.steps}`}{p.enrollment?.foName ? <> · <span className="whitespace-nowrap">{p.enrollment.foName}</span></> : null}</div></> : <Empty />}</td>
                        <td className="whitespace-nowrap text-[12px] text-ink-500">{p.lastTouchAt ? <>{formatInstant(p.lastTouchAt, user.timezone)}<div className="text-ink-400">{p.touches} touch{p.touches === 1 ? '' : 'es'}</div></> : <Empty />}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Surface>
        ) : null}

        {tab === 'activity' ? <Card title="Activity"><ActivityFeed items={feed} timezone={user.timezone} today={today} showPerson empty="Emails, calls, meetings, steps and campaign changes for everyone at this account appear here." /></Card> : null}

        {tab === 'work' ? (
          <Card title={`Campaigns (${campaigns.length})`}>
            {campaigns.length === 0 ? (
              <EmptyState title="No campaigns have touched this account" hint="Enrol someone here from People, or start a campaign for this pod." action={<Link href="/campaigns/new" className="btn-secondary">New campaign</Link>} />
            ) : (
              <table className="table">
                <thead><tr><th>Campaign</th><th>Sequence</th><th>Status</th><th className="num">People here</th><th className="num">Replied</th></tr></thead>
                <tbody>
                  {campaigns.map((c) => <tr key={c.id}>
                    <td><Link href={`/campaigns/${c.id}`} className="font-medium text-brand-700 hover:underline">{c.name}</Link></td>
                    <td className="text-[12.5px]">{c.sequenceName}</td>
                    <td><Badge tone={CAMPAIGN_TONE[c.status] ?? 'gray'}>{campaignStatusLabel(c.status)}</Badge></td>
                    <td className="num"><Count value={c.people} /></td>
                    <td className="num"><Count value={c.replied} /></td>
                  </tr>)}
                </tbody>
              </table>
            )}
          </Card>
        ) : null}

        {tab === 'meetings' ? (
          <Surface flush>
            {meetings.length === 0 ? (
              <EmptyState title="No meetings with this account yet" action={canCreateMeeting(user) && !blocked ? <Link href={`/meetings/new?account=${company.id}`} className="btn-primary btn-sm"><IconPlus size={13} /> Meeting</Link> : undefined} />
            ) : (
              <div className="overflow-x-auto scroll-thin">
                <table className="table table-dense w-full table-fixed">
                  <colgroup>{['46%', '22%', '18%', '14%'].map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
                  <thead><tr><th>Meeting</th><th>Date</th><th>Attendees</th><th>Transcript</th></tr></thead>
                  <tbody>
                    {meetings.map((m) => <tr key={m.id}>
                      <td><Link href={`/meetings/${m.id}`} className="block truncate text-[13px] font-medium text-ink-900 hover:text-brand-700">{m.title}</Link></td>
                      <td className="text-[12.5px]">{formatLocalDate(meetingDay(m.occurredAt), 'long')}</td>
                      <td className="text-[12.5px]"><span className="flex items-center gap-2 whitespace-nowrap"><span className="tabular-nums text-ink-900">{m.attendees.length}</span>{m.attendees.filter((a) => a.external).length ? <Badge tone="green">{m.attendees.filter((a) => a.external).length} external</Badge> : null}</span></td>
                      <td>{m.transcript ? <Badge tone="blue">Transcript</Badge> : <Empty />}</td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
            )}
          </Surface>
        ) : null}

        {tab === 'tasks' ? <>
          {upcomingHere.length ? <Card title="Starting soon">
            <div className="divide-y divide-line">{upcomingHere.map((m) => <div key={m.campaignId} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]"><Badge tone="purple">Upcoming</Badge><Link href={`/campaigns/${m.campaignId}`} className="font-medium text-ink-900 hover:text-brand-700">{m.campaignName}</Link><span className="text-ink-500">starts {formatLocalDate(m.startDate, 'long')} · {[...membership.values()].flat().filter((x) => x.campaignId === m.campaignId).length} here</span></div>)}</div>
          </Card> : null}
          <Card title={`Open tasks (${dueSoon.length})`}>
            {dueSoon.length === 0 ? <EmptyState title="No open tasks for this account" /> : (
              <table className="table">
                <thead><tr><th>Person</th><th>Task</th><th>Due</th><th>FO</th></tr></thead>
                <tbody>
                  {dueSoon.map((t) => <tr key={t.id}>
                    <td><Link href={`/people/${t.personId}`} className="font-medium text-ink-900 hover:text-brand-700">{t.personName}</Link></td>
                    <td className="text-[12.5px]"><span className="inline-flex items-center gap-1.5"><ActionIcon action={t.action} size={13} className="text-ink-500" />{t.label}</span></td>
                    <td className={t.due < today ? 'font-medium text-red-600' : undefined}>{formatLocalDate(t.due)}</td>
                    <td className="whitespace-nowrap text-[12.5px]">{t.foName}</td>
                  </tr>)}
                </tbody>
              </table>
            )}
          </Card>
        </> : null}
      </div>
    </>
  );
}

