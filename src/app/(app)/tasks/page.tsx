import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { canManageEnrollment, canSnoozeFreely, isAdmin, isSeniorFo, toActor } from '@/lib/auth/rbac';
import { getTaskBrief, describeDue } from '@/lib/brief';
import { nextWorkingDaySnooze } from '@/lib/engine/tasks';
import { cachedPersonName } from '@/lib/person-cache';
import { getSettings } from '@/lib/settings';
import { ACTION_LABELS } from '@/lib/sequences/steps';
import { filterOptions, listTasks, parseChannel, parseTab, TASK_CHANNELS, type TaskChannel, type TaskTab } from '@/lib/tasks-query';
import { ActionIcon, IconBolt, IconChevronLeft, IconChevronRight } from '@/components/icons';
import { TaskActions } from '@/components/tasks/task-actions';
import { TaskBriefPanel } from '@/components/tasks/task-brief';
import { TaskComposer } from '@/components/tasks/task-composer';
import { TaskFilters } from '@/components/tasks/task-filters';
import { TaskFlash } from '@/components/tasks/task-flash';
import { TaskList } from '@/components/tasks/task-list';
import { Avatar, Badge, EmptyState, Notice, Surface, Tabs, Toolbar, ViewHeader } from '@/components/ui';

type Search = { tab?: string; mode?: string; task?: string; pod?: string; fo?: string; type?: string; flash?: string };

