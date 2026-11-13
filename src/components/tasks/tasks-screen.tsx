import { Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import { PageFrame } from '@/components/page-frame';
import { filterParam, sectionDefaults } from '@/lib/default-filters';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { canManageEnrollment, canSnoozeFreely, isAdmin, isPodLeader, canSeeAllPods, canActOnTask, whyNotWorkTask } from '@/lib/auth/rbac';
import { getColdTaskBrief, getTaskBrief, type ColdTaskBrief, type TaskBrief } from '@/lib/brief';
import { nextWorkingDaySnooze, snoozeDefault } from '@/lib/engine/tasks';
import { getSettings } from '@/lib/settings';
import { logCallOutcomes, outcomeLabel } from '@/lib/call-outcomes';
import { ACTION_LABELS, channelOf } from '@/lib/sequences/steps';
import { callGate, pendingFormBlock } from '@/lib/calls/gate';
import { openCallItems } from '@/lib/calls/link';
import { filterOptions, flowCounter, heldWords,listNextActionItems, listTaskGroups, nextActionListInclude, parseChannel, parseTab, rowSubject, TASK_CHANNELS, TASK_TABS, type NextActionListRow, type TaskAudience, type TaskChannel, type TaskTab } from '@/lib/tasks-query';
import { ActionIcon, IconCampaigns, IconChevronLeft, IconChevronRight } from '@/components/icons';
import { prisma } from '@/lib/db';
import { nextActionAccess } from '@/lib/next-actions';
import { emailCloseWords, mailTrackedFor } from '@/lib/mail/graph-mail';
import { bounceWords } from '@/lib/mail/cold-email';
import { coldCues, type ColdCue } from '@/lib/sandbox/cues';
import { SubjectBadges } from '@/components/subject-badges';
import { channelBlock } from '@/lib/task-cues';
import { assignableOwners, needsNewOwner } from '@/lib/outreach/ownership';
import { coldRef, COLD_CAMPAIGNS_HREF, subjectHref } from '@/lib/subject';
import { CallButton } from '@/components/calls/call-button';
import { LogCallButton } from '@/components/calls/log-call';
import { NeedsNewOwner } from '@/components/sandbox/needs-new-owner';
import { CreateTaskButton } from '@/components/tasks/create-task-button';
import { TaskActions } from '@/components/tasks/task-actions';
import { PersonBadges, TaskBriefPanel } from '@/components/tasks/task-brief';
import { ColdBriefPanel } from '@/components/tasks/cold-brief';
import { NextActionList, NextActionPanel, nextSubject } from '@/components/tasks/next-action-list';
import { LinkedInFollowUpList, LinkedInFollowUpPanel } from '@/components/tasks/linkedin-follow-ups';
import { LinkedInNeedsOwnerSection } from '@/components/linkedin/needs-owner-section';
import { accountViews, followUpInclude, listFollowUpItems } from '@/lib/linkedin/tasks-view';
import { consoleProfileLink } from '@/lib/linkedin/keys';
import { normalizeLinkedin } from '@/lib/sandbox/normalize';
import { SuggestedApproach } from '@/components/tasks/suggested-approach';
import { TaskComposer } from '@/components/tasks/task-composer';
import { TaskFilters } from '@/components/tasks/task-filters';
import { TaskFlash } from '@/components/tasks/task-flash';
import { TaskList } from '@/components/tasks/task-list';
import { CrmHistory } from '@/components/people/crm-history';
import { Avatar, Badge, EmptyState, Notice, RecordFields, Surface, Tabs, Toolbar, type BadgeTone } from '@/components/ui';

export type TasksSearch = { tab?: string; mode?: string; task?: string; next?: string; li?: string; pod?: string; fo?: string; type?: string; flash?: string; crmNotes?: string; crmEmails?: string; limit?: string; audience?: string; replied?: string };
const TAB_LABELS: Record<TaskTab, string> = { today: 'Today', overdue: 'Overdue', upcoming: 'Upcoming', done: 'Done' };
const CHANNEL_LABELS: Record<TaskChannel, string> = { CALL: 'Calls', EMAIL: 'Emails', LINKEDIN: 'LinkedIn' };

/** What an empty tab says. Assembling it from the tab label produced "No done tasks". */
const EMPTY_TITLES: Record<TaskTab, string> = {
  today: 'Nothing due today',
  overdue: 'Nothing overdue',
  upcoming: 'Nothing scheduled yet',
  done: 'Nothing finished in the last 30 days',
};

/** What the open task belongs to, first and large: its campaign (or, outside one, its sequence), the step, and when it ends. */
function CampaignBand({ task, stepIndex, stepCount, sequenceName, cold }: { task: TaskBrief['task']; stepIndex: number; stepCount: number; sequenceName: string; cold: boolean }) {
  const campaign = task.enrollment.campaign;
  const ends = campaign?.endDate ? new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${campaign.endDate}T12:00:00Z`)) : null;
  const name = campaign ? campaign.name : sequenceName;
  // One campaign page for both kinds (B134); a cold one shows Cold outreach's tabs.
  const href = campaign ? '/campaigns/' + campaign.id : cold ? null : '/sequences/' + task.enrollment.sequence.id;
  // The name has the whole second row to itself; the facts sit small in the top-right corner.
  return <div className="flex items-start gap-3 rounded-t-[inherit] bg-brand-900 px-5 py-3.5 text-white">
    <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/10 text-[#d5e9ad]"><IconCampaigns size={17} /></span>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-3">
        <span className="flex-1 text-[12px] text-brand-200">{campaign ? 'Campaign' : 'Outreach'}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] leading-none">
          <span className="rounded-full bg-white/10 px-2 py-1 tabular-nums text-white">Step {stepIndex + 1} of {stepCount}</span>
          {ends ? <span className="rounded-full bg-white/10 px-2 py-1 text-brand-100">Ends {ends}</span> : null}
          {campaign?.status === 'PAUSED' ? <span className="rounded-full bg-amber-300/20 px-2 py-1 text-amber-100">Paused</span> : null}
        </span>
      </div>
      {href ? <Link href={href} className="mt-1 block break-words text-[19px] font-semibold leading-snug tracking-[-0.01em] text-white hover:text-[#dfefc1]">{name}</Link> : <span className="mt-1 block break-words text-[19px] font-semibold leading-snug tracking-[-0.01em] text-white">{name}</span>}
    </div>
  </div>;
}

/**
 * The screen's columns. In list mode the contact card sits beside the composer from 1280px (N057):
 * three columns, the list and the card a little narrower until 1536px. With no card, two.
 */
export function taskGridClass(mode: 'flow' | 'list', card: boolean): string {
  if (mode === 'flow') return 'grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]';
  return card ? 'grid items-start gap-4 xl:grid-cols-[248px_minmax(0,1fr)_288px] 2xl:grid-cols-[300px_minmax(0,1fr)_360px]' : 'grid items-start gap-4 xl:grid-cols-[300px_minmax(0,1fr)]';
}

/** Whose task a task id is: a CRM person's, or a cold contact's. */
async function taskKind(id: string): Promise<'person' | 'cold' | null> {
  const t = await prisma.task.findUnique({ where: { id }, select: { enrollment: { select: { personId: true, sandboxContactId: true } } } });
  return t ? (t.enrollment.personId ? 'person' : t.enrollment.sandboxContactId ? 'cold' : null) : null;
}

/** Now as a datetime-local value in the reader's zone, for Log a call. */
const localNow = (timezone: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(' ', 'T');

/**
 * The Tasks screen (cold outreach PLAN 4.3). One screen, two audiences (D2): `all` on /tasks lists
 * CRM and cold work together with no tag on the rows; `cold` is Cold outreach > Tasks, the same
 * screen filtered to cold work. Creating a task here stays CRM-only; a cold contact's next steps are
 * set on its own page, in the section.
 */
export async function TasksScreen({ sp, audience, basePath, header }: { sp: TasksSearch; audience: TaskAudience; basePath: string; /** Cold outreach's own header and tab bar, when the section mounts the screen. */ header?: ReactNode }) {
  const user = await requireUser();
  const tab = parseTab(sp.tab); const channel = parseChannel(sp.type); const mode = sp.mode === 'flow' ? 'flow' : 'list';
  // Everyone reads every list and gets the pod and FO filters; a junior opens on their own name.
  // `manager` only decides the wording of the paused notice, which names an action only leaders have.
  const manager = isAdmin(user) || isPodLeader(user);
  const filters = canSeeAllPods(user);
  // Absent filters mean the reader's own pod (and, for a junior, their own name); an empty one means All.
  const defaults = filters ? await sectionDefaults(user) : { podId: null, podOwnerValue: null, foUserId: null };
  const podId = filters ? filterParam(sp.pod, defaults.podId) : null; const foUserId = filters ? filterParam(sp.fo, defaults.foUserId) : null;
  const limit = Math.min(2000, Math.max(200, Number(sp.limit) || 200));
  const now = new Date();
  const listFilters = { tab, podId, foUserId, channel, audience };
  const [groups, nexts, options, settings, taskAccess, stranded, linkedins] = await Promise.all([
    listTaskGroups(user, listFilters, now, limit),
    // Next actions (outside any campaign) are work in these same tabs, counted with the tasks (N030).
    listNextActionItems(user, listFilters, now, limit),
    filterOptions(user), getSettings(), nextActionAccess(user),
    // A removed rep's open next steps, CRM ones too, wait here for their pods' leaders (N034).
    manager ? needsNewOwner(isAdmin(user) ? null : user.podIds) : Promise.resolve([]),
    // Follow-ups Cadence opened (src/lib/linkedin): replies to answer and LinkedIn tasks, counted with the rest.
    listFollowUpItems(user, listFilters, now, limit),
  ]);
  const { rows, today, heldBy } = groups;
  const counts = Object.fromEntries(TASK_TABS.map((t) => [t, groups.counts[t] + nexts.counts[t] + linkedins.counts[t]])) as Record<TaskTab, number>;
  const channelCounts = Object.fromEntries(TASK_CHANNELS.map((c) => [c, groups.channelCounts[c] + nexts.channelCounts[c] + linkedins.channelCounts[c]])) as Record<TaskChannel, number>;
  const strandedNext = stranded.filter((s) => s.nextSteps);
  const owners = strandedNext.length ? await assignableOwners(user) : [];
  // A filter on someone outside the pods' FOs (an admin's own tasks, from Home) still shows their name.
  if (foUserId && !options.fos.some((f) => f.id === foUserId)) {
    const who = await prisma.user.findUnique({ where: { id: foUserId }, select: { id: true, name: true } });
    if (who) options.fos.push({ id: who.id, name: who.name, podIds: [] });
  }
  const nextInTab = nexts.rows;
  const base = new URLSearchParams({ tab, mode });
  if (filters) { base.set('pod', podId ?? ''); base.set('fo', foUserId ?? ''); } if (channel) base.set('type', channel); if (limit > 200) base.set('limit', String(limit));
  const href = (patch: Record<string, string | null>) => { const next = new URLSearchParams(base); for (const [k,v] of Object.entries(patch)) { if (v === null) next.delete(k); else next.set(k,v); } return basePath + '?' + next.toString(); };
  // A ?task= that is not in this tab used to fall through to the first row, so a link from Home
  // or a bookmark opened somebody else's touch with the composer and the Done button attached to
  // it. The requested task is opened on its own if it is this user's; otherwise the screen says so.
  const requestedLi = sp.li?.trim() || null;
  const requestedNext = requestedLi ? null : sp.next?.trim() || null;
  const requested = requestedNext || requestedLi ? null : sp.task?.trim() || null;
  const inView = rows.find(r => r.id === requested || r.childIds.includes(requested ?? '')) ?? null;
  const selected = requestedNext || requestedLi ? null : inView ?? (requested ? null : rows[0] ?? null);
  // A next action opens when asked for, or first when the tab has no task to open. One outside the
  // list opens only if it is work this screen holds: a CRM person's, or a live cold contact's.
  const holds = (n: NextActionListRow) => (n.person ? audience === 'all' : Boolean(n.sandboxContact && n.sandboxContact.status === 'ACTIVE'));
  const requestedRow = requestedNext && !nextInTab.some((n) => n.id === requestedNext) ? await prisma.nextAction.findUnique({ where: { id: requestedNext }, include: nextActionListInclude }) : null;
  const selectedNext = requestedNext ? nextInTab.find((n) => n.id === requestedNext) ?? (requestedRow && holds(requestedRow) ? requestedRow : null) : !selected && !requested && !requestedLi ? nextInTab[0] ?? null : null;
  // A LinkedIn task opens when asked for, or first when the tab has nothing else to open.
  const liInTab = linkedins.rows;
  const requestedLiRow = requestedLi && !liInTab.some((f) => f.id === requestedLi) ? await prisma.linkedInFollowUp.findUnique({ where: { id: requestedLi }, include: followUpInclude }) : null;
  const selectedLi = requestedLi ? liInTab.find((f) => f.id === requestedLi) ?? (requestedLiRow && requestedLiRow.foUserId ? requestedLiRow : null) : !selected && !requested && !selectedNext ? liInTab[0] ?? null : null;
  const liIndex = selectedLi ? liInTab.findIndex((f) => f.id === selectedLi.id) : -1;
  const afterLi = liIndex >= 0 && liInTab[liIndex + 1] ? href({ li: liInTab[liIndex + 1].id, next: null, task: null }) : nextInTab[0] ? href({ next: nextInTab[0].id, li: null, task: null }) : rows[0] ? href({ task: rows[0].id, li: null, next: null }) : href({ task: null, next: null, li: null });
  const liAccounts = await accountViews(selectedLi?.accountId ? [selectedLi.accountId] : []);
  const selectedLiFo = selectedLi?.foUserId ? options.fos.find((f) => f.id === selectedLi.foUserId) : null;
  const mayWorkLi = selectedLi?.foUserId ? canActOnTask(user, { foUserId: selectedLi.foUserId, podId: null }) || (isPodLeader(user) && (selectedLiFo?.podIds ?? []).some((id) => user.podIds.includes(id))) : false;
  const nextIndex = selectedNext ? nextInTab.findIndex((n) => n.id === selectedNext.id) : -1;
  const afterNext = nextIndex >= 0 && nextInTab[nextIndex + 1] ? href({ next: nextInTab[nextIndex + 1].id, task: null }) : rows[0] ? href({ task: rows[0].id, next: null }) : href({ task: null, next: null });
  const index = selected ? rows.findIndex(r => r.id === selected.id) : -1;
  const following = index >= 0 ? rows[index + 1] ?? (rows.length > 1 ? rows[0] : null) : rows[0] ?? null;
  const nextUrl = following ? href({ task: following.id }) : href({ task: null });
  const prevUrl = index > 0 ? href({ task: rows[index - 1].id }) : null;
  // The brief: a CRM person's (getTaskBrief), or a cold contact's (getColdTaskBrief, B058).
  const briefId = selected?.id ?? requested;
  const kind = selected ? (selected.enrollment.person ? 'person' : 'cold') : briefId ? await taskKind(briefId) : null;
  const [brief, cold] = await Promise.all([
    briefId && kind === 'person' ? getTaskBrief(briefId, user) : Promise.resolve(null),
    briefId && kind === 'cold' ? getColdTaskBrief(briefId, user) : Promise.resolve(null),
  ]);
  const gate = brief ? await callGate(user, { personId: brief.person.id, phone: brief.person.phone, state: brief.person.city?.split(',').pop()?.trim() ?? null, optedOut: brief.person.optedOut, dnd: brief.person.dnd, email: brief.person.email, linkedinUrl: brief.person.linkedinUrl }) : null;
  const missing = Boolean(requested && !inView && !brief && !cold);
  const nextWorkingDay = nextWorkingDaySnooze(today, settings.rules.workingDays);
  // The CRM's quick Log call offers Settings > Rules' outcomes, exactly as before (owner: "CRM Log call
  // stays as it is"). Only a finished task's label reads the one outcome list, so an outcome the
  // post-call form recorded never shows as a raw key (N055).
  const dispositions = logCallOutcomes(settings.rules).map(d => ({ key: d.key, label: d.label, answered: d.answered }));
  // Skipping one step must not end the sequence by default: reasons that end it come last.
  const skipReasons = settings.rules.skipReasons.map(r => ({ key: r.key, label: r.label, exit: r.exit })).sort((a, b) => Number(a.exit !== 'none') - Number(b.exit !== 'none'));
  // A step holds several modules. With a channel filter on, the module for that channel is the
  // one the FO came here for, so it leads - otherwise filtering to LinkedIn opened an email
  // composer and the filter and the screen disagreed. Open modules still come before resolved ones.
  const modules = ((brief ?? cold)?.modules ?? []).slice().sort((a, b) => {
    const open = Number(b.task.state === 'PENDING') - Number(a.task.state === 'PENDING');
    if (open) return open;
    if (!channel) return 0;
    return Number(channelOf(b.task.action) === channel) - Number(channelOf(a.task.action) === channel);
  });
  const openModules = modules.filter(m => m.task.state === 'PENDING');
  // Who a touchpoint in this pod can be handed to: the pod's active people.
  const delegatesFor = (podId: string | null) => podId ? options.fos.filter(f => f.podIds.includes(podId)).map(f => ({ id: f.id, name: f.name })) : [];
  // The header badge says where this touch stands against today, not a state every open task shares.
  const shown = (brief ?? cold)?.task ?? null;
  const dueOn = shown ? shown.snoozedTo ?? shown.dueDate : null;
  const dueState: { tone: BadgeTone; label: string } = !openModules.length ? { tone: 'gray', label: 'Resolved' } : dueOn && dueOn < today ? { tone: 'red', label: 'Overdue' } : dueOn === today ? { tone: 'green', label: 'Due today' } : { tone: 'blue', label: 'Upcoming' };
  // Whether this reader works a task, and if not, why (B159): said where its controls would be.
  const mayWorkTask = (t: { foUserId: string; enrollment: { podId: string | null } }) => canActOnTask(user, { foUserId: t.foUserId, podId: t.enrollment.podId });
  const whyNot = (t: { fo: { name: string }; enrollment: { pod: { name: string } | null } }) => whyNotWorkTask(toActor(user), t.fo.name, t.enrollment.pod?.name);
  const selectedNextFo = selectedNext ? options.fos.find((f) => f.id === selectedNext.foUserId) : null;
  const mayWorkNext = selectedNext ? canActOnTask(user, { foUserId: selectedNext.foUserId, podId: null }) || (isPodLeader(user) && (selectedNextFo?.podIds ?? []).some((id) => user.podIds.includes(id))) : false;

  // A cold contact on screen (a step or a next step): its full record for the call check, the call
  // steps "Called from another phone?" can close, a waiting form, and whether its rep's sent mail is read.
  const coldId = cold?.contact.id ?? (selectedNext && !selectedNext.person ? selectedNext.sandboxContactId : null);
  const [coldRow, callSteps, logBlocked, tracked] = coldId
    ? await Promise.all([
        prisma.sandboxContact.findUnique({ where: { id: coldId } }),
        openCallItems({ personId: null, sandboxContactId: coldId }, null),
        pendingFormBlock(user.id, user.timezone),
        mailTrackedFor([...(cold ? cold.modules.map((m) => m.task.foUserId) : []), ...(selectedNext ? [selectedNext.foUserId] : [])]),
      ])
    : ([null, [], null, new Set<string>()] as const);
  const coldGate = coldRow && coldRow.phone ? await callGate(user, coldRow) : null;
  const nowLocal = localNow(user.timezone);
  // A LinkedIn step opens the person in the LinkedIn Console, from the account last used with them.
  const liSubject = brief ? { personId: brief.person.id } : cold ? { sandboxContactId: cold.contact.id, personId: null } : null;
  const liLast = liSubject && modules.some((m) => channelOf(m.task.action) === 'LINKEDIN') ? await prisma.linkedInLink.findFirst({ where: liSubject, orderBy: { updatedAt: 'desc' }, select: { accountId: true } }) : null;
  const liKey = brief ? normalizeLinkedin(brief.person.linkedinUrl) : cold ? normalizeLinkedin(cold.contact.linkedinHref) : null;
  const liConsoleHref = liKey ? consoleProfileLink(liLast?.accountId ?? null, liKey) : null;
  const coldCallSlot = (coldName: string, taskId: string | null, nextActionId: string | null) => coldRow ? <span className="flex flex-wrap items-start gap-2">
    {coldRow.phone ? <CallButton phone={coldRow.phone} template={settings.rules.clickToCallUrl} taskId={taskId} nextActionId={nextActionId} sandboxContactId={coldRow.id} blocked={coldGate?.blocked} warning={coldGate?.warning} ariaLabel={`Call ${coldName}`} /> : <span className="text-[12.5px] text-ink-600">No phone number: add one on the contact, or skip this step.</span>}
    {/* B161: a cold call closes with its call and its form; another phone's call is logged, then its form opens. */}
    <LogCallButton sandboxContactId={coldRow.id} name={coldName} steps={callSteps.map((s) => ({ key: `${s.kind}:${s.id}`, words: s.words }))} now={nowLocal} blocked={logBlocked} label="Called from another phone?" className="btn-secondary" />
  </span> : null;

  // N031: after "They replied" on a cold contact, ask what comes next: a next step, or Move to CRM.
  const replied = sp.replied ? await prisma.sandboxContact.findUnique({ where: { id: sp.replied }, select: { id: true, firstName: true, lastName: true, status: true } }) : null;
  // PLAN 4.0: a cold contact's warning chips on its row and in its panel (Wrong number, bounces, Form due, Shared line...).
  const cues: Map<string, ColdCue> = await coldCues([...rows.flatMap((t) => (t.enrollment.sandboxContact && !t.enrollment.person ? [t.enrollment.sandboxContact.id] : [])), ...(selectedNext?.sandboxContact && !selectedNext.person ? [selectedNext.sandboxContact.id] : []), ...(cold ? [cold.contact.id] : [])], { today });
  const listRows = rows.map(t => { const who = rowSubject(t.enrollment); return { id: t.id, childActions: t.childActions, personName: who.name, companyName: who.companyName, label: [...new Set(t.childActions.map(c => ACTION_LABELS[c.action]))].join(' + '), parts: [...new Set(t.childActions.map(c => c.action))].map(a => ({ label: ACTION_LABELS[a], done: t.childActions.filter(c => c.action === a).every(c => c.state !== 'PENDING') })), action: t.action, stepIndex: t.stepIndex, stepDay: t.stepDay, due: t.snoozedTo ?? t.dueDate, snoozed: Boolean(t.snoozedTo), state: t.state, foName: t.fo.name, campaignName: t.enrollment.campaign?.name ?? null, warning: t.enrollment.sandboxContact && !t.enrollment.person ? bounceWords(t.enrollment.sandboxContact) : null, chips: t.enrollment.sandboxContact && !t.enrollment.person ? cues.get(t.enrollment.sandboxContact.id)?.chips : undefined }; });
  const shownCount = rows.length + nextInTab.length + liInTab.length;
  const tabTotal = counts[tab];
  return <PageFrame className="space-y-4 px-6 pb-8 pt-2">
    {header}
    <Surface flush><Tabs inset={false} current={tab} tabs={TASK_TABS.map(t => ({ key: t, label: TAB_LABELS[t], href: href({ tab: t, task: null }), count: counts[t] }))} />
      <Toolbar><Link href={href({ type: null, task: null })} className={channel ? 'chip-muted' : 'chip'}>All types</Link>{TASK_CHANNELS.map(c => <Link key={c} href={href({ type: c, task: null })} className={channel === c ? 'chip' : 'chip-muted'}><ActionIcon action={c} size={13} />{CHANNEL_LABELS[c]}<span className="ml-1 tabular-nums">{channelCounts[c]}</span></Link>)}<span className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto"><TaskFilters pods={options.pods} fos={options.fos} podId={podId} foUserId={foUserId} mode={mode} />{taskAccess.canSet && audience === 'all' ? <CreateTaskButton today={today} fos={taskAccess.fos} canAssign={taskAccess.canAssign} query={base.toString()} selfId={user.id} workingDays={settings.rules.workingDays} /> : null}</span></Toolbar>
    </Surface>
    {/* A campaign that starts this week has no tasks yet; it is still on the screen its work will land on. */}
    {sp.flash && <TaskFlash message={sp.flash.slice(0,300)} />}
    {replied && replied.status === 'ACTIVE' ? <Notice tone="info"><span className="flex flex-wrap items-center gap-x-3 gap-y-1"><span>{`${replied.firstName} ${replied.lastName}`.trim()} replied. What happens next?</span><Link href={subjectHref(coldRef(replied.id))} className="font-medium underline">Set a next step</Link><Link href={`${subjectHref(coldRef(replied.id))}?move=1`} className="font-medium underline">Move to CRM</Link></span></Notice> : null}
    {strandedNext.length ? <NeedsNewOwner stranded={strandedNext} owners={owners} /> : null}
    {audience === 'all' && isAdmin(user) ? <LinkedInNeedsOwnerSection user={user} scope="crm" /> : null}
    {missing ? <Notice tone="warn">That task is not in your list any more. It may have been completed, cancelled, or reassigned.</Notice> : null}
    {requested && !inView && (brief || cold) ? <Notice tone="info">Showing one touch that is not in <span className="font-medium">{TAB_LABELS[tab]}</span>. <Link href={href({ task: null })} className="font-medium underline">Back to the list</Link></Notice> : null}
    {heldBy.length ? <Notice tone="info">{heldWords(heldBy)}. {manager ? <Link href={audience === 'cold' ? COLD_CAMPAIGNS_HREF : '/campaigns'} className="font-medium underline">Open campaigns</Link> : 'Ask a pod leader to resume it.'}</Notice> : null}
    {!rows.length && !brief && !cold && !nextInTab.length && !selectedNext && !liInTab.length && !selectedLi ? <Surface><EmptyState title={EMPTY_TITLES[tab]} icon={<ActionIcon action={channel ?? 'EMAIL'} size={22} />}
      /* An empty Today with work sitting in Overdue is the one case where the FO must not be left
         looking at a clear screen: send them to the tab that actually has the work. */
      action={tab !== 'overdue' && counts.overdue ? <Link href={href({ tab: 'overdue', task: null })} className="btn-primary">View {counts.overdue} overdue {counts.overdue === 1 ? 'step' : 'steps'}</Link> : tab !== 'upcoming' && counts.upcoming ? <Link href={href({ tab: 'upcoming', task: null })} className="btn-secondary">View {counts.upcoming} upcoming</Link> : undefined} /></Surface> : <>
      {mode === 'flow' && <div className="flex items-center gap-3 rounded-xl border border-brand-200 bg-brand-50 p-3">{(selectedNext || selectedLi) && !brief && !cold ? <span className="font-medium">{selectedLi ? 'LinkedIn task' : 'Created task'}</span> : <span className="font-medium tabular-nums">{flowCounter(index, groups.total, counts[tab])}</span>}<span className="text-sm text-ink-500">Task flow</span><div className="ml-auto flex gap-2">{!selectedNext && prevUrl && <Link aria-label="Previous task" href={prevUrl} className="btn-secondary btn-sm"><IconChevronLeft size={14} /></Link>}{(selectedNext || selectedLi) && !brief && !cold ? <Link href={selectedLi ? afterLi : afterNext} className="btn-secondary btn-sm">Next<IconChevronRight size={14} /></Link> : following && <Link href={nextUrl} className="btn-secondary btn-sm">Next<IconChevronRight size={14} /></Link>}<Link href={href({ mode: 'list', task: selected?.id ?? null })} className="btn-secondary btn-sm">Back to list</Link></div></div>}
      <div className={taskGridClass(mode, Boolean(brief || cold))}>
        {mode === 'list' && <Surface flush className="max-h-[65vh] overflow-y-auto scroll-thin xl:sticky xl:top-4 xl:max-h-[calc(100vh-17rem)]">{liInTab.length ? <LinkedInFollowUpList items={liInTab} selectedId={selectedLi?.id ?? null} today={today} showFo={filters} href={(id) => href({ li: id, next: null, task: null })} /> : null}{nextInTab.length ? <NextActionList items={nextInTab} selectedId={selectedNext?.id ?? null} today={today} showFo={filters} href={(id) => href({ next: id, task: null })} /> : null}{rows.length ? <TaskList key={tab + '-' + (channel ?? '')} rows={listRows} selectedId={selected?.id ?? null} today={today} showFo={filters} hrefTemplate={href({ task: '__ID__' })} dispositions={dispositions} skipReasons={skipReasons} fos={options.fos} nextWorkingDay={nextWorkingDay} canPickSnoozeDate={canSnoozeFreely(user)} bulkEnabled={tab !== 'done' && user.role !== 'BIZ_OPS'} canReassign={isAdmin(user) || isPodLeader(user)} /> : null}{shownCount < tabTotal ? <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12px] text-ink-500"><span className="tabular-nums">Showing {shownCount} of {tabTotal}</span>{/* R08: past the 2,000 cap Load more could only reload the same rows. */}{limit < 2000 ? <Link href={href({ limit: String(limit + 200) })} className="btn-ghost btn-sm">Load more</Link> : <span>Use the filters or a type to see the rest.</span>}</div> : null}</Surface>}
        <div className="min-w-0 space-y-4">{selectedLi && <LinkedInFollowUpPanel item={selectedLi} account={selectedLi.accountId ? liAccounts.get(selectedLi.accountId) ?? null : null} today={today} timezone={user.timezone} nextUrl={afterLi} nextWorkingDay={snoozeDefault(today, selectedLi.dueDate ?? today, settings.rules.workingDays)} mayWork={tab !== 'done' && mayWorkLi} whyNot={mayWorkLi || !selectedLi.fo ? null : whyNotWorkTask(toActor(user), selectedLi.fo.name)} workingDays={settings.rules.workingDays} />}{selectedNext && <NextActionPanel done={tab === 'done'} item={selectedNext} today={today} timezone={user.timezone} nextUrl={afterNext} nextWorkingDay={snoozeDefault(today, selectedNext.dueDate, settings.rules.workingDays)} mayWork={mayWorkNext} whyNot={mayWorkNext ? null : whyNotWorkTask(toActor(user), selectedNext.fo.name)} workingDays={settings.rules.workingDays} callSlot={!selectedNext.person ? coldCallSlot(nextSubject(selectedNext).name, null, selectedNext.id) : null} warning={selectedNext.sandboxContact && !selectedNext.person ? bounceWords(selectedNext.sandboxContact) : null} chips={selectedNext.sandboxContact && !selectedNext.person ? cues.get(selectedNext.sandboxContact.id)?.chips : undefined} closeWords={!selectedNext.person ? emailCloseWords(tracked.has(selectedNext.foUserId)) : null} />}{brief && <Surface flush>
          <CampaignBand task={brief.task} stepIndex={brief.stepIndex} stepCount={brief.stepCount} sequenceName={brief.enrollment.sequenceName} cold={false} />
          <header className="border-b border-line bg-gradient-to-r from-brand-50/70 to-white p-5"><div className="mb-4 flex items-center gap-3"><Avatar name={brief.personName} shape="circle" size={44} /><div><Link href={'/people/' + brief.person.id} className="text-xl font-semibold tracking-tight hover:text-brand-700">{brief.personName}</Link><div className="mt-1 text-sm text-ink-500">{brief.person.jobTitle ?? 'Title missing'}</div></div><div className="ml-auto flex flex-wrap items-center justify-end gap-1.5"><PersonBadges person={brief.person} /><Badge tone={dueState.tone}>{dueState.label}</Badge></div></div>
            <RecordFields items={[{ label:'Company', value:brief.person.companyName },{ label:'Outreach', value:<Link href={'/sequences/' + brief.task.enrollment.sequence.id}>{brief.enrollment.sequenceName}</Link> },{ label:'Day', value:brief.task.stepDay },{ label:'Due', value:brief.task.snoozedTo ?? brief.task.dueDate },{ label:'Assigned to', value:brief.enrollment.foName }]} />
          </header>
          {brief.task.enrollment.status === 'PAUSED' ? <div className="border-b border-line px-5 py-4"><Notice tone="warn">This campaign is paused, so these touches are held. {brief.task.enrollment.campaign ? <Link href={'/campaigns/' + brief.task.enrollment.campaign.id} className="font-medium underline">Open the campaign</Link> : null}</Notice></div> : null}
          <div className="divide-y divide-line">{modules.map(({task,action}) => { const mayWork = mayWorkTask(task); return <div key={task.id} className="space-y-4 p-5">
            {/* N056: no address at all is said in the composer, and Done waits for one; a bounced one still asks for a check. */}
            {task.action === 'EMAIL' && brief.person.email && brief.person.badEmail && <Notice tone="warn">Email needs verification. <Link href={'/enrichment?q=' + encodeURIComponent(brief.personName)} className="font-medium underline">Review contact data</Link></Notice>}
            <TaskComposer key={task.id} taskId={task.id} label={ACTION_LABELS[task.action]} subject={action.subject} body={action.body} html={action.html} channel={channelOf(task.action)} revision={task.draftRevision} readOnly={task.state !== 'PENDING' || !mayWork} phone={brief.person.phone} callTemplate={settings.rules.clickToCallUrl} personId={brief.person.id} callBlocked={gate?.blocked ?? null} callWarning={gate?.warning ?? null} recipient={{ name: brief.personName, firstName: brief.person.firstName, email: brief.person.email }} profileUrl={brief.person.linkedinUrl} addDetailsHref={'/people/' + brief.person.id} consoleHref={liConsoleHref} />
            {task.state === 'PENDING' && mayWork ? <TaskActions fixedCalendar={brief.task.enrollment.scheduleDates.length > 0} taskId={task.id} action={task.action} nextUrl={nextUrl} variant={openModules.length > 1 ? 'module' : 'full'} prevUrl={prevUrl} twentyUrl={brief.twentyUrl} nextWorkingDay={snoozeDefault(today, dueOn ?? today, settings.rules.workingDays)} canPickSnoozeDate={canSnoozeFreely(user)} dispositions={dispositions} skipReasons={skipReasons} steps={brief.steps} currentStep={brief.currentStep} canManageEnrollment={canManageEnrollment(user, { foUserId: task.foUserId, podId: task.enrollment.podId })} delegates={delegatesFor(task.enrollment.podId)} currentFoId={task.foUserId} keyboardEnabled={openModules.length === 1} subjectName={brief.personName} stepLabel={task.label} doneBlocked={channelBlock(task.action, brief.person)} workingDays={settings.rules.workingDays} /> : task.state === 'PENDING' ? <Notice tone="info">{whyNot(task)}</Notice> : <RecordFields items={[{label:'Result',value:task.state === 'DONE' ? (task.completionSource?.startsWith('OBSERVED') ? 'Done: seen in the CRM' : 'Done') : task.state === 'SKIPPED' ? 'Skipped' : task.state === 'CANCELLED' ? 'Cancelled' : 'Open'},{label:'Outcome',value:task.disposition ? outcomeLabel(settings.rules, task.disposition) : task.skipReason ?? task.cancelReason},{label:'Logged note',value:task.note}]} />}
          </div>; })}</div>
          {openModules.length > 1 && mayWorkTask(openModules[0].task) ? <div className="border-t border-line p-5"><TaskActions fixedCalendar={brief.task.enrollment.scheduleDates.length > 0} variant="step" taskId={openModules[0].task.id} snoozeTaskIds={openModules.map(m => m.task.id)} action={openModules[0].task.action} nextUrl={nextUrl} prevUrl={prevUrl} twentyUrl={brief.twentyUrl} nextWorkingDay={snoozeDefault(today, dueOn ?? today, settings.rules.workingDays)} canPickSnoozeDate={canSnoozeFreely(user)} dispositions={dispositions} skipReasons={skipReasons} steps={brief.steps} currentStep={brief.currentStep} canManageEnrollment={canManageEnrollment(user, { foUserId: openModules[0].task.foUserId, podId: openModules[0].task.enrollment.podId })} delegates={delegatesFor(openModules[0].task.enrollment.podId)} currentFoId={openModules[0].task.foUserId} keyboardEnabled subjectName={brief.personName} stepLabel={openModules[0].task.label} workingDays={settings.rules.workingDays} /></div> : null}
        </Surface>}{cold ? coldTaskSurface(cold) : null}</div>
        {brief && <aside className="min-w-0 space-y-4"><TaskBriefPanel brief={brief} timezone={user.timezone} gate={gate} callTemplate={settings.rules.clickToCallUrl} /><SuggestedApproach canConfigure={isAdmin(user)} /><Suspense key={brief.person.id} fallback={<div className="surface h-40" />}><CrmHistory personId={brief.person.id} timezone={user.timezone} baseHref={href({ task: brief.task.id })} notesAfter={sp.crmNotes} emailsAfter={sp.crmEmails} /></Suspense></aside>}
        {cold && <aside className="min-w-0 space-y-4"><ColdBriefPanel brief={cold} timezone={user.timezone} gate={coldGate} callTemplate={settings.rules.clickToCallUrl} /><SuggestedApproach canConfigure={isAdmin(user)} /></aside>}
      </div>
    </>}
  </PageFrame>;

  /** A cold contact's step: the same surface as a CRM person's, with the contact's own page, "Cold contact", and no CRM link. */
  function coldTaskSurface(b: ColdTaskBrief) {
    const c = b.contact;
    const warning = bounceWords(c);
    // A contact opted out, removed or moved since this page was opened has no work left here (B212).
    const live = c.status === 'ACTIVE';
    const afterReplied = href({ task: following && following.id !== b.task.id ? following.id : null, replied: c.id });
    return <Surface flush>
      <CampaignBand task={b.task} stepIndex={b.stepIndex} stepCount={b.stepCount} sequenceName={b.enrollment.sequenceName} cold />
      <header className="border-b border-line bg-gradient-to-r from-brand-50/70 to-white p-5"><div className="mb-4 flex items-center gap-3"><Avatar name={b.name} shape="circle" size={44} /><div><Link href={b.href} className="text-xl font-semibold tracking-tight hover:text-brand-700">{b.name}</Link><div className="mt-1 text-sm text-ink-500">{c.jobTitle ?? 'Title missing'}</div></div><div className="ml-auto flex flex-wrap items-center justify-end gap-1.5"><Badge tone="sky">Cold contact</Badge>{cues.get(c.id)?.chips.length ? <SubjectBadges badge={null} chips={cues.get(c.id)!.chips} /> : warning ? <Badge tone="amber">{warning}</Badge> : null}<Badge tone={dueState.tone}>{dueState.label}</Badge></div></div>
        <RecordFields items={[{ label: 'Company', value: c.companyName }, { label: 'Outreach', value: b.enrollment.campaignName ?? b.enrollment.sequenceName }, { label: 'Day', value: b.task.stepDay }, { label: 'Due', value: b.task.snoozedTo ?? b.task.dueDate }, { label: 'Assigned to', value: b.enrollment.foName }]} />
      </header>
      {b.task.enrollment.status === 'PAUSED' ? <div className="border-b border-line px-5 py-4"><Notice tone="warn">This campaign is paused, so these touches are held. {b.task.enrollment.campaign ? <Link href={`/campaigns/${b.task.enrollment.campaign.id}`} className="font-medium underline">Open the campaign</Link> : null}</Notice></div> : null}
      {!live ? <div className="border-b border-line px-5 py-4"><Notice tone="warn">{c.status === 'MOVED' ? 'This contact is in the CRM now; work them on their People page.' : c.status === 'REMOVED' ? 'This contact was removed from Cold outreach; nothing here can be done.' : 'This contact asked not to be contacted; nothing here can be done.'}</Notice></div> : null}
      <div className="divide-y divide-line">{modules.map(({ task, action }) => { const mayWork = live && mayWorkTask(task); return <div key={task.id} className="space-y-4 p-5">
        <TaskComposer key={task.id} taskId={task.id} label={ACTION_LABELS[task.action]} subject={action.subject} body={action.body} html={action.html} channel={channelOf(task.action)} revision={task.draftRevision} readOnly={task.state !== 'PENDING' || !mayWork} phone={c.phone} callTemplate={settings.rules.clickToCallUrl} sandboxContactId={c.id} callBlocked={coldGate?.blocked ?? null} callWarning={coldGate?.warning ?? null} closeWords={task.action === 'EMAIL' ? emailCloseWords(tracked.has(task.foUserId)) : null} recipient={{ name: b.name, firstName: c.firstName, email: c.email }} profileUrl={c.linkedinHref} addDetailsHref={b.href} consoleHref={liConsoleHref} />
        {task.state === 'PENDING' && mayWork ? <TaskActions fixedCalendar={b.task.enrollment.scheduleDates.length > 0} taskId={task.id} action={task.action} nextUrl={nextUrl} variant={openModules.length > 1 ? 'module' : 'full'} prevUrl={prevUrl} twentyUrl={null} nextWorkingDay={snoozeDefault(today, dueOn ?? today, settings.rules.workingDays)} canPickSnoozeDate={canSnoozeFreely(user)} dispositions={dispositions} skipReasons={skipReasons} steps={b.steps} currentStep={b.currentStep} canManageEnrollment={canManageEnrollment(user, { foUserId: task.foUserId, podId: task.enrollment.podId })} delegates={delegatesFor(task.enrollment.podId)} currentFoId={task.foUserId} keyboardEnabled={openModules.length === 1} subjectName={b.name} stepLabel={task.label} doneBlocked={channelBlock(task.action, c)} callSlot={task.action === 'CALL' ? coldCallSlot(b.name, task.id, null) : null} afterRepliedUrl={afterReplied} endReasons="cold" workingDays={settings.rules.workingDays} /> : task.state === 'PENDING' ? (live ? <Notice tone="info">{whyNot(task)}</Notice> : null) : <RecordFields items={[{ label: 'Result', value: task.state === 'DONE' ? (task.completionSource?.startsWith('OBSERVED') ? 'Done: seen in Outlook' : 'Done') : task.state === 'SKIPPED' ? 'Skipped' : task.state === 'CANCELLED' ? 'Cancelled' : 'Open' }, { label: 'Outcome', value: task.disposition ? outcomeLabel(settings.rules, task.disposition) : task.skipReason ?? task.cancelReason }, { label: 'Logged note', value: task.note }]} />}
      </div>; })}</div>
      {live && openModules.length > 1 && mayWorkTask(openModules[0].task) ? <div className="border-t border-line p-5"><TaskActions fixedCalendar={b.task.enrollment.scheduleDates.length > 0} variant="step" taskId={openModules[0].task.id} snoozeTaskIds={openModules.map(m => m.task.id)} action={openModules[0].task.action} nextUrl={nextUrl} prevUrl={prevUrl} twentyUrl={null} nextWorkingDay={snoozeDefault(today, dueOn ?? today, settings.rules.workingDays)} canPickSnoozeDate={canSnoozeFreely(user)} dispositions={dispositions} skipReasons={skipReasons} steps={b.steps} currentStep={b.currentStep} canManageEnrollment={canManageEnrollment(user, { foUserId: openModules[0].task.foUserId, podId: openModules[0].task.enrollment.podId })} delegates={delegatesFor(openModules[0].task.enrollment.podId)} currentFoId={openModules[0].task.foUserId} keyboardEnabled subjectName={b.name} stepLabel={openModules[0].task.label} afterRepliedUrl={afterReplied} endReasons="cold" workingDays={settings.rules.workingDays} /></div> : null}
    </Surface>;
  }
}
