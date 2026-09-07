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
import { Avatar, Badge, EmptyState, Notice, Surface, Tabs, Toolbar, ViewHeader } from '@/components/ui';

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
  const overdueSelected = brief?.task.state === 'PENDING' && (brief.task.snoozedTo ?? brief.task.dueDate) < today;

  return (
    <div className="px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader
          title={`${TAB_LABELS[tab]}${channel ? ` · ${CHANNEL_LABELS[channel]}` : ''}`}
          meta={
            <>
              {rows.length} result{rows.length === 1 ? '' : 's'} · {formatLocalDate(today, 'long')}
            </>
          }
        />
        <Tabs
          inset={false}
          current={tab}
          tabs={(['today', 'overdue', 'upcoming', 'done'] as TaskTab[]).map((t) => ({ key: t, label: TAB_LABELS[t], href: withParams({ tab: t, task: null }), count: counts[t] }))}
        />
        <Toolbar className="pt-3">
          <Link href={withParams({ type: null, task: null })} className={channel ? 'chip-muted' : 'chip'}>
            All types
          </Link>
          {TASK_CHANNELS.map((c) => (
            <Link key={c} href={withParams({ type: c, task: null })} className={channel === c ? 'chip' : 'chip-muted'}>
              <ActionIcon action={c} size={13} />
              {CHANNEL_LABELS[c]}
              <span className="ml-0.5 opacity-60">{channelCounts[c]}</span>
            </Link>
          ))}
          <span className="ml-auto">
            <TaskFilters pods={options.pods} fos={options.fos} podId={podId} foUserId={foUserId} mode={mode} />
          </span>
        </Toolbar>
      </Surface>

      {sp.flash ? (
        <div className="pt-3">
          <Notice tone="success">
            <span role="status">{sp.flash.slice(0, 300)}</span>{' '}
            <Link href={withParams({ task: selectedId ?? null })} className="ml-1 underline">
              dismiss
            </Link>
          </Notice>
        </div>
      ) : null}
      {tab !== 'overdue' && counts.overdue > 0 ? (
        <div className="pt-3">
          <Notice tone="error">
            <span className="font-medium">
              {counts.overdue} overdue task{counts.overdue === 1 ? '' : 's'}.
            </span>{' '}
            Overdue work is never dropped: it stays until it is done or skipped.{' '}
            <Link href={withParams({ tab: 'overdue', task: null })} className="underline">
              Work the overdue list
            </Link>
            .
          </Notice>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <Surface className="mt-3" flush>
          <EmptyState
            icon={<ActionIcon action={channel ?? 'EMAIL'} size={20} />}
            title={tab === 'done' ? 'Nothing completed yet' : `No ${TAB_LABELS[tab].toLowerCase()} ${channel ? CHANNEL_LABELS[channel].toLowerCase() : 'tasks'}`}
            hint={tab === 'today' ? 'Nothing due today for this view. Check Upcoming, or enrol more people from Campaigns.' : undefined}
          />
        </Surface>
      ) : (
        <div className="mt-3 grid gap-3 2xl:grid-cols-[minmax(0,1fr)_390px]">
          <div className={mode === 'list' ? 'grid min-w-0 gap-3 xl:grid-cols-[336px_minmax(0,1fr)]' : 'min-w-0'}>
            {mode === 'list' ? (
              <Surface flush className="max-h-[52vh] overflow-y-auto scroll-thin xl:max-h-[calc(100vh-19rem)]">
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
              </Surface>
            ) : null}

            <div className="min-w-0">
              {brief ? (
                <Surface flush>
                  {/* Task header band, the way the task flow presents the current step. */}
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line bg-gradient-to-r from-brand-50/70 to-white px-5 py-4">
                    <div className="flex min-w-0 items-start gap-3">
                      <Avatar name={brief.personName} shape="circle" size={40} />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-400">
                          <span className="inline-flex items-center gap-1.5 text-brand-700">
                            <ActionIcon action={brief.task.action} size={13} />
                            {ACTION_LABELS[brief.task.action]}
                            {brief.task.altAction ? ` or ${ACTION_LABELS[brief.task.altAction]}` : ''}
                          </span>
                          <span className="text-ink-300">·</span>
                          <span>
                            Step {brief.stepIndex + 1} of {brief.stepCount} · Day {brief.task.stepDay}
                          </span>
                          {brief.variantLabel ? (
                            <>
                              <span className="text-ink-300">·</span>
                              <Badge tone="purple">Variant {brief.variantLabel}</Badge>
                            </>
                          ) : null}
                        </div>
                        <h2 className="mt-1 truncate text-[19px] font-semibold tracking-[-0.01em] text-ink-900">
                          {brief.action.label}:{' '}
                          <Link href={`/people/${brief.person.id}`} className="hover:text-brand-700">
                            {brief.personName}
                          </Link>
                        </h2>
                        <div className="truncate text-[13px] text-ink-500">
                          {brief.person.jobTitle ?? 'Unknown title'}
                          {brief.person.companyName ? ` at ${brief.person.companyName}` : ''}
                          {brief.person.eventSource ? ` · met via ${brief.person.eventSource}` : ''}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={overdueSelected ? 'text-[13px] font-medium text-red-600' : 'text-[13px] text-ink-600'}>{describeDue(brief.task)}</div>
                      {mode === 'flow' ? (
                        <div className="text-[12px] text-ink-400">
                          {index + 1} of {rows.length}
                        </div>
                      ) : null}
                      {brief.task.state !== 'PENDING' ? <Badge tone="gray">{brief.task.state.toLowerCase()}</Badge> : null}
                    </div>
                  </div>

                  <div className="space-y-3 px-5 py-4">
                    {brief.person.badEmail && brief.task.action === 'EMAIL' ? <Notice tone="warn">This email address was flagged as bad data earlier. Check it in Twenty before sending.</Notice> : null}
                    {brief.person.badPhone && brief.task.action === 'CALL' ? <Notice tone="warn">This phone number was flagged as a wrong number earlier.</Notice> : null}
                    {brief.replyInThread ? <Notice tone="info">Send this as a reply in the existing email thread, not a new email.</Notice> : null}

                    {brief.action.body || brief.action.subject ? (
                      <div className="rounded-xl border border-line bg-canvas/60 p-4">
                        {brief.action.subject ? <div className="mb-2 text-[13.5px] font-semibold text-ink-900">Subject: {brief.action.subject}</div> : null}
                        <pre className="whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed text-ink-700">{brief.action.body}</pre>
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
                      <p className="text-[13px] text-ink-500">
                        {brief.task.state === 'DONE'
                          ? `Completed${brief.task.completionSource ? ` (${brief.task.completionSource.toLowerCase().replace(/_/g, ' ')})` : ''}${brief.task.disposition ? ` · ${dispositions.find((d) => d.key === brief.task.disposition)?.label ?? brief.task.disposition}` : ''}.`
                          : brief.task.state === 'SKIPPED'
                            ? `Skipped: ${brief.task.skipReason ?? ''}`
                            : `Cancelled: ${brief.task.cancelReason ?? ''}`}
                        {brief.task.note ? <span className="mt-1 block text-ink-700">{brief.task.note}</span> : null}
                      </p>
                    )}
                  </div>
                </Surface>
              ) : (
                <Surface flush>
                  <EmptyState title="Select a task" />
                </Surface>
              )}
            </div>
          </div>
          <aside className="min-w-0 2xl:sticky 2xl:top-4 2xl:self-start">{brief ? <TaskBriefPanel brief={brief} timezone={user.timezone} /> : null}</aside>
        </div>
      )}
    </div>
  );
}
