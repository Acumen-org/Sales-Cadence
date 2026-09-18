import { presentNoteBody } from '@/lib/crm-text';
import Link from 'next/link';
import { Suspense } from 'react';
import { RecordSync } from '@/components/record-sync';
import { canReadPerson } from '@/lib/people-scope';
import { accountScopeCompanyIds } from '@/lib/accounts-query';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canCreateMeeting, canManageCampaigns } from '@/lib/auth/rbac';
import { membershipFor, membershipLabel } from '@/lib/campaign-membership';
import { AddToCampaign, RemoveFromCampaign } from '@/components/campaigns/add-to-campaign';
import { prisma } from '@/lib/db';
import { addDays, formatInstant, formatLocalDate, todayIn } from '@/lib/dates';
import { accentFor } from '@/lib/accent';
import { callHref, opensDialpad } from '@/lib/calls';
import { cachedPersonName } from '@/lib/person-cache';
import { auditDetailText, describeAudit } from '@/lib/audit-format';
import { describeStep, parseSteps } from '@/lib/sequences/steps';
import { getSettings, getTwentyConnection } from '@/lib/settings';
import { getTwentyClient } from '@/lib/twenty';
import type { TwentyNote, TwentyOpportunity } from '@/lib/twenty/types';
import { twentyPersonUrl } from '@/lib/twenty/urls';
import { CrmHistory } from '@/components/people/crm-history';
import { ActionIcon, IconExternal } from '@/components/icons';
import { optionLabel, optionLabels } from '@/lib/twenty/labels';
import { Avatar, Badge, Card, contactWarnings, crmStanding, ENROLLMENT_TONE, enrollmentStatusLabel, KeyValue, RecordFields, RecordHeader, Surface, Tabs, TierBadge } from '@/components/ui';
import { campaignStatusLabel } from '@/lib/campaign-status';

type TimelineItem = { at: Date; kind: 'touch' | 'note' | 'task' | 'state'; icon: string; title: string; detail?: string | null; tone?: 'in' | 'out' | 'neutral' };