const TAB_LABELS: Record<TaskTab, string> = { today: 'Today', overdue: 'Overdue', upcoming: 'Upcoming', done: 'Done' };
const CHANNEL_LABELS: Record<TaskChannel, string> = { CALL: 'Calls', EMAIL: 'Emails', LINKEDIN: 'LinkedIn' };
const CHANNEL_OF: Record<string, 'EMAIL' | 'CALL' | 'LINKEDIN'> = { EMAIL: 'EMAIL', CALL: 'CALL' };

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
  const flow = mode === 'flow';

  return (
    <div className="px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader title={`${TAB_LABELS[tab]}${channel ? ` · ${CHANNEL_LABELS[channel]}` : ''}`} />
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

      {sp.flash ? <TaskFlash message={sp.flash.slice(0, 300)} /> : null}

      {rows.length === 0 ? (
        <Surface className="mt-3" flush>
          <EmptyState
            icon={<ActionIcon action={channel ?? 'EMAIL'} size={20} />}
            title={tab === 'done' ? 'Nothing completed yet' : `No ${TAB_LABELS[tab].toLowerCase()} ${channel ? CHANNEL_LABELS[channel].toLowerCase() : 'tasks'}`}
            hint={tab === 'today' ? 'Nothing due today for this view. Check Upcoming, or enrol more people from Campaigns.' : undefined}
          />
        </Surface>
      ) : (
        <div className={flow ? 'mt-3 space-y-3' : 'mt-3 grid gap-3 2xl:grid-cols-[minmax(0,1fr)_390px]'}>
          {/*
            Two genuinely different ways to work, not one layout with a list hidden.
            List: pick from a table, act on the right, scan and jump around.
            Flow: one person at a time, a progress rail across the top, keyboard first.
          */}
          {flow ? <FlowRail index={index} total={rows.length} prevUrl={prevUrl} nextUrl={nextRow ? nextUrl : null} listHref={withParams({ mode: null, task: selectedId })} /> : null}

          <div className={flow ? 'grid gap-3 xl:grid-cols-[minmax(0,1fr)_390px]' : 'grid min-w-0 gap-3 xl:grid-cols-[336px_minmax(0,1fr)]'}>
            {flow ? null : (
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
            )}

            <div className="min-w-0">
              {brief ? (
                <Surface flush>
                  {/* Who and what, once. The panel on the right carries the detail. */}
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line bg-gradient-to-r from-brand-50/70 to-white px-5 py-4">
                    <div className="flex min-w-0 items-start gap-3">
                      <Avatar name={brief.personName} shape="circle" size={flow ? 46 : 40} />
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
                        </div>
                        <h2 className={`mt-1 truncate font-semibold tracking-[-0.015em] text-ink-900 ${flow ? 'text-[23px]' : 'text-[19px]'}`}>
                          <Link href={`/people/${brief.person.id}`} className="hover:text-brand-700">
                            {brief.personName}
                          </Link>
                        </h2>
                        {/* Job title and company only: the panel on the right carries the rest. */}
                        <div className="truncate text-[13px] text-ink-500">
                          {brief.person.jobTitle ?? 'Unknown title'}
                          {brief.person.companyName ? ` at ${brief.person.companyName}` : ''}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={overdueSelected ? 'text-[13px] font-medium text-red-600' : 'text-[13px] text-ink-600'}>{describeDue(brief.task)}</div>
                      {brief.task.state !== 'PENDING' ? <Badge tone="gray">{brief.task.state.toLowerCase()}</Badge> : null}
                    </div>
                  </div>

                  <div className="space-y-3 px-5 py-4">
                    {brief.person.badEmail && brief.task.action === 'EMAIL' ? <Notice tone="warn">This email address was flagged as bad data earlier. Check it in Twenty before sending.</Notice> : null}
                    {brief.person.badPhone && brief.task.action === 'CALL' ? <Notice tone="warn">This phone number was flagged as a wrong number earlier.</Notice> : null}
                    {brief.replyInThread ? <Notice tone="info">Send this as a reply in the existing email thread, not a new email.</Notice> : null}

                    {brief.action.body || brief.action.subject ? (
                      <TaskComposer
                        taskId={brief.task.id}
                        label={brief.action.label}
                        subject={brief.action.subject}
                        body={brief.action.body}
                        variantLabel={brief.variantLabel}
                        channel={CHANNEL_OF[brief.task.action] ?? 'LINKEDIN'}
                      />
                    ) : null}

                    {brief.task.state === 'PENDING' ? (
                      <TaskActions
                        taskId={brief.task.id}
                        action={brief.task.action}
                        altAction={brief.task.altAction}
                        nextUrl={rows.length > 1 || flow ? nextUrl : null}
                        prevUrl={prevUrl}
                        twentyUrl={brief.twentyUrl}
                        nextWorkingDay={nextWorkingDay}
                        canPickSnoozeDate={canPickSnoozeDate}
                        dispositions={dispositions}
                        skipReasons={skipReasons}
                        steps={brief.steps.map((s) => ({ index: s.index, label: `Day ${s.day} · ${s.label}` }))}
                        currentStep={brief.currentStep}
                        canManageEnrollment={canManageEnrollment(actor, { foUserId: brief.task.foUserId, podId: brief.task.enrollment.podId }) || brief.task.foUserId === user.id}
                        size={flow ? 'lg' : 'md'}
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

            {flow ? <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">{brief ? <TaskBriefPanel brief={brief} timezone={user.timezone} /> : null}</aside> : null}
          </div>

          {flow ? null : <aside className="min-w-0 2xl:sticky 2xl:top-4 2xl:self-start">{brief ? <TaskBriefPanel brief={brief} timezone={user.timezone} /> : null}</aside>}
        </div>
      )}
    </div>
  );
}

/** Flow mode's own chrome: where you are in the run, and how to leave it. */
function FlowRail({ index, total, prevUrl, nextUrl, listHref }: { index: number; total: number; prevUrl: string | null; nextUrl: string | null; listHref: string }) {
  const position = index >= 0 ? index + 1 : 1;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-brand-200 bg-brand-50/60 px-4 py-2.5">
      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-brand-700">
        <IconBolt size={14} /> Task flow
      </span>
      <span className="text-[13px] font-medium tabular-nums text-ink-700">
        {position} of {total}
      </span>
      {/* One segment per task, so the run has a visible end. */}
      <span className="flex min-w-[120px] flex-1 gap-[3px]" aria-hidden>
        {Array.from({ length: Math.min(total, 40) }).map((_, i) => (
          <span key={i} className={`h-1.5 flex-1 rounded-full ${i < position - 1 ? 'bg-brand-500' : i === position - 1 ? 'bg-brand-700' : 'bg-brand-200'}`} />
        ))}
      </span>
      <span className="flex items-center gap-1">
        {prevUrl ? (
          <Link href={prevUrl} className="btn-icon-ghost h-8 w-8" title="Previous task (P)" aria-label="Previous task">
            <IconChevronLeft size={15} />
          </Link>
        ) : null}
        {nextUrl ? (
          <Link href={nextUrl} className="btn-ghost btn-sm" title="Next task (N)">
            Next <IconChevronRight size={14} />
          </Link>
        ) : null}
        <Link href={listHref} className="btn-secondary btn-sm">
          Back to the list
        </Link>
      </span>
    </div>
  );
}
