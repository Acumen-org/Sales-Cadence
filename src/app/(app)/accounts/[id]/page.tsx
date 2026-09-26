import { canCreateMeeting, isAdmin } from '@/lib/auth/rbac';
import { ActionButton } from '@/components/action-form';
import { blockAccountAction, unblockAccountAction } from '@/lib/actions/blocked-accounts';
import Link from 'next/link';
import { RecordSync } from '@/components/record-sync';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { accountDetail } from '@/lib/accounts-query';
import { addDays, formatInstant, formatLocalDate, todayIn } from '@/lib/dates';
import { accentFor } from '@/lib/accent';
import { membershipFor, membershipLabel, primaryMembership } from '@/lib/campaign-membership';
import { OrgTree, type TreePerson } from '@/components/accounts/org-tree';
import { ActionIcon, IconExternal, IconLock, IconPlus } from '@/components/icons';
import { Avatar, Badge, CAMPAIGN_TONE, Card, Count, ENROLLMENT_TONE, Empty, EmptyState, EventDetail, IdentityCell, KeyValue, RecordHeader, Stat, Surface, Tabs, TierBadge, enrollmentStatusLabel, type BadgeTone } from '@/components/ui';
import { campaignStatusLabel } from '@/lib/campaign-status';
import { optionLabels } from '@/lib/twenty/labels';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'relationships', label: 'People by title' },
  { key: 'people', label: 'People' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'work', label: 'Campaigns' },
  { key: 'meetings', label: 'Meetings' },
  { key: 'tasks', label: 'Tasks' },
];

