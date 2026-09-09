import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { canManageEnrollment, canSnoozeFreely, isAdmin, isPodLeader } from '@/lib/auth/rbac';
import { getTaskBrief } from '@/lib/brief';
import { nextWorkingDaySnooze } from '@/lib/engine/tasks';
import { cachedPersonName } from '@/lib/person-cache';
import { getSettings } from '@/lib/settings';
import { ACTION_LABELS, channelOf } from '@/lib/sequences/steps';
import { filterOptions, listTaskGroups, parseChannel, parseTab, TASK_CHANNELS, type TaskChannel, type TaskTab } from '@/lib/tasks-query';
import { ActionIcon, IconChevronLeft, IconChevronRight } from '@/components/icons';
import { TaskActions } from '@/components/tasks/task-actions';
import { TaskBriefPanel } from '@/components/tasks/task-brief';
import { SuggestedApproach } from '@/components/tasks/suggested-approach';
import { TaskComposer } from '@/components/tasks/task-composer';
import { TaskFilters } from '@/components/tasks/task-filters';
import { TaskFlash } from '@/components/tasks/task-flash';
import { TaskList } from '@/components/tasks/task-list';
import { CrmHistory } from '@/components/people/crm-history';
import { Avatar, Badge, EmptyState, Notice, RecordFields, Surface, Tabs, Toolbar } from '@/components/ui';

type Search = { tab?: string; mode?: string; task?: string; pod?: string; fo?: string; type?: string; flash?: string; crmNotes?: string; crmEmails?: string; limit?: string };
const TAB_LABELS: Record<TaskTab, string> = { today: 'Today', overdue: 'Overdue', upcoming: 'Upcoming', done: 'Done' };
const CHANNEL_LABELS: Record<TaskChannel, string> = { CALL: 'Calls', EMAIL: 'Emails', LINKEDIN: 'LinkedIn' };

