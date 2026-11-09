import { FilterNavigationProvider } from '@/components/filter-navigation';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { canWorkTickets, openTicketCount } from '@/lib/tickets';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { todayIn } from '@/lib/dates';
import { dueCounts } from '@/lib/tasks-query';
import { Sidebar } from '@/components/sidebar';
import { TopBar } from '@/components/topbar';
import { unreadNotifications } from '@/lib/notifications';
import { LiveRefresh } from '@/components/live-refresh';
import { workspaceTimezone } from '@/lib/workspace';
import { pendingFormCount, pendingForms } from '@/lib/calls/form';
import { callTimeWords } from '@/lib/calls/words';
import { PendingCalls } from '@/components/calls/post-call-form';

/** Who a pressed Call is ringing, for the notice that says the form will open here. */
async function callingNameOf(intent: { toNumber: string; personId: string | null; sandboxContactId: string | null }): Promise<string> {
  const who = intent.personId ? await prisma.personCache.findUnique({ where: { id: intent.personId }, select: { firstName: true, lastName: true } }) : intent.sandboxContactId ? await prisma.sandboxContact.findUnique({ where: { id: intent.sandboxContactId }, select: { firstName: true, lastName: true } }) : null;
  return (who ? `${who.firstName} ${who.lastName}`.trim() : '') || intent.toNumber;
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const e = env();
  const today = todayIn(user.timezone);
  // The badges count exactly what the lists they open hold (B117): Tasks holds CRM and cold work
  // together (D2), so Cold outreach carries no count of its own (owner, 9 Nov 2026: no Tasks tab there).
  const [unread, due, needsReview, ticketsCount, pending, pendingTotal, calling] = await Promise.all([
    unreadNotifications(user),
    dueCounts(user.id, 'all', today),
    isAdmin(user) ? prisma.activityEvent.count({ where: { needsReview: true } }) : Promise.resolve(0),
    // Tickets waiting for Biz Ops: opt-outs someone doubted and meeting-number checks (D4).
    canWorkTickets(user) ? openTicketCount() : Promise.resolve(0),
    // Calls of mine waiting for their form: the notice above every page, and Call buttons wait for it (B088).
    pendingForms(user.id),
    pendingFormCount(user.id),
    // A press of Call the import has not read back yet: "Calling Jane Doe… the form opens here" (PLAN 4.6).
    prisma.callIntent.findFirst({ where: { userId: user.id, callId: null, createdAt: { gte: new Date(Date.now() - 15 * 60_000) } }, orderBy: { createdAt: 'desc' }, select: { toNumber: true, personId: true, sandboxContactId: true } }),
  ]);
  const pendingCalls = pending.map((c) => {
    const who = c.person ?? c.sandboxContact;
    return { id: c.id, name: who ? `${who.firstName} ${who.lastName}`.trim() || 'Removed contact' : (c.direction === 'OUTBOUND' ? c.toNumber : c.fromNumber) ?? 'Unknown number', at: callTimeWords(c.startedAt ?? c.createdAt, user.timezone), incoming: c.direction === 'INBOUND' };
  });
  const callingName = calling ? await callingNameOf(calling) : null;

  return (
    <FilterNavigationProvider><div className="flex min-h-screen bg-canvas">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Sidebar user={user} mode={e.TWENTY_MODE} dryRun={e.CADENCE_DRY_RUN} todayCount={due.today} overdueCount={due.overdue} ticketsCount={ticketsCount} />
      <main id="main-content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
        <LiveRefresh />
        <TopBar role={user.role} unread={unread} needsReview={needsReview} timezone={workspaceTimezone()} />
        <PendingCalls calls={pendingCalls} total={pendingTotal} calling={callingName} />
        <div className="page-content min-w-0 flex-1">{children}</div>
      </main>
    </div></FilterNavigationProvider>
  );
}
