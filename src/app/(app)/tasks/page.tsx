import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { canManageEnrollment, canSnoozeFreely, isAdmin, isSeniorFo, toActor } from '@/lib/auth/rbac';
import { getTaskBrief, describeDue } from '@/lib/brief';
import { formatLocalDate } from '@/lib/dates';
import { nextWorkingDaySnooze } from '@/lib/engine/tasks';
import { cachedPersonName } from '@/lib/person-cache';
import { getSettings } from '@/lib/settings';
import { ACTION_LABELS } from '@/lib/sequences/steps';
import { filterOptions, listTasks, parseChannel, parseTab, TASK_CHANNELS, type TaskChannel, type TaskTab } from '@/lib/tasks-query';
import { ActionIcon } from '@/components/icons';
import { TaskActions } from '@/components/tasks/task-actions';
import { TaskBriefPanel } from '@/components/tasks/task-brief';
import { TaskFilters } from '@/components/tasks/task-filters';
import { TaskList } from '@/components/tasks/task-list';
import { Badge, EmptyState, Notice, PageHeader, Tabs } from '@/components/ui';

type Search = { tab?: string; mode?: string; task?: string; pod?: string; fo?: string; type?: string; flash?: string };

const TAB_LABELS: Record<TaskTab, string> = { today: 'Today', overdue: 'Overdue', upcoming: 'Upcoming', done: 'Done' };
const CHANNEL_LABELS: Record<TaskChannel, string> = { CALL: 'Calls', EMAIL: 'Emails', LINKEDIN: 'LinkedIn' };

