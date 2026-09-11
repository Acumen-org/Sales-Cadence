import { redirect } from 'next/navigation';
import { formatInstant } from '@/lib/dates';
import { WORKSPACE_TIMEZONE } from '@/lib/workspace';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { getSettings, getTwentySchema } from '@/lib/settings';
import { getTwentyClient } from '@/lib/twenty';
import { recentEvents } from '@/lib/engine/ingest';
import { Badge, Card, KeyValue, Notice, Surface, Tabs, ViewHeader, Empty } from '@/components/ui';
import { UsersPanel } from '@/components/settings/users-panel';
import { AdminTools } from '@/components/settings/admin-tools';
import { ReviewButton } from '@/components/settings/review-button';
import { DiscardWriteButton, RetryWriteButton } from '@/components/settings/retry-write-button';
import { MatchingForm, RulesForm, SyncForm, TwentyConnectionForm } from '@/components/settings/settings-forms';
import { getMeetingAnalyzer } from '@/lib/meetings/analysis';
import { ASSISTANT_NAME, ASSISTANT_SETTINGS_TAB } from '@/lib/workspace';
import { IconAssistant } from '@/components/icons';

const TABS = [
  { key: 'twenty', label: 'Twenty' },
  { key: 'rules', label: 'Rules and matching' },
  { key: 'sync', label: 'Sync out' },
  { key: 'users', label: 'Team & pods' },
  { key: ASSISTANT_SETTINGS_TAB, label: ASSISTANT_NAME },
  { key: 'activity', label: 'Activity log' },
];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  if (!isAdmin(user)) redirect('/tasks');
  const { tab = 'twenty' } = await searchParams;
  const settings = await getSettings();
  const e = env();
  const reviewCount = await prisma.activityEvent.count({ where: { needsReview: true } });

  return (
    <div className="space-y-3 px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader title="Workspace settings" />
        <Tabs inset={false} current={tab} tabs={TABS.map((t) => ({ ...t, href: `/settings?tab=${t.key}`, count: t.key === 'activity' && reviewCount ? reviewCount : undefined }))} />
      </Surface>

      {tab === 'twenty' ? <TwentyTab mode={e.TWENTY_MODE} dryRun={e.CADENCE_DRY_RUN} hasEnvKey={Boolean(e.TWENTY_API_KEY)} /> : null}
      {tab === 'rules' ? (
        <div className="space-y-3">
          <RulesForm rules={settings.rules} />
          <MatchingForm matching={settings.matching} />
        </div>
      ) : null}
      {tab === 'sync' ? <SyncForm sync={settings.sync} /> : null}
      {tab === 'users' ? <UsersTab /> : null}
      {tab === ASSISTANT_SETTINGS_TAB ? <AssistantTab /> : null}
      {tab === 'activity' ? <ActivityTab /> : null}
    </div>
  );
}

function AssistantTab() {
  const analyzer = getMeetingAnalyzer();
  const connected = analyzer.name !== 'local-stats';
  return <Card title={<span className="flex items-center gap-2"><IconAssistant size={18} />{ASSISTANT_NAME}</span>}>
    <div className="space-y-4 p-5"><KeyValue items={[
      { k: 'Model provider', v: <Badge tone={connected ? 'green' : 'gray'}>{connected ? analyzer.name : 'Not connected'}</Badge> },
      { k: 'Meeting analysis', v: <Badge tone={connected ? 'green' : 'gray'}>{connected ? 'Available' : 'Needs a provider'}</Badge> },
      { k: 'Suggested approach', v: <Badge tone={connected ? 'green' : 'gray'}>{connected ? 'Available' : 'Needs a provider'}</Badge> },
      { k: 'Talk time', v: <Badge tone="green">Local</Badge> },
    ]} /></div>
  </Card>;
}

