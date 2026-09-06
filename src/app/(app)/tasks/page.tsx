import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { canSnoozeFreely, isAdmin, isSeniorFo, toActor } from '@/lib/auth/rbac';
import { getTaskBrief, describeDue } from '@/lib/brief';
import { formatLocalDate } from '@/lib/dates';
import { nextWorkingDaySnooze } from '@/lib/engine/tasks';
import { getSettings } from '@/lib/settings';
import { ACTION_LABELS } from '@/lib/sequences/steps';
import { filterOptions, listTasks, parseTab, type TaskTab } from '@/lib/tasks-query';
import { ActionIcon } from '@/components/icons';
import { TaskActions } from '@/components/tasks/task-actions';
import { TaskBriefPanel } from '@/components/tasks/task-brief';
import { TaskFilters } from '@/components/tasks/task-filters';
import { TaskList } from '@/components/tasks/task-list';
import { Badge, EmptyState, Notice, PageHeader, Tabs } from '@/components/ui';

type Search = { tab?: string; mode?: string; task?: string; pod?: string; fo?: string };

const TAB_LABELS: Record<TaskTab, string> = { today: 'Today', overdue: 'Overdue', upcoming: 'Upcoming', done: 'Done' };

export default async function TasksPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = parseTab(sp.tab);
  const mode = sp.mode === 'flow' ? 'flow' : 'list';
  const manager = isAdmin(user) || isSeniorFo(user);
  const podId = manager ? sp.pod || null : null;
  const foUserId = manager ? sp.fo || null : null;

  const [{ rows, counts, today }, options, settings] = await Promise.all([
    listTasks(user, { tab, podId, foUserId }),
    filterOptions(user),
    getSettings(),
  ]);

  const base = new URLSearchParams();
  base.set('tab', tab);
  if (mode === 'flow') base.set('mode', 'flow');
  if (podId) base.set('pod', podId);
  if (foUserId) base.set('fo', foUserId);
  const hrefFor = (taskId: string, overrides?: Record<string, string>) => {
    const p = new URLSearchParams(base);
    p.set('task', taskId);
    for (const [k, v] of Object.entries(overrides ?? {})) p.set(k, v);
    return `/tasks?${p.toString()}`;
  };
  const tabHref = (t: TaskTab) => {
    const p = new URLSearchParams(base);
    p.set('tab', t);
    return `/tasks?${p.toString()}`;
  };

  const selectedId = sp.task && rows.some((r) => r.id === sp.task) ? sp.task : rows[0]?.id ?? null;
  const index = selectedId ? rows.findIndex((r) => r.id === selectedId) : -1;
  const nextRow = index >= 0 ? rows[index + 1] ?? (rows.length > 1 ? rows[0] : null) : null;
  const nextUrl = nextRow && nextRow.id !== selectedId ? hrefFor(nextRow.id) : `/tasks?${base.toString()}`;
  const brief = selectedId ? await getTaskBrief(selectedId, user) : null;
  const nextWorkingDay = nextWorkingDaySnooze(today, settings.rules.workingDays);

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle={`${formatLocalDate(today, 'long')} · ${counts.today} due today, ${counts.overdue} overdue`}
        actions={<TaskFilters pods={options.pods} fos={options.fos} podId={podId} foUserId={foUserId} mode={mode} />}
      />
      <Tabs
        current={tab}
        tabs={(['today', 'overdue', 'upcoming', 'done'] as TaskTab[]).map((t) => ({ key: t, label: TAB_LABELS[t], href: tabHref(t), count: counts[t] }))}
      />
      {tab !== 'overdue' && counts.overdue > 0 ? (
        <div className="px-6 pt-4">
          <Notice tone="error">
            <span className="font-medium">{counts.overdue} overdue task{counts.overdue === 1 ? '' : 's'}.</span> Overdue work is never dropped: it stays here until it is done or skipped.{' '}
            <Link href={tabHref('overdue')} className="underline">
              Work the overdue list
            </Link>
            .
          </Notice>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title={tab === 'done' ? 'Nothing completed yet' : `No ${TAB_LABELS[tab].toLowerCase()} tasks`}
          hint={tab === 'today' ? 'Nothing due today for this view. Check Upcoming, or enrol more people from Campaigns.' : undefined}
        />
      ) : (
        <div className="grid gap-4 p-6 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className={mode === 'list' ? 'grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]' : ''}>
            {mode === 'list' ? (
              <div className="card max-h-[calc(100vh-14rem)] overflow-y-auto">
                <TaskList rows={rows} selectedId={selectedId} today={today} showFo={manager} hrefFor={(id) => hrefFor(id)} />
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
                        </div>
                        <h2 className="text-lg font-semibold text-slate-900">
                          {brief.action.label}: {brief.personName}
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
                      twentyUrl={brief.twentyUrl}
                      copyText={[brief.action.subject ? `Subject: ${brief.action.subject}` : null, brief.action.body].filter(Boolean).join('\n\n')}
                      nextWorkingDay={nextWorkingDay}
                      canPickSnoozeDate={canSnoozeFreely(toActor(user))}
                      size={mode === 'flow' ? 'lg' : 'md'}
                    />
                  ) : (
                    <p className="text-sm text-slate-500">
                      {brief.task.state === 'DONE'
                        ? `Completed${brief.task.completionSource ? ` (${brief.task.completionSource.toLowerCase().replace(/_/g, ' ')})` : ''}.`
                        : brief.task.state === 'SKIPPED'
                          ? `Skipped: ${brief.task.skipReason ?? ''}`
                          : `Cancelled: ${brief.task.cancelReason ?? ''}`}
                    </p>
                  )}
                </div>
              ) : (
                <EmptyState title="Select a task" />
              )}
            </div>
          </div>
          <aside className="xl:sticky xl:top-6 xl:self-start">{brief ? <TaskBriefPanel brief={brief} timezone={user.timezone} /> : null}</aside>
        </div>
      )}
    </>
  );
}
