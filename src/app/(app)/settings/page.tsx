import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { getSettings } from '@/lib/settings';
import { getTwentyClient } from '@/lib/twenty';
import { recentEvents } from '@/lib/engine/ingest';
import { PageHeader, Tabs, Notice, Card, KeyValue } from '@/components/ui';
import { UsersPanel, type MemberOption } from '@/components/settings/users-panel';
import { AdminTools } from '@/components/settings/admin-tools';
import { ReviewButton } from '@/components/settings/review-button';

const TABS = [
  { key: 'twenty', label: 'Twenty' },
  { key: 'rules', label: 'Rules' },
  { key: 'users', label: 'Users and pods' },
];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  if (!isAdmin(user)) redirect('/tasks');
  const { tab = 'twenty' } = await searchParams;
  const settings = await getSettings();
  const e = env();

  return (
    <>
      <PageHeader title="Settings" subtitle="Twenty connection, matching rules, caps and people." />
      <Tabs current={tab} tabs={TABS.map((t) => ({ ...t, href: `/settings?tab=${t.key}` }))} />
      <div className="p-6">
        {tab === 'users' ? <UsersTab /> : null}
        {tab === 'twenty' ? <TwentyTab mode={e.TWENTY_MODE} dryRun={e.CADENCE_DRY_RUN} baseUrl={settings.twenty.baseUrl || e.TWENTY_API_URL || ''} /> : null}
        {tab === 'rules' ? (
          <Card title="Rules">
            <div className="p-4">
              <KeyValue
                items={[
                  { k: 'Daily cap', v: `${settings.rules.dailyCap} actions per FO per day` },
                  { k: 'Working days', v: settings.rules.workingDays.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ') },
                  { k: 'Clock mode', v: settings.rules.clockMode === 'shift' ? 'Shift later steps when a step completes late' : 'Hold to plan' },
                ]}
              />
              <p className="mt-3 text-xs text-slate-500">Editing arrives with the full settings UI in phase 5.</p>
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}

async function UsersTab() {
  const [users, pods] = await Promise.all([
    prisma.user.findMany({ include: { pods: true }, orderBy: [{ role: 'asc' }, { name: 'asc' }] }),
    prisma.pod.findMany({ include: { _count: { select: { users: true } } }, orderBy: { name: 'asc' } }),
  ]);
  let members: MemberOption[] = [];
  try {
    const client = await getTwentyClient();
    members = (await client.listWorkspaceMembers()).map((m) => ({ id: m.id, label: `${m.firstName} ${m.lastName}${m.email ? ` (${m.email})` : ''}` }));
  } catch {
    members = [];
  }
  return (
    <UsersPanel
      users={users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        timezone: u.timezone,
        twentyMemberId: u.twentyMemberId,
        aliases: u.aliases,
        dailyCap: u.dailyCap,
        active: u.active,
        podIds: u.pods.map((p) => p.podId),
      }))}
      pods={pods.map((p) => ({ id: p.id, name: p.name, podOwnerValue: p.podOwnerValue, userCount: p._count.users }))}
      members={members}
    />
  );
}

async function TwentyTab({ mode, dryRun, baseUrl }: { mode: string; dryRun: boolean; baseUrl: string }) {
  let ping: string;
  try {
    const client = await getTwentyClient();
    ping = (await client.ping()).detail;
  } catch (err) {
    ping = `Not connected: ${err instanceof Error ? err.message : String(err)}`;
  }
  const [settings, events, reviewCount, lastReconcile] = await Promise.all([
    getSettings(),
    recentEvents(40),
    prisma.activityEvent.count({ where: { needsReview: true } }),
    prisma.setting.findUnique({ where: { key: 'lastReconcile' } }),
  ]);
  const last = lastReconcile?.value as { at?: string } | null;
  return (
    <div className="space-y-4">
      {mode === 'mock' ? (
        <Notice tone="warn">Running against the built-in mock workspace. Set TWENTY_MODE=graphql and an API key to connect to your Twenty.</Notice>
      ) : null}
      {dryRun ? <Notice tone="info">Dry run is on: Cadence logs what it would write to Twenty and writes nothing.</Notice> : null}
      <Card title="Connection">
        <div className="p-4">
          <KeyValue
            items={[
              { k: 'Mode', v: mode },
              { k: 'Base URL', v: baseUrl || '-' },
              { k: 'Status', v: ping },
              { k: 'Webhook URL', v: `${env().APP_URL.replace(/\/+$/, '')}/api/webhooks/twenty${env().CADENCE_WEBHOOK_TOKEN ? '?token=...' : ''}` },
              { k: 'Last reconcile', v: last?.at ? new Date(last.at).toLocaleString('en-GB') : 'never' },
            ]}
          />
          <p className="mt-3 text-xs text-slate-500">Schema mapping, note title patterns and sync toggles become editable here in phase 5.</p>
        </div>
      </Card>
      <AdminTools defaultDays={settings.rules.reconcileLookbackDays} />
      <Card title={`Recent activity events${reviewCount ? ` · ${reviewCount} need review` : ''}`}>
        {events.length === 0 ? (
          <div className="p-4 text-sm text-slate-500">No events yet. Webhooks and reconcile runs appear here.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Received</th>
                <th>Source</th>
                <th>Event</th>
                <th>Record</th>
                <th>Result</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id} className={ev.needsReview ? 'bg-amber-50/60' : undefined}>
                  <td className="whitespace-nowrap text-xs">{ev.receivedAt.toLocaleString('en-GB')}</td>
                  <td className="text-xs">{ev.source.toLowerCase()}</td>
                  <td className="text-xs">{ev.eventName}</td>
                  <td className="font-mono text-[11px]">{ev.externalId}</td>
                  <td className="text-xs">
                    {ev.result ?? <span className="text-slate-400">pending</span>}
                    {ev.reviewNote ? <div className="text-amber-700">{ev.reviewNote}</div> : null}
                  </td>
                  <td className="text-right">{ev.needsReview ? <ReviewButton eventId={ev.id} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