async function UsersTab() {
  const [users, pods, peopleByPod] = await Promise.all([
    prisma.user.findMany({ include: { pods: true, enrollments: { where: { status: { in: ['ACTIVE', 'PAUSED'] } }, select: { podId: true } }, _count: { select: { enrollments: { where: { status: { in: ['ACTIVE', 'PAUSED'] } } } } } }, orderBy: [{ role: 'asc' }, { name: 'asc' }] }),
    prisma.pod.findMany({ include: { _count: { select: { users: { where: { user: { active: true } } } } } }, orderBy: { name: 'asc' } }),
    prisma.personCache.groupBy({ by: ['podOwner'], where: { deletedAt: null }, _count: { _all: true } }),
  ]);
  const peopleCount = new Map(peopleByPod.map((r) => [r.podOwner, r._count._all]));
  return (
    <UsersPanel
      users={users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        active: u.active,
        openWork: u._count.enrollments,
        openPodIds: [...new Set(u.enrollments.flatMap((e) => e.podId ? [e.podId] : []))],
        podIds: u.pods.map((p) => p.podId),
      }))}
      pods={pods.map((p) => ({
        id: p.id,
        name: p.name,
        podOwnerValue: p.podOwnerValue,
        userCount: p._count.users,
        peopleCount: peopleCount.get(p.podOwnerValue) ?? 0,
        archived: p.archived,
      }))}
    />
  );
}

async function TwentyTab({ mode, dryRun, hasEnvKey }: { mode: string; dryRun: boolean; hasEnvKey: boolean }) {
  let ping: string;
  let ok = true;
  let counts: { people?: number; members?: number } = {};
  try {
    const client = await getTwentyClient();
    const result = await client.ping();
    ping = result.detail;
    counts = { people: result.people, members: result.members };
  } catch (err) {
    ok = false;
    ping = err instanceof Error ? err.message : String(err);
  }
  const [settings, schema, lastReconcile] = await Promise.all([getSettings(), getTwentySchema(), prisma.setting.findUnique({ where: { key: 'lastReconcile' } })]);
  const last = lastReconcile?.value as { at?: string } | null;
  const baseUrl = settings.twenty.baseUrl || env().TWENTY_API_URL || '';
  return (
    <div className="space-y-3">
      {dryRun ? <Notice tone="info">Dry run is on: Cadence logs what it would write to Twenty and writes nothing.</Notice> : null}
      <Card title="Status">
        <div className="p-4">
          <KeyValue
            items={[
              { k: 'Mode', v: mode === 'mock' ? 'Demo workspace' : 'Twenty (GraphQL)' },
              { k: 'Connection', v: <Badge tone={ok ? 'green' : 'red'}>{ok ? 'Reachable' : 'Not connected'}</Badge> },
              { k: 'API key', v: settings.twenty.apiKey ? <Badge tone="green">Stored in settings</Badge> : hasEnvKey ? <Badge tone="green">From environment</Badge> : <Badge tone="amber">Not configured</Badge> },
              { k: 'Base URL', v: baseUrl || null },
              ...(counts.people === undefined ? [] : [{ k: 'People', v: counts.people }]),
              { k: 'Workspace members', v: counts.members ?? null },
              ...(ok ? [] : [{ k: 'Last error', v: <span className="text-red-700">{ping}</span> }]),
              { k: 'Webhook URL', v: <code className="text-[12px]">{`${env().APP_URL.replace(/\/+$/, '')}/api/webhooks/twenty${env().CADENCE_WEBHOOK_TOKEN ? '?token=...' : ''}`}</code> },
              {
                k: 'Webhook auth',
                v: env().TWENTY_WEBHOOK_SECRET
                  ? <Badge tone="green">HMAC signature</Badge>
                  : env().CADENCE_WEBHOOK_TOKEN
                    ? <Badge tone="green">Shared token</Badge>
                    : <Badge tone="amber">Not configured</Badge>,
              },
              { k: 'Last reconcile', v: last?.at ? formatInstant(new Date(last.at), WORKSPACE_TIMEZONE) : null },
            ]}
          />
        </div>
      </Card>
      <TwentyConnectionForm twenty={settings.twenty} envBaseUrl={env().TWENTY_API_URL} defaultSchemaJson={JSON.stringify(schema, null, 2)} />
      <AdminTools defaultDays={settings.rules.reconcileLookbackDays} />
    </div>
  );
}