export default async function TasksPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = parseTab(sp.tab);
  const channel = parseChannel(sp.type);
  const mode = sp.mode === 'flow' ? 'flow' : 'list';
  const manager = isAdmin(user) || isSeniorFo(user);
  const podId = manager ? sp.pod || null : null;
  const foUserId = manager ? sp.fo || null : null;

  const [{ rows, counts, channelCounts, today }, options, settings] = await Promise.all([
    listTasks(user, { tab, podId, foUserId, channel }),
    filterOptions(user),
    getSettings(),
  ]);

  const base = new URLSearchParams();
  base.set('tab', tab);
  if (mode === 'flow') base.set('mode', 'flow');
  if (podId) base.set('pod', podId);
  if (foUserId) base.set('fo', foUserId);
  if (channel) base.set('type', channel);
  const withParams = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(base);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    return `/tasks?${p.toString()}`;
  };
  const hrefFor = (taskId: string) => withParams({ task: taskId });

  const selectedId = sp.task && rows.some((r) => r.id === sp.task) ? sp.task : rows[0]?.id ?? null;
  const index = selectedId ? rows.findIndex((r) => r.id === selectedId) : -1;
  const nextRow = index >= 0 ? rows[index + 1] ?? (rows.length > 1 ? rows[0] : null) : null;
  const prevRow = index > 0 ? rows[index - 1] : null;
  const nextUrl = nextRow && nextRow.id !== selectedId ? hrefFor(nextRow.id) : withParams({ task: null });
  const prevUrl = prevRow ? hrefFor(prevRow.id) : null;
  const brief = selectedId ? await getTaskBrief(selectedId, user) : null;
  const nextWorkingDay = nextWorkingDaySnooze(today, settings.rules.workingDays);
  const actor = toActor(user);
  const canPickSnoozeDate = canSnoozeFreely(actor);
  const dispositions = settings.rules.callDispositions.map((d) => ({ key: d.key, label: d.label, answered: d.answered }));
  const skipReasons = settings.rules.skipReasons.map((r) => ({ key: r.key, label: r.label, exit: r.exit }));
  const listRows = rows.map((t) => ({
    id: t.id,
    personName: cachedPersonName(t.enrollment.person),
    companyName: t.enrollment.person.companyName,
    label: t.label,
    action: t.action,
    altAction: t.altAction,
    stepIndex: t.stepIndex,
    stepDay: t.stepDay,
    due: t.snoozedTo ?? t.dueDate,
    snoozed: Boolean(t.snoozedTo),
    state: t.state,
    foName: t.fo.name,
    campaignName: t.enrollment.campaign?.name ?? null,
  }));
  const reassignFos = podId ? options.fos.filter((f) => f.podIds.includes(podId)) : options.fos;

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle={`${formatLocalDate(today, 'long')} · ${counts.today} due today, ${counts.overdue} overdue`}
        actions={<TaskFilters pods={options.pods} fos={options.fos} podId={podId} foUserId={foUserId} mode={mode} />}
      />
      <Tabs
        current={tab}
        tabs={(['today', 'overdue', 'upcoming', 'done'] as TaskTab[]).map((t) => ({ key: t, label: TAB_LABELS[t], href: withParams({ tab: t, task: null }), count: counts[t] }))}
      />
      <div className="flex flex-wrap items-center gap-1.5 px-6 pt-4">
        <Link href={withParams({ type: null, task: null })} className={channel ? 'btn-secondary btn-sm' : 'btn-primary btn-sm'}>
          All types
        </Link>
        {TASK_CHANNELS.map((c) => (
          <Link key={c} href={withParams({ type: c, task: null })} className={channel === c ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}>
            <ActionIcon action={c} size={14} /> {CHANNEL_LABELS[c]}
            <span className={channel === c ? 'rounded-full bg-white/20 px-1.5 text-[11px]' : 'rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-600'}>{channelCounts[c]}</span>
          </Link>
        ))}
        {rows.length > 0 && mode === 'list' ? (
          <Link href={withParams({ mode: 'flow', task: rows[0].id })} className="btn-ghost btn-sm ml-auto">
            Start task flow ({rows.length})
          </Link>
        ) : null}
      </div>
      {sp.flash ? (
        <div className="px-6 pt-4">
          <Notice tone="success">
            <span role="status">{sp.flash.slice(0, 300)}</span>{' '}
            <Link href={withParams({ task: selectedId ?? null })} className="ml-2 text-xs underline">
              dismiss
            </Link>
          </Notice>
        </div>
      ) : null}
      {tab !== 'overdue' && counts.overdue > 0 ? (
        <div className="px-6 pt-4">
          <Notice tone="error">
            <span className="font-medium">{counts.overdue} overdue task{counts.overdue === 1 ? '' : 's'}.</span> Overdue work is never dropped: it stays here until it is done or skipped.{' '}
            <Link href={withParams({ tab: 'overdue', task: null })} className="underline">
              Work the overdue list
            </Link>
            .
          </Notice>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title={tab === 'done' ? 'Nothing completed yet' : `No ${TAB_LABELS[tab].toLowerCase()} ${channel ? CHANNEL_LABELS[channel].toLowerCase() : 'tasks'}`}
          hint={tab === 'today' ? 'Nothing due today for this view. Check Upcoming, or enrol more people from Campaigns.' : undefined}
        />
      ) : (
        <div className="grid gap-4 p-6 2xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className={mode === 'list' ? 'grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]' : ''}>
            {mode === 'list' ? (
              <div className="card max-h-[50vh] overflow-y-auto xl:max-h-[calc(100vh-16rem)]">
                <TaskList
                  rows={listRows}
                  selectedId={selectedId}
                  today={today}
                  showFo={manager}
                  hrefTemplate={withParams({ task: '__ID__' })}
                  dispositions={dispositions}
                  skipReasons={skipReasons}
                  fos={reassignFos.map((f) => ({ id: f.id, name: f.name }))}
                  nextWorkingDay={nextWorkingDay}
                  canPickSnoozeDate={canPickSnoozeDate}
                  bulkEnabled={tab !== 'done'}
                />
              </div>
            ) : null}
            <div>
              {brief ? (
                <div className="card p-5">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                        <ActionIcon action={brief.task.action} size={20} />
                      </span>
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          {ACTION_LABELS[brief.task.action]}
                          {brief.task.altAction ? ` or ${ACTION_LABELS[brief.task.altAction]}` : ''} · Step {brief.stepIndex + 1} of {brief.stepCount} · Day {brief.task.stepDay}
                          {brief.variantLabel ? ` · Variant ${brief.variantLabel}` : ''}
                        </div>
                        <h2 className="text-lg font-semibold text-slate-900">
                          {brief.action.label}:{' '}
                          <Link href={`/people/${brief.person.id}`} className="hover:underline">
                            {brief.personName}
                          </Link>
                        </h2>
                        <div className="text-sm text-slate-600">
                          {brief.person.jobTitle ?? 'Unknown title'}
                          {brief.person.companyName ? ` at ${brief.person.companyName}` : ''}
                          {brief.person.eventSource ? ` · met via ${brief.person.eventSource}` : ''}
                        </div>
                      </div>
                    </div>
                    <div className="text-right text-sm">
                      <div className={brief.task.state === 'PENDING' && (brief.task.snoozedTo ?? brief.task.dueDate) < today ? 'font-medium text-red-600' : 'text-slate-700'}>
                        {describeDue(brief.task)}
                      </div>
                      {mode === 'flow' ? (
                        <div className="text-xs text-slate-500">
                          {index + 1} of {rows.length}
                        </div>
                      ) : null}
                      {brief.task.state !== 'PENDING' ? <Badge tone="gray">{brief.task.state.toLowerCase()}</Badge> : null}
                    </div>
                  </div>

                  {brief.person.badEmail && brief.task.action === 'EMAIL' ? <div className="mb-3"><Notice tone="warn">This email address was flagged as bad data earlier. Check it in Twenty before sending.</Notice></div> : null}
                  {brief.person.badPhone && brief.task.action === 'CALL' ? <div className="mb-3"><Notice tone="warn">This phone number was flagged as a wrong number earlier.</Notice></div> : null}
                  {brief.replyInThread ? <div className="mb-3"><Notice tone="info">Send this as a reply in the existing email thread, not a new email.</Notice></div> : null}

                  {brief.action.body || brief.action.subject ? (
                    <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-4">
                      {brief.action.subject ? <div className="mb-2 text-sm font-medium text-slate-800">Subject: {brief.action.subject}</div> : null}
                      <pre className="whitespace-pre-wrap font-sans text-sm text-slate-800">{brief.action.body}</pre>
                    </div>
                  ) : null}

                  {brief.task.state === 'PENDING' ? (
                    <TaskActions
                      taskId={brief.task.id}
                      action={brief.task.action}
                      altAction={brief.task.altAction}
                      nextUrl={rows.length > 1 || mode === 'flow' ? nextUrl : null}
                      prevUrl={prevUrl}
                      twentyUrl={brief.twentyUrl}
                      copyText={[brief.action.subject ? `Subject: ${brief.action.subject}` : null, brief.action.body].filter(Boolean).join('\n\n')}
                      nextWorkingDay={nextWorkingDay}
                      canPickSnoozeDate={canPickSnoozeDate}
                      dispositions={dispositions}
                      skipReasons={skipReasons}
                      steps={brief.steps.map((s) => ({ index: s.index, label: `Day ${s.day} · ${s.label}` }))}
                      currentStep={brief.currentStep}
                      canManageEnrollment={canManageEnrollment(actor, { foUserId: brief.task.foUserId, podId: brief.task.enrollment.podId }) || brief.task.foUserId === user.id}
                      size={mode === 'flow' ? 'lg' : 'md'}
                    />
                  ) : (
                    <p className="text-sm text-slate-500">
                      {brief.task.state === 'DONE'
                        ? `Completed${brief.task.completionSource ? ` (${brief.task.completionSource.toLowerCase().replace(/_/g, ' ')})` : ''}${brief.task.disposition ? ` · ${dispositions.find((d) => d.key === brief.task.disposition)?.label ?? brief.task.disposition}` : ''}.`
                        : brief.task.state === 'SKIPPED'
                          ? `Skipped: ${brief.task.skipReason ?? ''}`
                          : `Cancelled: ${brief.task.cancelReason ?? ''}`}
                      {brief.task.note ? <span className="block mt-1 text-slate-700">{brief.task.note}</span> : null}
                    </p>
                  )}
                </div>
              ) : (
                <EmptyState title="Select a task" />
              )}
            </div>
          </div>
          <aside className="2xl:sticky 2xl:top-6 2xl:self-start">{brief ? <TaskBriefPanel brief={brief} timezone={user.timezone} /> : null}</aside>
        </div>
      )}
    </>
  );
}
