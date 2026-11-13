import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';
import { RecordSync } from '@/components/record-sync';
import { canReadPerson } from '@/lib/people-scope';
import { accountScopeCompanyIds } from '@/lib/accounts-query';
import { notFound } from 'next/navigation';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { canAct, loadPersonSubject } from '@/lib/outreach/guard';
import { openSuggestions } from '@/lib/outreach/suggestions';
import { SuggestionList } from '@/components/calls/suggestions';
import { formOptOut } from '@/lib/tickets';
import { FormOptOutControls } from '@/components/tickets/close-ticket-form';
import { personRef } from '@/lib/subject';
import { nextActionAccess, REPEAT_LABELS } from '@/lib/next-actions';
import { ACTION_LABELS } from '@/lib/sequences/steps';
import { completeNextActionAction, stopNextActionAction } from '@/lib/actions/next-actions';
import { NextActionButton } from '@/components/people/next-action-form';
import { ActionButton } from '@/components/action-form';
import { canChangeCampaignPeople, canCreateMeeting, mayChangeCampaignPeople } from '@/lib/auth/rbac';
import { membershipFor, membershipLabel } from '@/lib/campaign-membership';
import { AddToCampaign, RemoveFromCampaign } from '@/components/campaigns/add-to-campaign';
import { prisma } from '@/lib/db';
import { addDays, formatInstant, formatLocalDate, todayIn } from '@/lib/dates';
import { accentFor } from '@/lib/accent';
import { CallButton } from '@/components/calls/call-button';
import { callGate, pendingFormBlock } from '@/lib/calls/gate';
import { openCallItems } from '@/lib/calls/link';
import { LogCallButton } from '@/components/calls/log-call';
import { cachedPersonName } from '@/lib/person-cache';
import { describeStep, parseSteps } from '@/lib/sequences/steps';
import { getSettings, getTwentyConnection } from '@/lib/settings';
import { getTwentyClient } from '@/lib/twenty';
import type { TwentyNote, TwentyOpportunity } from '@/lib/twenty/types';
import { twentyPersonUrl } from '@/lib/twenty/urls';
import { CrmHistory } from '@/components/people/crm-history';
import { ActionIcon, IconExternal } from '@/components/icons';
import { optionLabel, optionLabels } from '@/lib/twenty/labels';
import { isUnmappedDndValue } from '@/lib/twenty/normalize';
import { defaultTwentySchema } from '@/lib/twenty/twenty-schema';
import { Avatar, Badge, Card, contactWarnings, crmStanding, enrollmentTone, enrollmentStatusLabel, KeyValue, Notice, RecordFields, RecordHeader, Surface, Tabs, TierBadge } from '@/components/ui';
import { campaignStatusLabel } from '@/lib/campaign-status';
import { linkedinSubjectView } from '@/lib/linkedin/subject-view';
import { LinkedInCard } from '@/components/linkedin/linkedin-card';
import { AddLinkedInButton, AddLinkedInLinkForm } from '@/components/linkedin/add-linkedin-link';
import { ActivityFeed } from '@/components/activity-feed';
import { personFeed } from '@/lib/person-feed';
import { callOutcomes } from '@/lib/call-outcomes';

/** Only the values a record holds: an empty field is not worth a row (owner, 13 Nov 2026). */
const filled = <T extends { value: ReactNode }>(items: T[]) => items.filter((i) => i.value !== null && i.value !== undefined && i.value !== '' && i.value !== false);