async function ActivityTab() {
  const [events, writes, failed] = await Promise.all([
    recentEvents(100),
    prisma.twentyWrite.findMany({ where: { status: 'OK' }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.twentyWrite.findMany({ where: { status: { in: ['FAILED', 'RETRYING'] } }, orderBy: { createdAt: 'asc' }, take: 100 }),
  ]);
  return (
    <div className="space-y-3">
      <Card title={<span className="flex items-center gap-2">Waiting to reach Twenty {failed.length ? <Badge tone="red">{failed.length}</Badge> : <Badge tone="gray">0</Badge>}</span>} actions={failed.length ? <RetryWriteButton>Retry all now</RetryWriteButton> : undefined}>
        {failed.length === 0 ? (
          <div className="p-4 text-[13px] text-ink-500">Every note and mirrored task has reached Twenty.</div>
        ) : (
          <div className="max-h-[26rem] overflow-auto scroll-thin">
            <table className="table table-tight">
              <thead>
                <tr>
                  <th>Since</th>
                  <th>Operation</th>
                  <th>Object</th>
                  <th>Error</th>
                  <th className="num">Attempts</th>
                  <th>Next attempt</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {failed.map((w) => (
                  <tr key={w.id}>
                    <td className="whitespace-nowrap text-[12px]">{formatInstant(w.createdAt, WORKSPACE_TIMEZONE)}</td>
                    <td className="text-[12px]">{w.operation}{w.status === 'RETRYING' ? <Badge tone="amber" className="ml-1.5">Retrying</Badge> : null}</td>
                    <td className="text-[12px]">{w.objectType}</td>
                    <td className="max-w-md text-[12px] text-red-700">{w.error}</td>
                    <td className="num text-[12px]">{w.attempts}</td>
                    <td className="whitespace-nowrap text-[12px]">{w.nextAttemptAt ? formatInstant(w.nextAttemptAt, WORKSPACE_TIMEZONE) : <Empty />}</td>
                    <td className="whitespace-nowrap text-right"><RetryWriteButton writeId={w.id} /> <DiscardWriteButton writeId={w.id} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Inbound events (webhooks and reconcile)">
        {events.length === 0 ? (
          <div className="p-4 text-[13px] text-ink-500">No events yet. Webhooks and reconcile runs appear here.</div>
        ) : (
          <div className="max-h-[26rem] overflow-auto scroll-thin">
            <table className="table table-tight">
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
                    <td className="whitespace-nowrap text-[12px]">{formatInstant(ev.receivedAt, WORKSPACE_TIMEZONE)}</td>
                    <td className="text-[12px]">{ev.source.toLowerCase()}</td>
                    <td className="text-[12px]">{ev.eventName}</td>
                    <td className="font-mono text-[11px]">{ev.externalId}</td>
                    <td className="text-[12px]">
                      {ev.result ?? <span className="text-ink-300">pending</span>}
                      {ev.reviewNote ? <div className="text-amber-700">{ev.reviewNote}</div> : null}
                    </td>
                    <td className="text-right">{ev.needsReview ? <ReviewButton eventId={ev.id} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Writes to Twenty (notes, mirrored tasks)">
        {writes.length === 0 ? (
          <div className="p-4 text-[13px] text-ink-500">Nothing written yet.</div>
        ) : (
          <div className="max-h-[26rem] overflow-auto scroll-thin">
            <table className="table table-tight">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Operation</th>
                  <th>Object</th>
                  <th>Twenty id</th>
                  <th>Payload</th>
                </tr>
              </thead>
              <tbody>
                {writes.map((w) => (
                  <tr key={w.id}>
                    <td className="whitespace-nowrap text-[12px]">{formatInstant(w.createdAt, WORKSPACE_TIMEZONE)}</td>
                    <td className="text-[12px]">
                      {w.operation}
                      {w.dryRun ? <span className="ml-1 rounded bg-sky-50 px-1 text-[10px] text-sky-700">dry run</span> : null}
                    </td>
                    <td className="text-[12px]">{w.objectType}</td>
                    <td className="font-mono text-[11px]">{w.twentyId}</td>
                    <td className="max-w-md truncate font-mono text-[11px] text-ink-700" title={JSON.stringify(w.payload)}>{JSON.stringify(w.payload)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