export default async function PersonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; crmNotes?: string; crmEmails?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const requested = sp.tab;
  const tab = requested === 'activity' || requested === 'sequences' || requested === 'emails' || requested === 'notes' || requested === 'tasks' ? requested : requested === 'crm' ? 'emails' : 'overview';
  // The record renders from the cache at once. <RecordSync> below re-reads it from Twenty after
  // the paint and refreshes the page if it moved; a gateway that is down shows nothing here.
  const person = await prisma.personCache.findUnique({ where: { id } });
  // Outside the reader's pods the record does not exist, the same answer Accounts gives. Checked
  // after the live re-read, so a person Twenty has and the cache did not is refused as well.
  if (!person || !(await canReadPerson(user, id))) notFound();

  const [enrollments, touches, tasks, audit, conn, pods, settings, colleagues] = await Promise.all([
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
    getSettings(),
    person.companyId ? prisma.personCache.findMany({ where: { companyId: person.companyId, id: { not: id }, deletedAt: null }, include: { enrollments: { orderBy: { createdAt: 'desc' }, take: 1 } }, take: 30 }) : Promise.resolve([]),
  ]);

  let notes: TwentyNote[] = [];
  let opportunities: TwentyOpportunity[] = [];
  try {
    const client = await getTwentyClient();
    [notes, opportunities] = await Promise.all([client.listNotes({ personId: id, limit: 20 }).then((p) => p.items), client.listOpportunities({ personId: id }).then((p) => p.items)]);
  } catch {
    // Notes and opportunities come straight from Twenty; when it is unreachable the page shows
    // what it has. The failure is counted on Settings > Twenty, not printed here.
  }

  // Accounts are pod-scoped even though people are not, so the company is only a link when this
  // viewer can actually open it. A rendered link that leads to not-found is worse than plain text.
  const accountScope = person.companyId ? await accountScopeCompanyIds(user) : null;
  const canOpenAccount = Boolean(person.companyId) && (accountScope === null || accountScope.includes(person.companyId!));

  const memberships = (await membershipFor([id])).get(id) ?? [];
  const cadencePodId = person.podOwner ? pods.find((p) => p.podOwnerValue === person.podOwner)?.id ?? null : null;
  // With nothing running, how the last engagement ended is the fact that decides what to do next,
  // so the card carries it rather than reading as if this person had never been worked.
  const standing = crmStanding(person);
  const warnings = contactWarnings(person);
  const podName = person.podOwner ? pods.find((x) => x.podOwnerValue === person.podOwner)?.name ?? optionLabel(person.podOwner) : null;
  const ownerName = person.ownerMemberId ? (await prisma.user.findFirst({ where: { twentyMemberId: person.ownerMemberId }, select: { name: true } }))?.name ?? null : null;
  const twentyUrl = twentyPersonUrl(conn.baseUrl, id);
  // Unified timeline
  const items: TimelineItem[] = [
    ...touches.map<TimelineItem>((t) => ({ at: t.occurredAt, kind: 'touch', icon: t.channel, title: t.summary, detail: notes.find(n => t.externalId.startsWith(`note:${n.id}:`))?.bodyMarkdown || t.actorLabel, tone: t.direction === 'INBOUND' ? 'in' : 'out' })),
    ...notes
      .filter((n) => !touches.some((t) => t.externalId.startsWith(`note:${n.id}:`)))
      .map<TimelineItem>((n) => ({ at: new Date(n.createdAt), kind: 'note', icon: 'NOTE', title: n.title, detail: presentNoteBody(n.bodyMarkdown) || n.createdByName, tone: 'neutral' })),
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

  const openTasks = tasks.filter((t) => t.state === 'PENDING');
  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'sequences', label: 'Campaigns', count: enrollments.length + memberships.filter((m) => m.kind === 'upcoming').length },
    { key: 'tasks', label: 'Tasks', count: openTasks.length },
    { key: 'activity', label: 'Activity', count: items.length },
    { key: 'emails', label: 'Emails' },
    { key: 'notes', label: 'Notes' },
  ];
  const accent = accentFor(id);
  const today = todayIn(user.timezone);
  const horizon = addDays(today, 30);

  return (
    <>
      <Suspense fallback={null}><RecordSync kind="person" id={id} /></Suspense>
      <div className="px-6 pt-2">
        <RecordHeader
          name={cachedPersonName(person)}
          accent={accent}
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
                <a href={callHref(person.phone, settings.rules.clickToCallUrl)} target={opensDialpad(settings.rules.clickToCallUrl) ? '_blank' : undefined} rel="noreferrer" className="btn-secondary btn-sm">
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
            {tab === 'emails' ? <CrmHistory show="emails" personId={id} timezone={user.timezone} baseHref={`/people/${id}?tab=emails`} emailsAfter={sp.crmEmails} /> : null}
            {tab === 'notes' ? <CrmHistory show="notes" personId={id} timezone={user.timezone} baseHref={`/people/${id}?tab=notes`} notesAfter={sp.crmNotes} /> : null}
            {tab === 'tasks' ? (
              <Card title="Tasks">
                {/* What is due for this person now and in the next month, plus campaigns about to start. */}
                {(() => {
                  const due = openTasks.map((t) => ({ ...t, on: t.snoozedTo ?? t.dueDate })).filter((t) => t.on <= horizon).sort((a, b) => a.on.localeCompare(b.on) || a.actionIndex - b.actionIndex);
                  const upcoming = memberships.filter((m) => m.kind === 'upcoming');
                  if (!due.length && !upcoming.length) return <div className="p-4 text-sm text-ink-500">Nothing due in the next 30 days</div>;
                  const days = [...new Set(due.map((t) => t.on))];
                  return <div className="divide-y divide-line">
                    {upcoming.map((m) => <div key={m.campaignId} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]"><Badge tone="purple">Upcoming</Badge><Link href={`/campaigns/${m.campaignId}`} className="font-medium text-ink-900 hover:text-brand-700">{m.campaignName}</Link><span className="text-ink-500">starts {formatLocalDate(m.startDate, 'long')} · {m.sequenceName}</span></div>)}
                    {days.map((day) => <div key={day} className="px-4 py-3">
                      <div className={`text-[11.5px] font-medium ${day < today ? 'text-red-700' : day === today ? 'text-brand-700' : 'text-ink-500'}`}>{day < today ? `Overdue · ${formatLocalDate(day, 'long')}` : day === today ? 'Today' : formatLocalDate(day, 'long')}</div>
                      <ul className="mt-2 space-y-1.5">{due.filter((t) => t.on === day).map((t) => <li key={t.id} className="flex flex-wrap items-center gap-3 text-[13px]"><ActionIcon action={t.action} size={14} /><Link href={`/tasks?task=${t.id}&mode=flow&tab=${day < today ? 'overdue' : day === today ? 'today' : 'upcoming'}&pod=&fo=`} className="font-medium text-ink-900 hover:text-brand-700">{t.label}</Link><span className="text-ink-500">step {t.stepIndex + 1} · {t.fo.name}</span></li>)}</ul>
                    </div>)}
                  </div>;
                })()}
              </Card>
            ) : null}
            {tab === 'activity' ? (
              <Card title="Activity">
                {items.length === 0 ? (
                  <div className="p-4 text-sm text-ink-500">No activity yet.</div>
                ) : (
                  <ol className="divide-y divide-line">
                    {items.map((it, i) => (
                      <li key={i} className="flex gap-3 px-4 py-2.5 text-sm">
                        <span className={it.tone === 'in' ? 'mt-0.5 text-emerald-600' : it.tone === 'out' ? 'mt-0.5 text-ink-500' : 'mt-0.5 text-ink-500'}>
                          {it.icon === 'NOTE' || it.icon === 'STATE' ? <span className="inline-block h-3.5 w-3.5 rounded-full border border-current" /> : <ActionIcon action={it.icon} size={14} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="text-ink-800">{it.title}</span>
                          {/* A CRM note arrives whole: it wraps to a readable measure and breaks
                              a long address rather than pushing the column sideways. */}
                          {it.detail ? <span className="block max-w-[70ch] whitespace-pre-wrap break-words text-sm leading-6 text-ink-700">{it.detail}</span> : null}
                        </span>
                        <span className="shrink-0 text-xs text-ink-500">{formatInstant(it.at, user.timezone)}</span>
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
                      title={<span className="flex items-center gap-2"><Link href={`/sequences/${e.sequenceId}`} className="font-medium hover:underline">{e.sequence.name}</Link>{e.cycle > 1 ? <Badge tone="blue">Round {e.cycle}</Badge> : null}</span>}
                      actions={<Badge tone={ENROLLMENT_TONE[e.status] ?? 'gray'}>{enrollmentStatusLabel(e)}</Badge>}
                    >
                      <div className="border-b border-line bg-canvas/50 p-4"><RecordFields className="lg:grid-cols-4" items={[
                        { label: 'Campaign', value: e.campaign ? <Link href={`/campaigns/${e.campaign.id}`} className="text-brand-700 hover:underline">{e.campaign.name}</Link> : 'Direct enrollment' },
                        { label: 'FO', value: e.fo.name },
                        { label: 'Started', value: formatLocalDate(e.startDate, 'long') },
                        { label: 'Campaign status', value: e.campaign ? campaignStatusLabel(e.campaign.status) : null },
                      ]} /></div>
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
                                {!reached ? <span className="text-xs text-ink-500">Not reached</span> : null}
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
                <Card title={memberships.some((m) => m.kind !== 'finished') || !memberships.length ? 'Campaigns' : 'Last campaign'} actions={<span className="flex items-center gap-2">{canManageCampaigns(user, cadencePodId) ? <AddToCampaign personIds={[id]} className="btn-secondary btn-sm" /> : null}<Link href={`/people/${id}?tab=sequences`} className="btn-ghost btn-sm">View history</Link></span>}>
                  {memberships.length ? <div className="divide-y divide-line">{memberships.filter((m) => m.kind !== 'finished').concat(memberships.filter((m) => m.kind === 'finished').slice(0, 1)).map((m) => {
                    const label = membershipLabel(m);
                    return <div key={`${m.campaignId}-${m.enrollmentId ?? 'soon'}`} className="flex flex-wrap items-center justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <div className="font-medium text-ink-900"><Link href={`/campaigns/${m.campaignId}`} className="hover:text-brand-700 hover:underline">{m.campaignName}</Link></div>
                        <div className="mt-1 text-[12.5px] text-ink-500"><Link href={`/sequences/${m.sequenceId}`} className="text-brand-700">{m.sequenceName}</Link>{m.step !== null ? ` · step ${m.step + 1} of ${m.steps}` : m.kind === 'upcoming' ? ` · starts ${formatLocalDate(m.startDate)}` : ''}{m.endDate ? ` · ends ${formatLocalDate(m.endDate)}` : ''}</div>
                      </div>
                      <div className="flex items-center gap-2"><Badge tone={label.tone}>{label.label}</Badge>{m.kind !== 'finished' && canManageCampaigns(user, m.podId) ? <RemoveFromCampaign campaignId={m.campaignId} campaignName={m.campaignName} personIds={[id]} className="btn-ghost btn-sm" /> : null}</div>
                    </div>;
                  })}</div> : <div className="p-4 text-sm text-ink-500">Never in a campaign</div>}
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
                        { k: 'Owner', v: ownerName },
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
                          v: person.recordingUrl && canCreateMeeting(user) ? (
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
          {opportunities.length ? <Card title="Open opportunities">
            {(
              <ul className="divide-y divide-line">
                {opportunities.map((o) => (
                  <li key={o.id} className="flex items-center justify-between px-4 py-2 text-sm">
                    <span>{o.name}</span>
                    <Badge tone="purple">{o.stage ? optionLabel(o.stage) : 'Open'}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card> : null}
          {colleagues.length ? <Card title={`Colleagues at ${person.companyName ?? 'company'}`}>
            {(
              <ul className="divide-y divide-line">
                {colleagues.map((c) => {
                  const st = crmStanding(c);
                  return (
                    <li key={c.id} className="flex items-center justify-between gap-2 px-4 py-2 text-[13px]">
                      <Link href={`/people/${c.id}`} className="flex min-w-0 items-center gap-2 hover:text-brand-700">
                        <Avatar name={cachedPersonName(c)} shape="circle" size={24} />
                        <span className="min-w-0">
                          <span className="block truncate text-ink-800">{cachedPersonName(c)}</span>
                          {c.jobTitle ? <span className="block truncate text-[12px] leading-4 text-ink-500" title={c.jobTitle}>{c.jobTitle}</span> : null}
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
          </Card> : null}
        </aside>
      </div>
    </>
  );
}