/**
 * A CRM person. The header says who they are (title, firm, city) and holds every way to reach them,
 * Add LinkedIn included when there is no link. Overview: what to do next, their campaign and recent
 * activity, then the CRM's own fields, filled ones only. Beside it, on every tab: contact details,
 * LinkedIn, opportunities and colleagues. Activity is one feed by day with a filter per kind; Emails
 * are conversations.
 */
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

  const [openNext, nextAccess, suggestions, subject, linkedin] = await Promise.all([
    prisma.nextAction.findFirst({ where: { personId: id, state: 'OPEN' }, include: { fo: { select: { id: true, name: true } } } }),
    nextActionAccess(user),
    // B027: a colleague's call left a suggested next step for this owner.
    openSuggestions(user.id, { personId: id }),
    loadPersonSubject(id),
    linkedinSubjectView({ personId: id }, user.timezone),
  ]);
  // B120: Call says why when this viewer may not call (Biz Ops read only), in words under the button.
  const callVerdict = subject ? canAct(toActor(user), subject, 'call') : null;
  const gateNow = person.phone ? await callGate(user, { personId: person.id, phone: person.phone, state: person.city?.split(',').pop()?.trim() ?? null, optedOut: person.optedOut, dnd: person.dnd, email: person.email, linkedinUrl: person.linkedinUrl }) : null;
  const callGateNow = gateNow && callVerdict && !callVerdict.ok ? { blocked: callVerdict.reason, warning: null } : gateNow;
  // Log a call (a voicemail from a mobile, say), with or without a phone on file: the server's rules,
  // who may log for this person and no form waiting, say why under the button, as on a cold contact.
  const logVerdict = subject ? canAct(toActor(user), subject, 'log_call') : { ok: false as const, reason: 'This person is no longer in the CRM.' };
  const [logPending, logSteps] = await Promise.all([
    logVerdict.ok ? pendingFormBlock(user.id, user.timezone) : Promise.resolve(null),
    logVerdict.ok ? openCallItems({ personId: id, sandboxContactId: null }, null) : Promise.resolve([]),
  ]);
  const logBlocked = !logVerdict.ok ? logVerdict.reason : logPending?.replace(/ \([^)]*\) first\.$/, ' first.') ?? null;
  const nowLocal = new Intl.DateTimeFormat('sv-SE', { timeZone: user.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(' ', 'T');
  // D4: an opt-out from the post-call form can be questioned by anyone and undone by an admin.
  const formOpt = person.optedOut ? await formOptOut(personRef(id)) : null;
  const mayWorkNext = openNext ? openNext.foUserId === user.id || user.role === 'ADMIN' || (nextAccess.canAssign && nextAccess.fos.some((f) => f.id === openNext.foUserId)) : false;

  let notes: TwentyNote[] = [];
  let opportunities: TwentyOpportunity[] = [];
  // Only the tabs that show them ask Twenty; a tab of tasks or emails does not wait on that round trip.
  const wantsTwenty = tab === 'overview' || tab === 'activity';
  try {
    if (wantsTwenty) {
      const client = await getTwentyClient();
      [notes, opportunities] = await Promise.all([client.listNotes({ personId: id, limit: 20 }).then((p) => p.items), client.listOpportunities({ personId: id }).then((p) => p.items)]);
    }
  } catch {
    // Notes and opportunities come straight from Twenty; when it is unreachable the page shows
    // what it has. The failure is counted on Settings > Twenty, not printed here.
  }

  // Accounts are pod-scoped even though people are not, so the company is only a link when this
  // viewer can actually open it. A rendered link that leads to not-found is worse than plain text.
  const accountScope = person.companyId ? await accountScopeCompanyIds(user) : null;
  const canOpenAccount = Boolean(person.companyId) && (accountScope === null || accountScope.includes(person.companyId!));

  const memberships = (await membershipFor([id])).get(id) ?? [];
  // With nothing running, how the last engagement ended is the fact that decides what to do next,
  // so the card carries it rather than reading as if this person had never been worked.
  const standing = crmStanding(person);
  const warnings = contactWarnings(person);
  const podName = person.podOwner ? pods.find((x) => x.podOwnerValue === person.podOwner)?.name ?? optionLabel(person.podOwner) : null;
  const ownerName = person.ownerMemberId ? (await prisma.user.findFirst({ where: { twentyMemberId: person.ownerMemberId }, select: { name: true } }))?.name ?? null : null;
  const twentyUrl = twentyPersonUrl(conn.baseUrl, id);
  const outcomes = callOutcomes(settings.rules);
  const feed = personFeed({
    touches, notes, tasks, audit, prefix: settings.matching.cadencePrefix,
    sequenceOf: (enrollmentId) => enrollments.find((e) => e.id === enrollmentId)?.sequence.name ?? null,
    outcomeLabel: (key) => outcomes.find((o) => o.key === key)?.label ?? key,
  });

  const openTasks = tasks.filter((t) => t.state === 'PENDING');
  // Counts only where they mean work to do; Activity, Emails and Notes are read, not worked.
  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'sequences', label: 'Campaigns', count: enrollments.length + memberships.filter((m) => m.kind === 'upcoming').length },
    { key: 'tasks', label: 'Tasks', count: openTasks.length },
    { key: 'activity', label: 'Activity' },
    { key: 'emails', label: 'Emails' },
    { key: 'notes', label: 'Notes' },
  ];
  const accent = accentFor(id);
  const today = todayIn(user.timezone);
  const horizon = addDays(today, 30);
  const name = cachedPersonName(person);
  const company = person.companyName ? (canOpenAccount ? <Link href={`/accounts/${person.companyId}`} className="hover:text-brand-700 hover:underline">{person.companyName}</Link> : person.companyName) : null;
  const sub = [person.jobTitle, company, person.city].filter(Boolean);

  return (
    <>
      <RecordSync kind="person" id={id} />
      <div className="px-6 pt-2">
        <RecordHeader
          name={name}
          accent={accent}
          seed={id}
          stackOnPhone
          sub={sub.length ? <span className="flex flex-wrap items-center gap-x-1.5">{sub.map((s, i) => <span key={i} className="inline-flex items-center gap-1.5">{i ? <span aria-hidden className="text-ink-400">·</span> : null}{s}</span>)}</span> : null}
          badges={<>
            <Badge tone={standing.tone}>{standing.label}</Badge>
            <TierBadge tier={person.tier} />
            {warnings.map((w) => <Badge key={w.label} tone={w.tone}>{w.label}</Badge>)}
          </>}
          actions={<>
            {person.phone ? <CallButton phone={person.phone} template={settings.rules.clickToCallUrl} personId={person.id} nextActionId={openNext?.id ?? null} blocked={callGateNow?.blocked} warning={callGateNow?.warning} className="btn-secondary btn-sm" /> : null}
            <span className="inline-flex max-w-[13rem] flex-col"><LogCallButton personId={person.id} name={name} steps={logSteps.map((s) => ({ key: `${s.kind}:${s.id}`, words: s.words }))} now={nowLocal} blocked={logBlocked} /></span>
            {person.email ? <a href={`mailto:${person.email}`} className="btn-secondary btn-sm"><ActionIcon action="EMAIL" size={13} /> Email</a> : null}
            {person.linkedinUrl
              ? <a href={person.linkedinUrl} target="_blank" rel="noreferrer" className="btn-secondary btn-sm"><ActionIcon action="LINKEDIN_MESSAGE" size={13} /> LinkedIn</a>
              : nextAccess.canSet ? <AddLinkedInButton personId={id} name={name} /> : null}
            {twentyUrl ? <a href={twentyUrl} target="_blank" rel="noreferrer" className="btn-ghost btn-sm"><IconExternal size={13} /> Open in CRM</a> : null}
          </>}
        />
        {formOpt ? <div className="mt-2"><Notice tone="error"><span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <span><span className="font-medium">Do not contact</span> since {formOpt.at ? formatInstant(formOpt.at, user.timezone) : 'the call'}: {formOpt.byName ?? 'a rep'} chose &quot;Asked not to be contacted&quot; on the post-call form.</span>
          <FormOptOutControls subject={{ personId: id }} name={name} mayLift={user.role === 'ADMIN'} ticket={formOpt.ticket ? `Biz Ops are looking at it: raised by ${formOpt.ticket.raisedBy ?? 'someone'}.` : null} />
        </span></Notice></div> : null}
        {/* Consent only appears when there is a restriction: its absence is normal. */}
        {person.dnd && !formOpt ? <div className="mt-2"><Notice tone="error">
          <span className="font-medium">{optionLabel(person.dndReason ?? 'DO_NOT_CONTACT')}</span>, set in the CRM.
          {isUnmappedDndValue(person.dndReason, defaultTwentySchema) ? " This option is not in Cadence's field mapping; it is treated as do not contact. An admin should add it to the mapping or correct it in the CRM." : null}
        </Notice></div> : null}
      </div>
      <div className="grid items-start gap-3 px-6 pb-8 pt-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <Surface flush>
            <Tabs inset={false} current={tab} tabs={tabs.map((t) => ({ ...t, href: `/people/${id}?tab=${t.key}` }))} />
          </Surface>
          <div className="pt-3">
            {tab === 'emails' ? <Suspense fallback={<div className="surface h-40" />}><CrmHistory show="emails" personId={id} timezone={user.timezone} baseHref={`/people/${id}?tab=emails`} emailsAfter={sp.crmEmails} /></Suspense> : null}
            {tab === 'notes' ? <Suspense fallback={<div className="surface h-40" />}><CrmHistory show="notes" personId={id} timezone={user.timezone} baseHref={`/people/${id}?tab=notes`} notesAfter={sp.crmNotes} /></Suspense> : null}
            {tab === 'tasks' ? (
              <Card title="Tasks">
                {/* What is due for this person now and in the next month, plus campaigns about to start. */}
                {(() => {
                  const due = openTasks.map((t) => ({ ...t, on: t.snoozedTo ?? t.dueDate })).filter((t) => t.on <= horizon).sort((a, b) => a.on.localeCompare(b.on) || a.actionIndex - b.actionIndex);
                  if (!due.length) return <div className="p-4 text-sm text-ink-500">Nothing due in the next 30 days</div>;
                  const days = [...new Set(due.map((t) => t.on))];
                  return <div className="divide-y divide-line">
                    {days.map((day) => <div key={day} className="px-4 py-3">
                      <div className={`text-[11.5px] font-medium ${day < today ? 'text-red-700' : day === today ? 'text-brand-700' : 'text-ink-500'}`}>{day < today ? `Overdue · ${formatLocalDate(day, 'long')}` : day === today ? 'Today' : formatLocalDate(day, 'long')}</div>
                      <ul className="mt-2 space-y-1.5">{due.filter((t) => t.on === day).map((t) => <li key={t.id} className="flex flex-wrap items-center gap-3 text-[13px]"><ActionIcon action={t.action} size={14} /><Link href={`/tasks?task=${t.id}&mode=flow&tab=${day < today ? 'overdue' : day === today ? 'today' : 'upcoming'}&pod=&fo=`} className="font-medium text-ink-900 hover:text-brand-700">{t.label}</Link><span className="text-ink-500">step {t.stepIndex + 1} · {t.fo.name}</span></li>)}</ul>
                    </div>)}
                  </div>;
                })()}
              </Card>
            ) : null}
            {tab === 'activity' ? <Card title="Activity"><ActivityFeed items={feed} timezone={user.timezone} today={today} empty="No activity yet." /></Card> : null}

            {tab === 'sequences' ? (
              <div className="space-y-3">
                {memberships.filter((m) => m.kind === 'upcoming').map((m) => (
                  <Card key={m.campaignId} title={<Link href={`/campaigns/${m.campaignId}`} className="font-medium hover:underline">{m.campaignName}</Link>} actions={<Badge tone="purple">{m.campaignStatus === 'PENDING_APPROVAL' ? 'Awaiting approval' : 'Upcoming'}</Badge>}>
                    <div className="p-4"><RecordFields className="lg:grid-cols-4" items={[
                      { label: 'Sequence', value: <Link href={`/sequences/${m.sequenceId}`} className="text-brand-700 hover:underline">{m.sequenceName}</Link> },
                      { label: 'Starts', value: formatLocalDate(m.startDate, 'long') },
                      { label: 'Ends', value: m.endDate ? formatLocalDate(m.endDate, 'long') : null },
                      { label: 'Steps', value: m.steps },
                    ]} /></div>
                  </Card>
                ))}
                {enrollments.length === 0 && !memberships.some((m) => m.kind === 'upcoming') ? <Card><div className="p-4 text-sm text-ink-500">Not in a campaign</div></Card> : null}
                {enrollments.map((e) => {
                  const steps = parseSteps(e.sequence.steps);
                  const eTasks = tasks.filter((t) => t.enrollmentId === e.id);
                  return (
                    <Card
                      key={e.id}
                      title={<span className="flex items-center gap-2"><Link href={`/sequences/${e.sequenceId}`} className="font-medium hover:underline">{e.sequence.name}</Link>{e.cycle > 1 ? <Badge tone="blue">Round {e.cycle}</Badge> : null}</span>}
                      actions={<Badge tone={enrollmentTone(e)}>{enrollmentStatusLabel(e)}</Badge>}
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
                          return (
                            <li key={step.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                              <span className="w-14 shrink-0 text-xs font-semibold uppercase text-ink-500">Day {step.day}</span>
                              <span className="flex-1 text-ink-800">{describeStep(step)}</span>
                              <span className="flex flex-wrap gap-1">
                                {st.map((t) => (
                                  <Badge key={t.id} tone={t.state === 'DONE' ? 'green' : t.state === 'PENDING' ? 'blue' : t.state === 'SKIPPED' ? 'amber' : 'gray'}>
                                    {t.label}: {t.state === 'PENDING' ? `due ${formatLocalDate(t.snoozedTo ?? t.dueDate)}` : t.state.toLowerCase()}
                                    {t.disposition ? ` (${t.disposition})` : ''}
                                  </Badge>
                                ))}
                                {!st.length ? <span className="text-xs text-ink-500">Not reached</span> : null}
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
              <div className="space-y-3">
                <Card
                  title="Task"
                  actions={nextAccess.canSet ? <span className="flex items-center gap-2">
                    {openNext && mayWorkNext ? <ActionButton action={completeNextActionAction} payload={{ id: openNext.id }} className="btn-primary btn-sm" refresh>Done</ActionButton> : null}
                    {person.dnd || (openNext && !mayWorkNext) ? null : <NextActionButton personIds={[id]} today={today} fos={nextAccess.fos} canAssign={nextAccess.canAssign} label={openNext ? 'Change' : 'Create task'} icon={openNext ? 'refresh' : 'plus'} initial={openNext ? { label: openNext.label, action: openNext.action, dueDate: openNext.dueDate < today ? today : openNext.dueDate, repeat: openNext.repeat, foUserId: openNext.foUserId } : undefined} />}
                    {openNext && mayWorkNext ? <ActionButton action={stopNextActionAction} payload={{ id: openNext.id }} className="btn-ghost btn-sm" confirm={{ title: 'Stop this task?', effects: ['It closes without being done.', 'It is cleared in the CRM too.'], confirmLabel: 'Stop' }} refresh>Stop</ActionButton> : null}
                  </span> : null}
                >
                  {openNext ? (
                    <div className="flex items-start gap-3 p-4">
                      <span aria-hidden className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700"><ActionIcon action={openNext.action} size={16} /></span>
                      <div className="min-w-0">
                        <div className="text-[14px] font-medium text-ink-900">{openNext.label}</div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-ink-600">
                          <span>{ACTION_LABELS[openNext.action]}</span>
                          <span className={openNext.dueDate < today ? 'font-medium text-red-700' : undefined}>Due {formatLocalDate(openNext.dueDate, 'long')}{openNext.dueDate < today ? ' (overdue)' : ''}</span>
                          <span>{openNext.fo.name}</span>
                          {openNext.repeat !== 'NONE' ? <span>{REPEAT_LABELS[openNext.repeat]}</span> : null}
                        </div>
                      </div>
                    </div>
                  ) : <p className="p-4 text-[13px] text-ink-500">No task yet.{person.dnd ? '' : ' Create one so this person is not forgotten.'}</p>}
                  {suggestions.length ? <div className="border-t border-line p-4"><SuggestionList items={suggestions.map((s) => ({ id: s.id, from: s.from, words: s.words }))} /></div> : null}
                </Card>

                <Card title={memberships.some((m) => m.kind !== 'finished') || !memberships.length ? 'Campaigns' : 'Last campaign'} actions={<span className="flex items-center gap-2">{mayChangeCampaignPeople(user) ? <AddToCampaign personIds={[id]} className="btn-secondary btn-sm" /> : null}{memberships.length ? <Link href={`/people/${id}?tab=sequences`} className="btn-ghost btn-sm">View history</Link> : null}</span>}>
                  {memberships.length ? <div className="divide-y divide-line">{memberships.filter((m) => m.kind !== 'finished').concat(memberships.filter((m) => m.kind === 'finished').slice(0, 1)).map((m) => {
                    const label = membershipLabel(m);
                    return <div key={`${m.campaignId}-${m.enrollmentId ?? 'soon'}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="font-medium text-ink-900"><Link href={`/campaigns/${m.campaignId}`} className="hover:text-brand-700 hover:underline">{m.campaignName}</Link></div>
                        <div className="mt-1 text-[12.5px] text-ink-500"><Link href={`/sequences/${m.sequenceId}`} className="text-brand-700">{m.sequenceName}</Link>{m.step !== null ? ` · step ${m.step + 1} of ${m.steps}` : m.kind === 'upcoming' ? ` · starts ${formatLocalDate(m.startDate)}` : ''}{m.endDate ? ` · ends ${formatLocalDate(m.endDate)}` : ''}</div>
                      </div>
                      <div className="flex items-center gap-2"><Badge tone={label.tone}>{label.label}</Badge>{m.kind !== 'finished' && canChangeCampaignPeople(user, { podId: m.podId, foIds: m.foIds, podWide: m.podWide }) ? <RemoveFromCampaign campaignId={m.campaignId} campaignName={m.campaignName} personIds={[id]} className="btn-ghost btn-sm" /> : null}</div>
                    </div>;
                  })}</div> : <div className="p-4 text-sm text-ink-500">Never in a campaign</div>}
                </Card>

                <Card title="Recent activity" actions={feed.length ? <Link href={`/people/${id}?tab=activity`} className="btn-ghost btn-sm">View all</Link> : null}>
                  <ActivityFeed items={feed} timezone={user.timezone} today={today} limit={5} empty="No activity yet." />
                </Card>

                <CrmProfile person={person} ownerName={ownerName} podName={podName} timezone={user.timezone} mayAddMeeting={canCreateMeeting(user)} />
              </div>
            ) : null}
          </div>
        </div>

        <aside className="min-w-0 space-y-3">
          <Card title="Contact details">
            <div className="p-4">
              <KeyValue items={[
                { k: 'Email', v: person.email ? <a href={`mailto:${person.email}`} className="text-brand-700 hover:underline">{person.email}</a> : null },
                { k: 'Phone', v: person.phone ? <span className="tabular-nums">{person.phone}</span> : null },
                ...filled([
                  { k: 'Other emails', value: person.additionalEmails.join(', ') },
                  { k: 'Other phone', value: person.additionalPhone },
                  // The handle, not the whole URL: the link carries the rest.
                  { k: 'LinkedIn', value: person.linkedinUrl ? <a href={person.linkedinUrl} target="_blank" rel="noreferrer" title={person.linkedinUrl} className="text-brand-700 hover:underline">{person.linkedinUrl.replace(/^https?:\/\/(www\.)?linkedin\.com\//i, '')}</a> : null },
                  { k: 'X', value: person.xUrl },
                  { k: 'Title', value: person.jobTitle },
                  { k: 'Company', value: company },
                  { k: 'City', value: person.city },
                ]).map((i) => ({ k: i.k, v: i.value })),
              ]} />
            </div>
          </Card>
          <LinkedInCard view={linkedin} hasLink={Boolean(person.linkedinKey)} addLink={nextAccess.canSet ? <AddLinkedInLinkForm personId={id} /> : null} />
          {opportunities.length ? <Card title="Open opportunities">
            <ul className="divide-y divide-line">
              {opportunities.map((o) => <li key={o.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-[13px]"><span className="min-w-0 truncate text-ink-800">{o.name}</span><Badge tone="purple">{o.stage ? optionLabel(o.stage) : 'Open'}</Badge></li>)}
            </ul>
          </Card> : null}
          {colleagues.length ? <Card title={`Colleagues at ${person.companyName ?? 'company'}`}>
            <ul className="divide-y divide-line">
              {colleagues.map((c) => {
                const st = crmStanding(c);
                return <li key={c.id} className="flex items-center justify-between gap-2 px-4 py-2 text-[13px]">
                  <Link href={`/people/${c.id}`} className="flex min-w-0 items-center gap-2 hover:text-brand-700">
                    <Avatar name={cachedPersonName(c)} shape="circle" size={24} />
                    <span className="min-w-0">
                      <span className="block truncate text-ink-800">{cachedPersonName(c)}</span>
                      {c.jobTitle ? <span className="block truncate text-[12px] leading-4 text-ink-500" title={c.jobTitle}>{c.jobTitle}</span> : null}
                    </span>
                  </Link>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </li>;
              })}
            </ul>
          </Card> : null}
        </aside>
      </div>
    </>
  );
}

type ProfilePerson = NonNullable<Awaited<ReturnType<typeof prisma.personCache.findUnique>>>;

/**
 * The CRM's own fields, in two parts: who they are to us (owner, pod, how they are classified) and
 * what the CRM itself last recorded. Filled fields only; the record's ids in one quiet line.
 */
function CrmProfile({ person, ownerName, podName, timezone, mayAddMeeting }: { person: ProfilePerson; ownerName: string | null; podName: string | null; timezone: string; mayAddMeeting: boolean }) {
  const profile = filled([
    { label: 'Owner', value: ownerName },
    { label: 'Pod', value: podName },
    { label: 'Tier', value: person.tier ? optionLabel(person.tier) : null },
    { label: 'Contact type', value: optionLabels(person.contactType, ' / ') },
    { label: 'Pipeline stage', value: person.pipelineStage ? optionLabel(person.pipelineStage) : null },
    { label: 'CRM cadence tag', value: person.listCategory ? `${optionLabel(person.listCategory)}${person.previousCadence ? ` (was ${optionLabel(person.previousCadence)})` : ''}` : null },
    { label: 'Lead source', value: optionLabels(person.leadSource) },
    { label: 'Primary product', value: person.primaryProduct ? optionLabel(person.primaryProduct) : null },
    { label: 'Product interest', value: optionLabels(person.productInterest) },
    { label: 'Campaigns in the CRM', value: optionLabels(person.campaigns) },
    { label: 'Deal signal', value: person.dealSignalStrength ? optionLabel(person.dealSignalStrength) : null },
    { label: 'Calling list', value: person.onCallingList ? 'Yes' : null },
    { label: 'Rotated', value: person.rotatedTo ? `${optionLabel(person.rotatedTo)}${person.rotationChangedAt ? ` on ${formatInstant(person.rotationChangedAt, timezone)}` : ''}` : null },
    { label: 'Added by', value: person.createdByName ? `${person.createdByName}${person.createdBySource ? ` (${optionLabel(person.createdBySource)})` : ''}` : null },
  ]);
  const latest = filled([
    { label: 'Next action', value: person.nextAction },
    { label: 'By', value: person.nextStep ? optionLabel(person.nextStep) : null },
    { label: 'Due', value: person.nextActionDueDate ? formatLocalDate(person.nextActionDueDate, 'long') : null },
    { label: 'POC due', value: person.nextActionDueDatePoc ? formatLocalDate(person.nextActionDueDatePoc, 'long') : null },
    { label: 'Last call', value: person.lastCallAt ? formatInstant(person.lastCallAt, timezone) : null },
    { label: 'Last email', value: person.lastEmailAt ? formatInstant(person.lastEmailAt, timezone) : null },
    { label: 'Meeting link', value: person.meetingUrl ? <a href={person.meetingUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">Join</a> : null },
    { label: 'Recording', value: person.recordingUrl && mayAddMeeting ? <Link href={`/meetings/new?personId=${person.id}&url=${encodeURIComponent(person.recordingUrl)}`} className="text-brand-700 hover:underline">Add meeting</Link> : null },
    { label: 'Booking', value: person.bookingId },
  ]);
  return <Card title="CRM profile">
    <div className="space-y-5 p-4">
      {profile.length ? <RecordFields items={profile} /> : <p className="text-[13px] text-ink-500">The CRM holds nothing else on them yet.</p>}
      {person.tags.length ? <div className="space-y-1.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">Tags</div>
        <div className="flex flex-wrap gap-1">{person.tags.map((t) => <span key={t} className="rounded border border-line bg-canvas px-1.5 py-0.5 text-[11.5px] text-ink-700" title={t}>{optionLabel(t)}</span>)}</div>
      </div> : null}
      {person.leadSourceNotes ? <div className="space-y-1.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">Lead source notes</div>
        <p className="max-w-[75ch] whitespace-pre-line text-[13px] text-ink-800">{person.leadSourceNotes}</p>
      </div> : null}
      {latest.length || person.lastNote ? <div className="space-y-3 border-t border-line pt-4">
        <div className="text-[12px] font-semibold text-ink-700">Latest in the CRM</div>
        {latest.length ? <RecordFields items={latest} /> : null}
        {person.lastNote ? <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">Last note</div>
          <p className="max-w-[75ch] whitespace-pre-line rounded-lg border border-line bg-canvas/60 px-3 py-2 text-[13px] text-ink-800">{person.lastNote}</p>
        </div> : null}
      </div> : null}
    </div>
    <div className="border-t border-line px-4 py-2.5 text-[11.5px] text-ink-500">
      CRM id <span className="font-mono">{person.id}</span> · changed in the CRM {formatInstant(person.twentyUpdatedAt, timezone)} · synced {formatInstant(person.syncedAt, timezone)}
    </div>
  </Card>;
}
