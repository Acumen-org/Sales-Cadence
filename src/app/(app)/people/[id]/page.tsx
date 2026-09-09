import Link from 'next/link';
import { accountScopeCompanyIds } from '@/lib/accounts-query';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { prisma } from '@/lib/db';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { cachedPersonName, upsertPersonCache } from '@/lib/person-cache';
import { auditDetailText, describeAudit } from '@/lib/audit-format';
import { describeStep, parseSteps } from '@/lib/sequences/steps';
import { getTwentyConnection } from '@/lib/settings';
import { getTwentyClient } from '@/lib/twenty';
import type { TwentyNote, TwentyOpportunity } from '@/lib/twenty/types';
import { twentyPersonUrl } from '@/lib/twenty/urls';
import { CrmHistory } from '@/components/people/crm-history';
import { ActionIcon, IconExternal } from '@/components/icons';
import { optionLabel, optionLabels } from '@/lib/twenty/labels';
import { Avatar, Badge, Card, contactWarnings, crmStanding, ENROLLMENT_TONE, enrollmentStatusLabel, KeyValue, RecordHeader, Surface, Tabs, TierBadge } from '@/components/ui';

type TimelineItem = { at: Date; kind: 'touch' | 'note' | 'task' | 'state'; icon: string; title: string; detail?: string | null; tone?: 'in' | 'out' | 'neutral' };