export default async function AccountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { tab = 'overview' } = await searchParams;
  const detail = await accountDetail(id, user);
  if (!detail) notFound();
  const { company, people, meetings, campaigns, timeline, openTasks, stats, ownerName, blocked } = detail;
  const today = todayIn(user.timezone);

  const toTreePerson = (p: (typeof people)[number]): TreePerson => ({
    id: p.id,
    name: p.name,
    jobTitle: p.jobTitle,
    dnd: p.dnd,
    optedOut: p.optedOut,
    enrollment: p.enrollment
      ? {
          status: p.enrollment.status,
          label: enrollmentStatusLabel(p.enrollment),
          tone: (ENROLLMENT_TONE[p.enrollment.status] ?? 'gray') as BadgeTone,
          foName: p.enrollment.foName,
          stepIndex: p.enrollment.stepIndex,
          steps: p.enrollment.steps,
        }
      : null,
    lastTouch: p.lastTouchAt ? formatInstant(p.lastTouchAt, user.timezone) : null,
    touches: p.touches,
  });
  const everyone = people.map(toTreePerson);
  const membership = await membershipFor(people.map((p) => p.id));
  const upcomingHere = [...new Map([...membership.values()].flat().filter((m) => m.kind === 'upcoming').map((m) => [m.campaignId, m])).values()];
  const accent = accentFor(company.id);
  const horizon = addDays(today, 30);

  return (
    <>
      <RecordSync kind="company" id={company.id} />
      <div className="px-6 pt-2">
        <RecordHeader
          name={company.name}
          shape="square"
          accent={accent}
          seed={company.id}
          badges={
            <>
              {detail.mine ? <Badge tone="blue">mine</Badge> : null}
              <Badge tone="gray">{stats.people} people</Badge>
              {stats.inSequence ? <Badge tone="green" dot>{stats.inSequence} in a campaign</Badge> : null}
            </>
          }
          actions={
            <>
              {company.domain ? (
                <a href={company.domain.startsWith('http') ? company.domain : `https://${company.domain}`} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">
                  <IconExternal size={13} /> Website
                </a>
              ) : null}
              {canCreateMeeting(user) && !blocked && <Link href={`/meetings/new?account=${company.id}`} className="btn-secondary btn-sm">
                <IconPlus size={13} /> Meeting
              </Link>}
              {isAdmin(user) ? (
                blocked ? (
                  <ActionButton action={unblockAccountAction} payload={{ companyId: company.id }} confirm={`Put ${company.name} back in Cadence?`}>
                    Unblock account
                  </ActionButton>
                ) : (
                  <ActionButton
                    action={blockAccountAction}
                    payload={{ companyId: company.id }}
                    confirm={`Block ${company.name}? It leaves Accounts, People, search and enrichment for everyone, and any sequence its people are in ends.`}
                    className="btn-secondary btn-sm !border-red-200 !text-red-700 hover:!bg-red-50"
                  >
                    <IconLock size={13} /> Block account
                  </ActionButton>
                )
              ) : null}
              <Link href="/accounts" className="btn-ghost btn-sm">
                All accounts
              </Link>
            </>
          }
        />
      </div>

      {blocked ? (
        <div className="px-6 pt-3">
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50/70 px-4 py-3 text-[13px] text-red-800">
            <IconLock size={15} />
            <span className="font-medium">Blocked account</span>
            <span className="text-red-700">
              {blocked.byName ? `${blocked.byName} · ` : ''}{formatInstant(blocked.at, user.timezone)}
              {blocked.reason ? ` · ${blocked.reason}` : ''}
            </span>
          </div>
        </div>
      ) : null}

      <div className="px-6 pt-3">
        <Surface flush>
          <Tabs inset={false} current={tab} tabs={TABS.map((t) => ({ ...t, href: `/accounts/${id}?tab=${t.key}` }))} />
        </Surface>
      </div>

      <div className="space-y-3 px-6 pb-8 pt-3">
        {tab === 'overview' ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="People" value={stats.people} />
              <Stat label="In a campaign" value={stats.inSequence} />
              <Stat label="Replies" value={stats.replied} />
              <Stat label="Meetings" value={stats.meetings} />
              <Stat label="Touches" value={stats.touches} />
              <Stat label="Open tasks" value={stats.openTasks} />
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <Card title="Account details">
                <div className="p-4">
                  <KeyValue
                    items={[
                      { k: 'Domain', v: company.domain },
                      { k: 'Industry', v: company.industry },
                      { k: 'City', v: company.city },
                      { k: 'Employees', v: company.employees },
                      { k: 'AUM', v: company.aum ? company.aum.toNumber().toLocaleString('en-US', { maximumFractionDigits: 0 }) : null },
                      { k: 'Owner', v: ownerName },
                      // The handle, not the whole URL set in bold, matching the person record.
                      { k: 'LinkedIn', v: company.linkedinUrl ? <a href={company.linkedinUrl} target="_blank" rel="noreferrer" title={company.linkedinUrl} className="text-brand-700 hover:underline">{company.linkedinUrl.replace(/^https?:\/\/(www\.)?linkedin\.com\//i, '')}</a> : null },
                      { k: 'Last synced', v: company.syncedAt ? formatInstant(company.syncedAt, user.timezone) : null },
                      { k: 'Twenty id', v: <span className="font-mono text-[11px]">{company.id}</span> },
                    ]}
                  />
                </div>
              </Card>
              <Card title="Recent activity" actions={<Link href={`/accounts/${id}?tab=timeline`} className="btn-ghost btn-sm">View all</Link>}>
                {timeline.length === 0 ? (
                  <EmptyState title="Nothing recorded yet" />
                ) : (
                  <ul className="divide-y divide-line">
                    {timeline.slice(0, 8).map((it, i) => (
                      <li key={i} className="flex items-start gap-2.5 px-4 py-2.5 text-[13px]">
                        <span className={it.tone === 'in' ? 'mt-0.5 text-emerald-600' : it.tone === 'out' ? 'mt-0.5 text-ink-500' : 'mt-0.5 text-ink-300'}>
                          {it.icon === 'MEETING' || it.icon === 'STATE' ? <span className="inline-block h-3.5 w-3.5 rounded-full border border-current" /> : <ActionIcon action={it.icon} size={14} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          {it.href ? (
                            <Link href={it.href} className="text-ink-800 hover:text-brand-700">
                              {it.title}
                            </Link>
                          ) : (
                            <span className="text-ink-800">{it.title}</span>
                          )}
                          {it.personName ? <span className="block truncate text-[12px] font-medium text-ink-900">{it.personName}</span> : null}
                          <EventDetail fields={it.fields} className="mt-0.5" />
                        </span>
                        <span className="shrink-0 text-[11px] text-ink-500">{formatInstant(it.at, user.timezone)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </>
        ) : null}

        {tab === 'relationships' ? (
          <Surface>
            {everyone.length === 0 ? (
              <EmptyState title="Nobody at this account yet"  />
            ) : (
              <OrgTree everyone={everyone} />
            )}
          </Surface>
        ) : null}

        {tab === 'people' ? (
          <Surface flush>
            {people.length === 0 ? (
              <EmptyState title="Nobody at this account yet" />
            ) : (
              <div className="overflow-x-auto scroll-thin">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th>Tier</th>
                      <th>Type</th>
                      <th>Next in Twenty</th>
                      <th>Campaign</th>
                      <th>Sequence</th>
                      <th className="num">Touches</th>
                      <th>Last touch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {people.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <IdentityCell name={p.name} href={`/people/${p.id}`} shape="circle" size={28} sub={p.jobTitle} />
                        </td>
                        <td>
                          <TierBadge tier={p.tier} />
                        </td>
                        <td className="text-[12.5px]">{optionLabels(p.contactType, ' / ') || <Empty />}</td>
                        <td className="text-[12px]">
                          {p.nextAction || p.nextActionDueDate ? (
                            <>
                              <div className="max-w-[10rem] truncate text-ink-700">{p.nextAction ?? '-'}</div>
                              {p.nextActionDueDate ? <div className=" text-ink-500">{formatLocalDate(p.nextActionDueDate)}</div> : null}
                            </>
                          ) : (
                            <Empty />
                          )}
                        </td>
                        {(() => {
                          const m = primaryMembership(membership.get(p.id));
                          const label = m ? membershipLabel(m) : null;
                          return <>
                            <td className="text-[12.5px]">{m && label ? <><div className="truncate font-medium text-ink-900"><Link href={`/campaigns/${m.campaignId}`} className="hover:text-brand-700">{m.campaignName}</Link></div><Badge tone={label.tone}>{label.label}</Badge></> : <Empty />}</td>
                            <td className="text-[12.5px]">{m ? <><div className="truncate text-ink-900"><Link href={`/sequences/${m.sequenceId}`} className="hover:text-brand-700">{m.sequenceName}</Link></div><div className="text-[12px] text-ink-500">{m.step === null ? 'Not started' : `Step ${m.step + 1} of ${m.steps}`}{p.enrollment?.foName ? ` · ${p.enrollment.foName}` : ''}</div></> : <Empty />}</td>
                          </>;
                        })()}
                        <td className="num"><Count value={p.touches} /></td>
                        <td className="whitespace-nowrap text-[12px] text-ink-500">{p.lastTouchAt ? formatInstant(p.lastTouchAt, user.timezone) : <Empty />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Surface>
        ) : null}

        {tab === 'timeline' ? (
          <Surface flush>
            {timeline.length === 0 ? (
              <EmptyState title="Nothing recorded yet" hint="Emails, calls, meetings, tasks and sequence changes for everyone at this account appear here." />
            ) : (
              <ol className="divide-y divide-line">
                {timeline.map((it, i) => (
                  <li key={i} className="flex items-start gap-3 px-4 py-3 text-[13px]">
                    <span className={it.tone === 'in' ? 'mt-0.5 text-emerald-600' : it.tone === 'out' ? 'mt-0.5 text-ink-500' : 'mt-0.5 text-ink-300'}>
                      {it.icon === 'MEETING' || it.icon === 'STATE' ? <span className="inline-block h-3.5 w-3.5 rounded-full border border-current" /> : <ActionIcon action={it.icon} size={14} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      {it.href ? (
                        <Link href={it.href} className="font-medium text-ink-800 hover:text-brand-700">
                          {it.title}
                        </Link>
                      ) : (
                        <span className="font-medium text-ink-800">{it.title}</span>
                      )}
                      {it.personName ? <span className="mt-0.5 block text-[12px] font-medium text-ink-900">{it.personName}</span> : null}
                      <EventDetail fields={it.fields} className="mt-0.5" />
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1.5">
                      <span className="text-[11px] text-ink-500">{formatInstant(it.at, user.timezone)}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Surface>
        ) : null}

        {tab === 'work' ? (
          <div className="space-y-3">
            <Card title={`Campaigns (${campaigns.length})`}>
              {campaigns.length === 0 ? (
                <EmptyState title="No campaigns have touched this account" hint="Enrol someone here from People, or start a campaign for this pod." action={<Link href="/campaigns/new" className="btn-secondary">New campaign</Link>} />
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Sequence</th>
                      <th>Status</th>
                      <th className="num">People here</th>
                      <th className="num">Replied</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <Link href={`/campaigns/${c.id}`} className="font-medium text-brand-700 hover:underline">
                            {c.name}
                          </Link>
                        </td>
                        <td className="text-[12.5px]">{c.sequenceName}</td>
                        <td>
                          <Badge tone={CAMPAIGN_TONE[c.status] ?? 'gray'}>{campaignStatusLabel(c.status)}</Badge>
                        </td>
                        <td className="num"><Count value={c.people} /></td>
                        <td className="num"><Count value={c.replied} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>



            <Card title={`Meetings (${meetings.length})`} actions={canCreateMeeting(user) && <Link href={`/meetings/new?account=${company.id}`} className="btn-ghost btn-sm">Add</Link>}>
              {meetings.length === 0 ? (
                <EmptyState title="No meetings recorded" hint="Paste a Teams, Zoom or Meet recording link to keep it with the account." />
              ) : (
                <ul className="divide-y divide-line">
                  {meetings.map((m) => (
                    <li key={m.id} className="flex items-center gap-3 px-4 py-2.5">
                      <Avatar name={m.title} size={28} />
                      <span className="min-w-0 flex-1">
                        <Link href={`/meetings/${m.id}`} className="block truncate text-[13px] font-medium text-ink-900 hover:text-brand-700">
                          {m.title}
                        </Link>
                        <span className="block text-[11.5px] text-ink-500">
                          {formatInstant(m.occurredAt, user.timezone)} · {m.attendees.filter((a) => a.external).length} external
                        </span>
                      </span>
                      {m.transcript ? <Badge tone="blue">transcript</Badge> : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        ) : null}
        {tab === 'meetings' ? (
          <Surface flush>
            {meetings.length === 0 ? (
              <EmptyState title="No meetings with this account yet" action={canCreateMeeting(user) && !blocked ? <Link href={`/meetings/new?account=${company.id}`} className="btn-primary btn-sm"><IconPlus size={13} /> Meeting</Link> : undefined} />
            ) : (
              <div className="overflow-x-auto scroll-thin">
                <table className="table table-dense w-full table-fixed">
                  <colgroup>{['40%', '20%', '16%', '12%', '12%'].map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
                  <thead><tr><th>Meeting</th><th>When</th><th>Attendees</th><th>Transcript</th><th>Length</th></tr></thead>
                  <tbody>
                    {meetings.map((m) => <tr key={m.id}>
                      <td><Link href={`/meetings/${m.id}`} className="block truncate text-[13px] font-medium text-ink-900 hover:text-brand-700">{m.title}</Link></td>
                      <td className="text-[12.5px]">{formatInstant(m.occurredAt, user.timezone)}</td>
                      <td className="text-[12.5px]"><span className="flex items-center gap-2 whitespace-nowrap"><span className="tabular-nums text-ink-900">{m.attendees.length}</span>{m.attendees.filter((a) => a.external).length ? <Badge tone="green">{m.attendees.filter((a) => a.external).length} external</Badge> : null}</span></td>
                      <td>{m.transcript ? <Badge tone="blue">Transcript</Badge> : <Empty />}</td>
                      <td className="text-[12.5px] tabular-nums">{m.durationSec ? `${Math.round(m.durationSec / 60)} min` : <Empty />}</td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
            )}
          </Surface>
        ) : null}

        {tab === 'tasks' ? (
          <>
            {upcomingHere.length ? <Card title="Starting soon">
              <div className="divide-y divide-line">{upcomingHere.map((m) => <div key={m.campaignId} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]"><Badge tone="purple">Upcoming</Badge><Link href={`/campaigns/${m.campaignId}`} className="font-medium text-ink-900 hover:text-brand-700">{m.campaignName}</Link><span className="text-ink-500">starts {formatLocalDate(m.startDate, 'long')} · {[...membership.values()].flat().filter((x) => x.campaignId === m.campaignId).length} here</span></div>)}</div>
            </Card> : null}
            <Card title={`Open tasks (${openTasks.filter((t) => t.due <= horizon).length})`}>
              {openTasks.length === 0 ? (
                <EmptyState title="No open tasks for this account" />
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th>Task</th>
                      <th>Due</th>
                      <th>FO</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openTasks.filter((t) => t.due <= horizon).sort((a, b) => a.due.localeCompare(b.due)).map((t) => (
                      <tr key={t.id}>
                        <td>
                          <Link href={`/people/${t.personId}`} className="font-medium text-ink-900 hover:text-brand-700">
                            {t.personName}
                          </Link>
                        </td>
                        <td className="text-[12.5px]">
                          <span className="inline-flex items-center gap-1.5">
                            <ActionIcon action={t.action} size={13} className=" text-ink-500" />
                            {t.label}
                          </span>
                        </td>
                        <td className={t.due < today ? 'font-medium text-red-600' : undefined}>{formatLocalDate(t.due)}</td>
                        <td className="whitespace-nowrap text-[12.5px]">{t.foName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        ) : null}
      </div>
    </>
  );
}
