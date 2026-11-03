import { FilterNavigationProvider } from '@/components/filter-navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canCheckMeetingNumbers, isAdmin } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { todayIn } from '@/lib/dates';
import { taskScopeWhere, WORKABLE } from '@/lib/tasks-query';
import { Sidebar } from '@/components/sidebar';
import { TopBar } from '@/components/topbar';
import { unreadNotifications } from '@/lib/notifications';
import { LiveRefresh } from '@/components/live-refresh';
import { workspaceTimezone } from '@/lib/workspace';
import { CRM_SUBJECT } from '@/lib/subject';
import { formatInstant } from '@/lib/dates';
import { getSettings } from '@/lib/settings';
import { callOutcomes } from '@/lib/engine/outcomes';
import { defaultNextStepDate, pendingForms } from '@/lib/calls/form';
import { sandboxDueCount } from '@/lib/sandbox/work';
import { PRODUCT_VALUES } from '@/lib/sandbox/bellwether-api';
import { PendingCalls } from '@/components/calls/post-call-form';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const e = env();
  const today = todayIn(user.timezone);
  const mine = { AND: [taskScopeWhere(user), WORKABLE, { foUserId: user.id }] };
  // One read for the badge counts: every open touchpoint of mine up to today, bucketed here. The
  // layout runs on every navigation, so each query it saves is felt on every click.
  const [unread, openGroups, needsReview, myNext, checksCount, pending, sandboxDue, settings] = await Promise.all([
    unreadNotifications(user),
    prisma.task.findMany({ where: { AND: [mine, { state: 'PENDING' }, { OR: [{ snoozedTo: null, dueDate: { lte: today } }, { snoozedTo: { not: null, lte: today } }] }] }, select: { enrollmentId: true, stepId: true, dueDate: true, snoozedTo: true } }),
    isAdmin(user) ? prisma.activityEvent.count({ where: { needsReview: true } }) : Promise.resolve(0),
    // Next actions of mine due by today count like any step.
    prisma.nextAction.findMany({ where: { foUserId: user.id, state: 'OPEN', dueDate: { lte: today }, ...CRM_SUBJECT }, select: { dueDate: true } }),
    // Meeting numbers someone doubted, waiting for Biz Ops.
    canCheckMeetingNumbers(user) ? prisma.meetingNumberTicket.count({ where: { open: true } }) : Promise.resolve(0),
    // Calls of mine waiting for their form: the bar above every page, and Call buttons wait for it.
    pendingForms(user.id),
    sandboxDueCount(user.id, today),
    getSettings(),
  ]);
  const pendingCalls = pending.map((c) => {
    const who = c.person ?? c.sandboxContact;
    return { id: c.id, name: who ? `${who.firstName} ${who.lastName}`.trim() : (c.direction === 'OUTBOUND' ? c.toNumber : c.fromNumber) ?? 'Unknown number', at: formatInstant(c.startedAt ?? c.createdAt, user.timezone).split(', ').pop() ?? '', number: c.direction === 'OUTBOUND' ? c.toNumber : c.fromNumber, twilioStatus: c.twilioStatus, talk: c.talkSec ? `${Math.floor(c.talkSec / 60)}m ${c.talkSec % 60}s` : null };
  });
  const todayGroups = new Set<string>();
  const overdueGroups = new Set<string>();
  for (const t of openGroups) ((t.snoozedTo ?? t.dueDate) === today ? todayGroups : overdueGroups).add(`${t.enrollmentId}:${t.stepId}`);
  const todayCount = todayGroups.size + myNext.filter((n) => n.dueDate === today).length;
  const overdueCount = overdueGroups.size + myNext.filter((n) => n.dueDate < today).length;

  return (
    <FilterNavigationProvider><div className="flex min-h-screen bg-canvas">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Sidebar user={user} mode={e.TWENTY_MODE} dryRun={e.CADENCE_DRY_RUN} todayCount={todayCount} overdueCount={overdueCount} checksCount={checksCount} sandboxCount={sandboxDue} />
      <main id="main-content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
        <LiveRefresh />
        <TopBar role={user.role} unread={unread} needsReview={needsReview} timezone={workspaceTimezone()} />
        <PendingCalls calls={pendingCalls} outcomes={callOutcomes(settings.rules).map((o) => ({ key: o.key, label: o.label, answered: o.answered }))} products={[...PRODUCT_VALUES]} defaultDate={defaultNextStepDate(today, settings.rules.workingDays)} today={today} />
        <div className="page-content min-w-0 flex-1">{children}</div>
      </main>
    </div></FilterNavigationProvider>
  );
}