export default async function PersonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; crmNotes?: string; crmEmails?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const requested = sp.tab;
  const tab = requested === 'activity' || requested === 'sequences' || requested === 'crm' ? requested : 'overview';
  let person = await prisma.personCache.findUnique({ where: { id } });
  // Instant sync: re-read this person from Twenty on every visit so CRM edits show immediately,
  // even between webhooks. Failures fall back to the cache.
  let liveWarning: string | null = null;
  try {
    const client = await getTwentyClient();
    const fresh = await client.getPerson(id);
    if (fresh) {
      await upsertPersonCache(fresh);
      person = await prisma.personCache.findUnique({ where: { id } });
    }
  } catch (err) {
    liveWarning = `Showing cached data; Twenty unavailable (${err instanceof Error ? err.message : String(err)}).`;
  }
  if (!person) notFound();

  const [enrollments, touches, tasks, audit, conn, pods, colleagues] = await Promise.all([
    prisma.enrollment.findMany({
      where: { personId: id },
      include: { fo: { select: { id: true, name: true } }, sequence: true, campaign: { select: { id: true, name: true, status: true } }, pod: { include: { users: { include: { user: { select: { id: true, name: true, active: true } } } } } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.touch.findMany({ where: { personId: id }, orderBy: { occurredAt: 'desc' } }),
    prisma.task.findMany({ where: { enrollment: { personId: id } }, include: { fo: { select: { name: true } } }, orderBy: [{ stepIndex: 'asc' }, { actionIndex: 'asc' }] }),
    prisma.auditLog.findMany({ where: { OR: [{ entityType: 'person', entityId: id }, { entityType: 'enrollment', entityId: { in: (await prisma.enrollment.findMany({ where: { personId: id }, select: { id: true } })).map((e) => e.id) } }] }, orderBy: { createdAt: 'desc' } }),
    getTwentyConnection(),
    prisma.pod.findMany({ include: { users: { include: { user: { select: { id: true, name: true, active: true } } } } }, orderBy: { name: 'asc' } }),
    person.companyId ? prisma.personCache.findMany({ where: { companyId: person.companyId, id: { not: id }, deletedAt: null }, include: { enrollments: { orderBy: { createdAt: 'desc' }, take: 1 } }, take: 30 }) : Promise.resolve([]),
  ]);

  let notes: TwentyNote[] = [];
  let opportunities: TwentyOpportunity[] = [];
  let twentyWarning: string | null = null;
  try {
    const client = await getTwentyClient();
    [notes, opportunities] = await Promise.all([client.listNotes({ personId: id, limit: 20 }).then((p) => p.items), client.listOpportunities({ personId: id }).then((p) => p.items)]);
  } catch (err) {
    twentyWarning = `Twenty unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Accounts are pod-scoped even though people are not, so the company is only a link when this
  // viewer can actually open it. A rendered link that leads to not-found is worse than plain text.
  const accountScope = person.companyId ? await accountScopeCompanyIds(user) : null;
  const canOpenAccount = Boolean(person.companyId) && (accountScope === null || accountScope.includes(person.companyId!));

  const currentEnrollments = enrollments.filter((e) => e.status === 'ACTIVE' || e.status === 'PAUSED');
  // With nothing running, how the last engagement ended is the fact that decides what to do next,
  // so the card carries it rather than reading as if this person had never been worked.
  const lastFinished = currentEnrollments.length ? null : enrollments.find((e) => e.status !== 'ACTIVE' && e.status !== 'PAUSED') ?? null;
  const standing = crmStanding(person);
  const warnings = contactWarnings(person);
  const podName = person.podOwner ? pods.find((x) => x.podOwnerValue === person.podOwner)?.name ?? optionLabel(person.podOwner) : null;
  const ownerName = person.ownerMemberId ? (await prisma.user.findFirst({ where: { twentyMemberId: person.ownerMemberId }, select: { name: true } }))?.name ?? null : null;
  const twentyUrl = twentyPersonUrl(conn.baseUrl, id);
  // Unified timeline
  const items: TimelineItem[] = [
    ...touches.map<TimelineItem>((t) => ({ at: t.occurredAt, kind: 'touch', icon: t.channel, title: t.summary, detail: t.actorLabel, tone: t.direction === 'INBOUND' ? 'in' : 'out' })),
    ...notes
      .filter((n) => !touches.some((t) => t.externalId.startsWith(`note:${n.id}:`)))
      .map<TimelineItem>((n) => ({ at: new Date(n.createdAt), kind: 'note', icon: 'NOTE', title: n.title, detail: n.bodyMarkdown ?? n.createdByName, tone: 'neutral' })),
    ...tasks
      .filter((t) => t.state === 'SKIPPED' || (t.state === 'DONE' && !touches.some((x) => x.externalId === `task:${t.id}` || x.externalId === t.evidenceId)))
      .map<TimelineItem>((t) => ({ at: t.completedAt ?? t.updatedAt, kind: 'task', icon: t.action, title: `${t.label} ${t.state === 'DONE' ? 'done' : 'skipped'}${t.disposition ? ` - ${t.disposition}` : ''}${t.skipReason ? `: ${t.skipReason}` : ''}`, detail: t.note ?? t.fo.name, tone: 'out' })),
    ...audit
      .filter((a) => ['enrolled', 'replied', 'meeting', 'exited', 'completed', 'paused', 'resumed', 'finished', 'moved_to_step', 'flags_updated', 'reassigned'].includes(a.action))
      .map<TimelineItem>((a) => {
        const { title, fields } = describeAudit(a.action, a.details as Record<string, unknown> | null, a.actorLabel);
        return { at: a.createdAt, kind: 'state', icon: 'STATE', title, detail: auditDetailText(fields), fields, tone: 'neutral' };
      }),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'sequences', label: 'Campaigns & sequences', count: enrollments.length },
    { key: 'activity', label: 'Activity', count: items.length },
    { key: 'crm', label: 'CRM emails & notes' },
  ];

  return (
    <>
      <div className="px-6 pt-2">
        <RecordHeader
          name={cachedPersonName(person)}
          badges={
            <>
              <Badge tone={standing.tone} dot>
                {standing.label}
              </Badge>
              <TierBadge tier={person.tier} />
              {warnings.map((w) => (
                <Badge key={w.label} tone={w.tone}>
                  {w.label}
                </Badge>
              ))}
            </>
          }
          actions={
            <>
              {person.email ? (
                <a href={`mailto:${person.email}`} className="btn-secondary btn-sm">
                  <ActionIcon action="EMAIL" size={13} /> Email
                </a>
              ) : null}
              {person.phone ? (
                <a href={`tel:${person.phone}`} className="btn-secondary btn-sm">
                  <ActionIcon action="CALL" size={13} /> Call
                </a>
              ) : null}
              {person.linkedinUrl ? (
                <a href={person.linkedinUrl} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">
                  <ActionIcon action="LINKEDIN_MESSAGE" size={13} /> LinkedIn
                </a>
              ) : null}
              {twentyUrl ? (
                <a href={twentyUrl} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">
                  <IconExternal size={13} /> Twenty
                </a>
              ) : null}
              <Link href="/people" className="btn-ghost btn-sm">
                All people
              </Link>
            </>
          }
        />
      </div>
      <div className="grid gap-3 px-6 pb-8 pt-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <Surface flush>
            <Tabs inset={false} current={tab} tabs={tabs.map((t) => ({ ...t, href: `/people/${id}?tab=${t.key}` }))} />
          </Surface>
          <div className="pt-3">
            {tab === 'crm' ? <CrmHistory personId={id} timezone={user.timezone} baseHref={`/people/${id}?tab=crm`} notesAfter={sp.crmNotes} emailsAfter={sp.crmEmails} /> : null}
            {tab === 'activity' ? (
              <Card title="Activity">
                {twentyWarning ?? liveWarning ? <div className="px-4 pt-3 text-xs text-amber-700">{twentyWarning ?? liveWarning}</div> : null}
                {items.length === 0 ? (
                  <div className="p-4 text-sm text-ink-500">No activity yet.</div>
                ) : (
                  <ol className="divide-y divide-line">
                    {items.map((it, i) => (
                      <li key={i} className="flex gap-3 px-4 py-2.5 text-sm">
                        <span className={it.tone === 'in' ? 'mt-0.5 text-emerald-600' : it.tone === 'out' ? 'mt-0.5 text-ink-500' : 'mt-0.5 font-semibold text-ink-700'}>
                          {it.icon === 'NOTE' || it.icon === 'STATE' ? <span className="inline-block h-3.5 w-3.5 rounded-full border border-current" /> : <ActionIcon action={it.icon} size={14} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="text-ink-800">{it.title}</span>
                          {it.detail ? <span className="block whitespace-pre-wrap text-sm text-ink-700">{it.detail}</span> : null}
                        </span>
                        <span className="shrink-0 text-xs font-semibold text-ink-700">{formatInstant(it.at, user.timezone)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </Card>
            ) : null}

            {tab === 'sequences' ? (
              <div className="space-y-4">
                {enrollments.length === 0 ? <Card><div className="p-4 text-sm text-ink-500">Never enrolled.</div></Card> : null}
                {enrollments.map((e) => {
                  const steps = parseSteps(e.sequence.steps);
                  const eTasks = tasks.filter((t) => t.enrollmentId === e.id);
                  return (
                    <Card
                      key={e.id}
                      title={<Link href={`/sequences/${e.sequenceId}`} className="font-semibold hover:underline">{e.sequence.name}</Link>}
                      actions={<Badge tone={ENROLLMENT_TONE[e.status] ?? 'gray'}>{enrollmentStatusLabel(e)}</Badge>}
                    >
                      <div className="grid gap-4 border-b border-line bg-canvas/50 p-4 sm:grid-cols-2 lg:grid-cols-4">
                        <div><div className="text-xs text-ink-500">Campaign</div><div className="mt-1 font-semibold text-ink-900">{e.campaign ? <Link href={`/campaigns/${e.campaign.id}`} className="text-brand-700 hover:underline">{e.campaign.name}</Link> : 'Direct enrollment'}</div></div>
                        <div><div className="text-xs text-ink-500">Assigned to</div><div className="mt-1 font-semibold text-ink-900">{e.fo.name}</div></div>
                        <div><div className="text-xs text-ink-500">Started</div><div className="mt-1 font-semibold text-ink-900">{formatLocalDate(e.startDate, 'long')}</div></div>
                        <div><div className="text-xs text-ink-500">Campaign status</div><div className="mt-1 font-semibold capitalize text-ink-900">{e.campaign?.status.toLowerCase() ?? 'Not linked'}</div></div>
                      </div>
                      <ol className="divide-y divide-line">
                        {steps.map((step, i) => {
                          const st = eTasks.filter((t) => t.stepIndex === i);
                          const reached = st.length > 0;
                          return (
                            <li key={step.id} className={`flex items-center gap-3 px-4 py-2 text-sm `}>
                              <span className="w-14 shrink-0 text-xs font-semibold uppercase text-ink-500">Day {step.day}</span>
                              <span className="flex-1 text-ink-800">{describeStep(step)}</span>
                              <span className="flex flex-wrap gap-1">
                                {st.map((t) => (
                                  <Badge key={t.id} tone={t.state === 'DONE' ? 'green' : t.state === 'PENDING' ? 'blue' : t.state === 'SKIPPED' ? 'amber' : 'gray'}>
                                    {t.label}: {t.state === 'PENDING' ? `due ${formatLocalDate(t.snoozedTo ?? t.dueDate)}` : t.state.toLowerCase()}
                                    {t.disposition ? ` (${t.disposition})` : ''}
                                  </Badge>
                                ))}
                                {!reached ? <span className="text-xs font-semibold text-ink-700">not reached</span> : null}
                              </span>
                            </li>
                          );
                        })}
                      </ol>
                    </Card>
                  );
                })}
              </div>
            ) : null}

            {tab === 'overview' ? (
              // Grouped the way the record is grouped in Twenty, so the two read the same.
              <div className="space-y-3">
                {twentyWarning ?? liveWarning ? <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">CRM temporarily unavailable. Showing the last synced record.</div> : null}
                <Card title={currentEnrollments.length || !lastFinished ? 'Current campaigns' : 'Last campaign'} actions={<Link href={`/people/${id}?tab=sequences`} className="btn-ghost btn-sm">View history</Link>}>
                  {currentEnrollments.length ? <div className="divide-y divide-line">{currentEnrollments.map((e) => <div key={e.id} className="flex flex-wrap items-center justify-between gap-3 p-4"><div><div className="font-semibold text-ink-900">{e.campaign ? <Link href={`/campaigns/${e.campaign.id}`} className="hover:text-brand-700 hover:underline">{e.campaign.name}</Link> : 'Direct enrollment'}</div><Link href={`/sequences/${e.sequenceId}`} className="mt-1 block text-sm font-semibold text-brand-700">{e.sequence.name}</Link></div><Badge tone={ENROLLMENT_TONE[e.status] ?? 'gray'}>{enrollmentStatusLabel(e)}</Badge></div>)}</div> : lastFinished ? <div className="flex flex-wrap items-center justify-between gap-3 p-4"><div><div className="font-semibold text-ink-900">{lastFinished.campaign ? <Link href={`/campaigns/${lastFinished.campaign.id}`} className="hover:text-brand-700 hover:underline">{lastFinished.campaign.name}</Link> : 'Direct enrollment'}</div><Link href={`/sequences/${lastFinished.sequenceId}`} className="mt-1 block text-sm font-semibold text-brand-700">{lastFinished.sequence.name}</Link></div><div className="text-right"><Badge tone={ENROLLMENT_TONE[lastFinished.status] ?? 'gray'}>{enrollmentStatusLabel(lastFinished)}</Badge><div className="mt-1 text-xs text-ink-500">Ended <strong className="font-semibold text-ink-800">{formatInstant(lastFinished.repliedAt ?? lastFinished.meetingAt ?? lastFinished.exitedAt ?? lastFinished.completedAt ?? lastFinished.updatedAt, user.timezone)}</strong></div></div></div> : <div className="p-4 text-sm text-ink-500">Never enrolled in a campaign</div>}
                </Card>
                <Card title="Contact details">
                  <div className="p-4">
                    {/* Consent only appears when there is a restriction: its absence is normal. */}
                    {person.dnd ? (
                      <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] font-medium text-red-700">
                        {optionLabel(person.dndReason ?? 'DO_NOT_CONTACT')} - set in Twenty.
                      </p>
                    ) : null}
                    <KeyValue
                      items={[
                        { k: 'Email', v: person.email },
                        { k: 'Other emails', v: person.additionalEmails.join(', ') || null },
                        { k: 'Phone', v: person.phone },
                        { k: 'Other phone', v: person.additionalPhone },
                        // The handle, not the whole URL set in bold: the link carries the rest.
                        { k: 'LinkedIn', v: person.linkedinUrl ? <a href={person.linkedinUrl} target="_blank" rel="noreferrer" title={person.linkedinUrl} className="text-brand-700 hover:underline">{person.linkedinUrl.replace(/^https?:\/\/(www\.)?linkedin\.com\//i, '')}</a> : null },
                        { k: 'X', v: person.xUrl },
                        { k: 'Title', v: person.jobTitle },
                        { k: 'Company', v: canOpenAccount ? <Link href={`/accounts/${person.companyId}`} className="text-brand-700 hover:underline">{person.companyName}</Link> : person.companyName },
                        { k: 'City', v: person.city },
                      ]}
                    />
                  </div>
                </Card>

                <Card title="Ownership">
                  <div className="p-4">
                    <KeyValue
                      items={[
                        { k: 'Assigned to', v: ownerName },
                        { k: 'Pod', v: podName },
                        { k: 'Rotated', v: person.rotatedTo ? `${optionLabel(person.rotatedTo)}${person.rotationChangedAt ? ` on ${formatInstant(person.rotationChangedAt, user.timezone)}` : ''}` : null },
                        { k: 'Added by', v: person.createdByName ? `${person.createdByName}${person.createdBySource ? ` (${optionLabel(person.createdBySource)})` : ''}` : null },
                      ]}
                    />
                  </div>
                </Card>

                <Card title="Classification">
                  <div className="p-4">
                    <KeyValue
                      items={[
                        { k: 'Tier', v: person.tier ? optionLabel(person.tier) : null },
                        { k: 'Contact type', v: optionLabels(person.contactType, ' / ') || null },
                        { k: 'Pipeline stage', v: person.pipelineStage ? optionLabel(person.pipelineStage) : null },
                        {
                          k: 'CRM cadence tag',
                          v: person.listCategory
                            ? `${optionLabel(person.listCategory)}${person.previousCadence ? ` (was ${optionLabel(person.previousCadence)})` : ''}`
                            : null,
                        },
                        { k: 'Lead source', v: optionLabels(person.leadSource) || null },
                        { k: 'Lead source notes', v: person.leadSourceNotes },
                        { k: 'Product interest', v: optionLabels(person.productInterest) || null },
                        { k: 'Primary product', v: person.primaryProduct ? optionLabel(person.primaryProduct) : null },
                        { k: 'Campaigns in Twenty', v: optionLabels(person.campaigns) || null },
                        { k: 'Deal signal', v: person.dealSignalStrength ? optionLabel(person.dealSignalStrength) : null },
                        { k: 'Calling list', v: person.onCallingList ? 'Yes' : null },
                        {
                          k: 'Tags',
                          v: person.tags.length ? (
                            <span className="flex flex-wrap gap-1">
                              {person.tags.map((t) => (
                                <span key={t} className="rounded border border-line bg-canvas px-1.5 py-0.5 text-[11.5px] text-ink-700" title={t}>
                                  {optionLabel(t)}
                                </span>
                              ))}
                            </span>
                          ) : null,
                        },
                      ]}
                    />
                  </div>
                </Card>

                <Card title="CRM activity details">
                  <div className="p-4">
                    <KeyValue
                      items={[
                        { k: 'Next action', v: person.nextAction },
                        { k: 'Due', v: person.nextActionDueDate ? formatLocalDate(person.nextActionDueDate, 'long') : null },
                        { k: 'By', v: person.nextStep ? optionLabel(person.nextStep) : null },
                        { k: 'POC due', v: person.nextActionDueDatePoc ? formatLocalDate(person.nextActionDueDatePoc, 'long') : null },
                        { k: 'Last note', v: person.lastNote },
                        { k: 'Last call', v: person.lastCallAt ? formatInstant(person.lastCallAt, user.timezone) : null },
                        { k: 'Last email', v: person.lastEmailAt ? formatInstant(person.lastEmailAt, user.timezone) : null },
                        {
                          k: 'Meeting link',
                          v: person.meetingUrl ? (
                            <a href={person.meetingUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                              Join
                            </a>
                          ) : null,
                        },
                        {
                          k: 'Recording',
                          v: person.recordingUrl ? (
                            <Link href={`/meetings/new?personId=${person.id}&url=${encodeURIComponent(person.recordingUrl)}`} className="text-brand-700 hover:underline">
                              Add meeting
                            </Link>
                          ) : null,
                        },
                        { k: 'Booking', v: person.bookingId },
                      ]}
                    />
                  </div>
                </Card>

                <Card title="Record">
                  <div className="p-4">
                    <KeyValue
                      items={[
                        { k: 'Twenty id', v: <span className="font-mono text-xs">{person.id}</span> },
                        { k: 'Changed in Twenty', v: formatInstant(person.twentyUpdatedAt, user.timezone) },
                        { k: 'Last synced', v: formatInstant(person.syncedAt, user.timezone) },
                      ]}
                    />
                  </div>
                </Card>
              </div>
            ) : null}
          </div>
        </div>

        <aside className="min-w-0 space-y-3">
          <Card title="Open opportunities">
            {opportunities.length === 0 ? (
              <div className="p-4 text-sm text-ink-500">None.</div>
            ) : (
              <ul className="divide-y divide-line">
                {opportunities.map((o) => (
                  <li key={o.id} className="flex items-center justify-between px-4 py-2 text-sm">
                    <span>{o.name}</span>
                    <Badge tone="purple">{o.stage ?? 'open'}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`Colleagues at ${person.companyName ?? 'company'}`}>
            {colleagues.length === 0 ? (
              <div className="p-4 text-sm text-ink-500">Nobody else known here.</div>
            ) : (
              <ul className="divide-y divide-line">
                {colleagues.map((c) => {
                  const st = crmStanding(c);
                  return (
                    <li key={c.id} className="flex items-center justify-between gap-2 px-4 py-2 text-[13px]">
                      <Link href={`/people/${c.id}`} className="flex min-w-0 items-center gap-2 hover:text-brand-700">
                        <Avatar name={cachedPersonName(c)} shape="circle" size={24} />
                        <span className="min-w-0 truncate text-ink-800">
                          {cachedPersonName(c)}
                          {c.jobTitle ? <span className="font-semibold text-ink-700"> · {c.jobTitle}</span> : null}
                        </span>
                      </Link>
                      <Badge tone={st.tone} dot>
                        {st.label}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}