export default async function TasksPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser(); const sp = await searchParams;
  const tab = parseTab(sp.tab); const channel = parseChannel(sp.type); const mode = sp.mode === 'flow' ? 'flow' : 'list';
  const manager = isAdmin(user) || isPodLeader(user); const podId = manager ? sp.pod || null : null; const foUserId = manager ? sp.fo || null : null;
  const limit = Math.min(2000, Math.max(200, Number(sp.limit) || 200));
  const [{ rows, counts, channelCounts, today, total, held }, options, settings] = await Promise.all([listTaskGroups(user, { tab, podId, foUserId, channel }, new Date(), limit), filterOptions(user), getSettings()]);
  const base = new URLSearchParams({ tab, mode });
  if (podId) base.set('pod', podId); if (foUserId) base.set('fo', foUserId); if (channel) base.set('type', channel); if (limit > 200) base.set('limit', String(limit));
  const href = (patch: Record<string, string | null>) => { const next = new URLSearchParams(base); for (const [k,v] of Object.entries(patch)) { if (v === null) next.delete(k); else next.set(k,v); } return '/tasks?' + next.toString(); };
  // A ?task= that is not in this tab used to fall through to the first row, so a link from Home
  // or a bookmark opened somebody else's touch with the composer and the Done button attached to
  // it. The requested task is opened on its own if it is this user's; otherwise the screen says so.
  const requested = sp.task?.trim() || null;
  const inView = rows.find(r => r.id === requested || r.childIds.includes(requested ?? '')) ?? null;
  const selected = inView ?? (requested ? null : rows[0] ?? null);
  const index = selected ? rows.findIndex(r => r.id === selected.id) : -1;
  const following = index >= 0 ? rows[index + 1] ?? (rows.length > 1 ? rows[0] : null) : rows[0] ?? null;
  const nextUrl = following ? href({ task: following.id }) : href({ task: null });
  const prevUrl = index > 0 ? href({ task: rows[index - 1].id }) : null;
  const brief = selected ? await getTaskBrief(selected.id, user) : requested ? await getTaskBrief(requested, user) : null;
  const missing = Boolean(requested && !inView && !brief);
  const nextWorkingDay = nextWorkingDaySnooze(today, settings.rules.workingDays);
  const dispositions = settings.rules.callDispositions.map(d => ({ key: d.key, label: d.label, answered: d.answered }));
  const skipReasons = settings.rules.skipReasons.map(r => ({ key: r.key, label: r.label, exit: r.exit }));
  const openModules = brief?.modules.filter(m => m.task.state === 'PENDING') ?? [];
  const listRows = rows.map(t => ({ id: t.id, childActions: t.childActions, personName: cachedPersonName(t.enrollment.person), companyName: t.enrollment.person.companyName, label: [...new Set(t.childActions.map(c => ACTION_LABELS[c.action]))].join(' + '), action: t.action, stepIndex: t.stepIndex, stepDay: t.stepDay, due: t.snoozedTo ?? t.dueDate, snoozed: Boolean(t.snoozedTo), state: t.state, foName: t.fo.name, campaignName: t.enrollment.campaign?.name ?? null }));
  return <div className="space-y-4 px-6 pb-8 pt-2">
    <Surface flush><Tabs inset={false} current={tab} tabs={(['today','overdue','upcoming','done'] as TaskTab[]).map(t => ({ key: t, label: TAB_LABELS[t], href: href({ tab: t, task: null }), count: counts[t] }))} />
      <Toolbar><Link href={href({ type: null, task: null })} className={channel ? 'chip-muted' : 'chip'}>All types</Link>{TASK_CHANNELS.map(c => <Link key={c} href={href({ type: c, task: null })} className={channel === c ? 'chip' : 'chip-muted'}><ActionIcon action={c} size={13} />{CHANNEL_LABELS[c]}<strong className="ml-1">{channelCounts[c]}</strong></Link>)}<span className="w-full sm:ml-auto sm:w-auto"><TaskFilters pods={options.pods} fos={options.fos} podId={podId} foUserId={foUserId} mode={mode} /></span></Toolbar>
    </Surface>
    {sp.flash && <TaskFlash message={sp.flash.slice(0,300)} />}
    {missing ? <Notice tone="warn">That task is not in your list any more. It may have been completed, cancelled, or reassigned.</Notice> : null}
    {requested && !inView && brief ? <Notice tone="info">Showing one touch that is not in <strong>{TAB_LABELS[tab]}</strong>. <Link href={href({ task: null })} className="font-semibold underline">Back to the list</Link></Notice> : null}
    {held ? <Notice tone="info"><strong>{held}</strong> {held === 1 ? 'touch is' : 'touches are'} held while their campaign is paused. <Link href="/campaigns" className="font-semibold underline">Open campaigns</Link> to resume.</Notice> : null}
    {!rows.length && !brief ? <Surface><EmptyState title={'No ' + TAB_LABELS[tab].toLowerCase() + ' tasks'} icon={<ActionIcon action={channel ?? 'EMAIL'} size={22} />}
      /* An empty Today with work sitting in Overdue is the one case where the FO must not be left
         looking at a clear screen: send them to the tab that actually has the work. */
      action={tab !== 'overdue' && counts.overdue ? <Link href={href({ tab: 'overdue', task: null })} className="btn-primary"><strong>{counts.overdue}</strong> overdue {counts.overdue === 1 ? 'task' : 'tasks'} waiting</Link> : tab !== 'upcoming' && counts.upcoming ? <Link href={href({ tab: 'upcoming', task: null })} className="btn-secondary"><strong>{counts.upcoming}</strong> upcoming</Link> : undefined} /></Surface> : <>
      {mode === 'flow' && <div className="flex items-center gap-3 rounded-xl border border-brand-200 bg-brand-50 p-3"><strong>{index + 1} / {total}</strong><span className="text-sm text-ink-500">Task flow</span><div className="ml-auto flex gap-2">{prevUrl && <Link aria-label="Previous task" href={prevUrl} className="btn-secondary btn-sm"><IconChevronLeft size={14} /></Link>}{following && <Link href={nextUrl} className="btn-secondary btn-sm">Next<IconChevronRight size={14} /></Link>}<Link href={href({ mode: 'list', task: selected?.id ?? null })} className="btn-secondary btn-sm">Back to list</Link></div></div>}
      <div className={mode === 'flow' ? 'grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]' : 'grid items-start gap-4 xl:grid-cols-[300px_minmax(0,1fr)] 2xl:grid-cols-[300px_minmax(0,1fr)_360px]'}>
        {mode === 'list' && <Surface flush className="max-h-[65vh] overflow-y-auto scroll-thin xl:sticky xl:top-4 xl:max-h-[calc(100vh-17rem)]"><TaskList key={tab + '-' + (channel ?? '')} rows={listRows} selectedId={selected?.id ?? null} today={today} showFo={manager} hrefTemplate={href({ task: '__ID__' })} dispositions={dispositions} skipReasons={skipReasons} fos={options.fos} nextWorkingDay={nextWorkingDay} canPickSnoozeDate={canSnoozeFreely(user)} bulkEnabled={tab !== 'done'} />{rows.length < total && <Link href={href({ limit: String(limit + 200) })} className="btn-ghost m-3">Load more · <strong>{total - rows.length}</strong></Link>}</Surface>}
        <div className="min-w-0 space-y-4">{brief && <Surface flush>
          <header className="border-b border-line bg-gradient-to-r from-brand-50/70 to-white p-5"><div className="mb-4 flex items-center gap-3"><Avatar name={brief.personName} shape="circle" size={44} /><div><Link href={'/people/' + brief.person.id} className="text-xl font-semibold tracking-tight hover:text-brand-700">{brief.personName}</Link><div className="mt-1 text-sm font-semibold text-ink-700">{brief.person.jobTitle ?? 'Title missing'}</div></div><Badge tone={openModules.length ? 'green' : 'gray'} className="ml-auto">{openModules.length ? 'In progress' : 'Resolved'}</Badge></div>
            <RecordFields items={[{ label:'Company', value:brief.person.companyName },{ label:'Campaign', value:brief.task.enrollment.campaign ? <Link href={'/campaigns/' + brief.task.enrollment.campaign.id}>{brief.task.enrollment.campaign.name}</Link> : null },{ label:'Sequence', value:<Link href={'/sequences/' + brief.task.enrollment.sequence.id}>{brief.enrollment.sequenceName}</Link> },{ label:'Business day', value:brief.task.stepDay },{ label:'Due', value:brief.task.snoozedTo ?? brief.task.dueDate },{ label:'Assigned to', value:brief.enrollment.foName }]} />
          </header>
          {brief.task.enrollment.status === 'PAUSED' ? <div className="border-b border-line px-5 py-4"><Notice tone="warn">This campaign is paused, so these touches are held. {brief.task.enrollment.campaign ? <Link href={'/campaigns/' + brief.task.enrollment.campaign.id} className="font-semibold underline">Open the campaign</Link> : null}</Notice></div> : null}
          <div className="divide-y divide-line">{brief.modules.map(({task,action}) => <div key={task.id} className="space-y-4 p-5">
            {task.action === 'EMAIL' && (!brief.person.email || brief.person.badEmail) && <Notice tone="warn">Email needs verification. <Link href={'/enrichment?q=' + encodeURIComponent(brief.personName)} className="font-semibold underline">Review contact data</Link></Notice>}
            <TaskComposer key={task.id} taskId={task.id} label={ACTION_LABELS[task.action]} subject={action.subject} body={action.body} html={action.html} channel={channelOf(task.action)} revision={task.draftRevision} readOnly={task.state !== 'PENDING'} phone={brief.person.phone} clickToCall={Boolean(settings.rules.clickToCallUrl)} />
            {task.state === 'PENDING' ? <TaskActions taskId={task.id} action={task.action} nextUrl={openModules.length > 1 ? href({ task: openModules.find(m => m.task.id !== task.id)?.task.id ?? task.id }) : nextUrl} prevUrl={prevUrl} twentyUrl={brief.twentyUrl} nextWorkingDay={nextWorkingDay} canPickSnoozeDate={canSnoozeFreely(user)} dispositions={dispositions} skipReasons={skipReasons} steps={brief.steps} currentStep={brief.currentStep} canManageEnrollment={canManageEnrollment(user, { foUserId: task.foUserId, podId: task.enrollment.podId })} keyboardEnabled={openModules[0]?.task.id === task.id} /> : <RecordFields items={[{label:'Result',value:task.state},{label:'Outcome',value:task.disposition ? dispositions.find(d => d.key === task.disposition)?.label ?? task.disposition : task.skipReason ?? task.cancelReason},{label:'Logged note',value:task.note}]} />}
          </div>)}</div>
        </Surface>}</div>
        {brief && <aside className="min-w-0 space-y-4 xl:col-start-2 2xl:col-auto"><TaskBriefPanel brief={brief} timezone={user.timezone} /><SuggestedApproach canConfigure={isAdmin(user)} /><CrmHistory personId={brief.person.id} timezone={user.timezone} baseHref={href({ task: brief.task.id })} notesAfter={sp.crmNotes} emailsAfter={sp.crmEmails} /></aside>}
      </div>
    </>}
  </div>;
}
