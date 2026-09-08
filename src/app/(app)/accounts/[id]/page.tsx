import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { canEnroll } from '@/lib/auth/rbac';
import { accountDetail } from '@/lib/accounts-query';
import { formatInstant, formatLocalDate, todayIn } from '@/lib/dates';
import { syncAccountAction } from '@/lib/actions/accounts';
import { ActionButton } from '@/components/action-form';
import { OrgTree, type TreeNode, type TreePerson } from '@/components/accounts/org-tree';
import { ActionIcon, IconExternal, IconPlus } from '@/components/icons';
import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  ENROLLMENT_TONE,
  enrollmentStatusLabel,
  IdentityCell,
  KeyValue,
  RecordHeader,
  Stat,
  Surface,
  Tabs,
  type BadgeTone,
} from '@/components/ui';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'relationships', label: 'Relationship map' },
  { key: 'people', label: 'People' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'work', label: 'Campaigns and tasks' },
];

export default async function AccountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { tab = 'overview' } = await searchParams;
  const detail = await accountDetail(id, user);
  if (!detail) notFound();
  const { company, people, tree, meetings, campaigns, timeline, openTasks, stats, ownerName } = detail;
  const today = todayIn(user.timezone);
  const editable = canEnroll(toActor(user));

  const toTreePerson = (p: (typeof people)[number]): TreePerson => ({
    id: p.id,
    name: p.name,
    jobTitle: p.jobTitle,
    reportsToId: p.reportsToId,
    accountRole: p.accountRole,
    relationshipNote: p.relationshipNote,
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
  const roots: TreeNode[] = tree.roots.map(function map(n): TreeNode {
    return { person: toTreePerson(n.person), children: n.children.map(map) };
  });

  return (
    <>
      <div className="px-6 pt-2">
        <RecordHeader
          name={company.name}
          shape="square"
          sub={
            <>
              {[company.industry, company.city, company.employees ? `${company.employees} employees` : null].filter(Boolean).join(' · ') || 'Twenty account'}
              {ownerName ? ` · owned by ${ownerName}` : ''}
              {company.syncedAt ? ` · synced ${formatInstant(company.syncedAt, user.timezone)}` : ''}
            </>
          }
          badges={
            <>
              {detail.mine ? <Badge tone="blue">mine</Badge> : null}
              <Badge tone="gray">{stats.people} people</Badge>
              {stats.inSequence ? <Badge tone="green" dot>{stats.inSequence} in sequence</Badge> : null}
            </>
          }
          actions={
            <>
              {company.domain ? (
                <a href={company.domain.startsWith('http') ? company.domain : `https://${company.domain}`} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">
                  <IconExternal size={13} /> Website
                </a>
              ) : null}
              <Link href={`/meetings/new?account=${company.id}`} className="btn-secondary btn-sm">
                <IconPlus size={13} /> Meeting
              </Link>
              <ActionButton action={syncAccountAction} payload={{ companyId: company.id }} className="btn-secondary btn-sm">
                Sync from Twenty
              </ActionButton>
              <Link href="/accounts" className="btn-ghost btn-sm">
                All accounts
              </Link>
            </>
          }
        />
      </div>

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
              <Stat label="In sequence" value={stats.inSequence} />
              <Stat label="Replied" value={stats.replied} tone="good" />
              <Stat label="Meetings" value={stats.meetings} />
              <Stat label="Touches" value={stats.touches} />
              <Stat label="Open tasks" value={stats.openTasks} tone={stats.openTasks ? 'warn' : 'default'} />
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <Card title="Account details">
                <div className="p-4">
                  <KeyValue
                    items={[
                      { k: 'Name', v: company.name },
                      { k: 'Domain', v: company.domain },
                      { k: 'Industry', v: company.industry },
                      { k: 'City', v: company.city },
                      { k: 'Employees', v: company.employees },
                      { k: 'Owner', v: ownerName },
                      { k: 'LinkedIn', v: company.linkedinUrl },
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
                        <span className={it.tone === 'in' ? 'mt-0.5 text-emerald-600' : it.tone === 'out' ? 'mt-0.5 text-ink-400' : 'mt-0.5 text-ink-300'}>
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
                          <span className="block truncate text-[11.5px] text-ink-400">{[it.personName, it.detail].filter(Boolean).join(' · ')}</span>
                        </span>
                        <span className="shrink-0 text-[11px] text-ink-400">{formatInstant(it.at, user.timezone)}</span>
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
              <EmptyState title="Nobody at this account yet" hint="Sync from Twenty to pull its people in." />
            ) : (
              <OrgTree roots={roots} orphans={tree.orphans.map(toTreePerson)} everyone={everyone} editable={editable} />
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
                      <th>Stance</th>
                      <th>Reports to</th>
                      <th>Sequence</th>
                      <th>FO</th>
                      <th>Touches</th>
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
                          <Badge tone={p.accountRole === 'CHAMPION' ? 'green' : p.accountRole === 'SUPPORTER' ? 'blue' : p.accountRole === 'DETRACTOR' ? 'red' : 'gray'} dot>
                            {p.accountRole.toLowerCase()}
                          </Badge>
                        </td>
                        <td className="text-[12.5px]">{p.reportsToId ? people.find((o) => o.id === p.reportsToId)?.name ?? '-' : <span className="text-ink-300">-</span>}</td>
                        <td>
                          {p.enrollment ? (
                            <Badge tone={ENROLLMENT_TONE[p.enrollment.status] ?? 'gray'}>{enrollmentStatusLabel(p.enrollment)}</Badge>
                          ) : (
                            <span className="text-[12px] text-ink-300">-</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap text-[12.5px]">{p.enrollment?.foName ?? <span className="text-ink-300">-</span>}</td>
                        <td>{p.touches}</td>
                        <td className="whitespace-nowrap text-[12px] text-ink-500">{p.lastTouchAt ? formatInstant(p.lastTouchAt, user.timezone) : <span className="text-ink-300">never</span>}</td>
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
                    <span className={it.tone === 'in' ? 'mt-0.5 text-emerald-600' : it.tone === 'out' ? 'mt-0.5 text-ink-400' : 'mt-0.5 text-ink-300'}>
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
                      <span className="block text-[11.5px] text-ink-400">
                        {[it.personName, it.detail].filter(Boolean).join(' · ')}
                        <span className="ml-1.5 rounded bg-canvas px-1 text-[10px] uppercase tracking-wide">{it.kind}</span>
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] text-ink-400">{formatInstant(it.at, user.timezone)}</span>
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
                <EmptyState title="No campaigns have touched this account" />
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Sequence</th>
                      <th>Status</th>
                      <th>People here</th>
                      <th>Replied</th>
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
                          <Badge tone="gray">{c.status.toLowerCase()}</Badge>
                        </td>
                        <td>{c.people}</td>
                        <td>{c.replied}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card title={`Open tasks (${openTasks.length})`}>
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
                    {openTasks.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <Link href={`/people/${t.personId}`} className="font-medium text-ink-900 hover:text-brand-700">
                            {t.personName}
                          </Link>
                        </td>
                        <td className="text-[12.5px]">
                          <span className="inline-flex items-center gap-1.5">
                            <ActionIcon action={t.action} size={13} className="text-ink-400" />
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

            <Card title={`Meetings (${meetings.length})`} actions={<Link href={`/meetings/new?account=${company.id}`} className="btn-ghost btn-sm">Add</Link>}>
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
                        <span className="block text-[11.5px] text-ink-400">
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
      </div>
    </>
  );
}
