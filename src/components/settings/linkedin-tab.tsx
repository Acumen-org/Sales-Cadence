import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { formatInstant } from '@/lib/dates';
import { getSettings } from '@/lib/settings';
import { feedConfigured, feedStatus } from '@/lib/linkedin/console';
import { slugOf } from '@/lib/linkedin/keys';
import { Badge, Card, Count, Empty, KeyValue, Notice } from '@/components/ui';
import { LinkedInRulesForm } from '@/components/settings/linkedin-settings';

/** The results an admin should look at: Cadence did nothing with these events. */
const NEEDS_A_LOOK = ['ambiguous_crm', 'do_not_contact', 'waiting_profile', 'no_profile'];
const NEEDS_A_LOOK_LIMIT = 50;
const WEEK_MS = 7 * 86_400_000;

const TYPE_WORDS: Record<string, string> = {
  'invitation.sent': 'Connection request sent',
  'invitation.withdrawn': 'Request withdrawn',
  'connection.accepted': 'Request accepted',
  'message.sent': 'Message sent',
  'message.received': 'Message received',
};

/** An event's result in plain words. */
export function linkedInResultWords(result: string): string {
  if (result === 'ambiguous_crm') return 'Two CRM people have this LinkedIn link';
  if (result === 'do_not_contact') return 'This person must not be contacted, so nothing was done';
  if (result === 'waiting_profile') return 'Waiting for the Console to send their profile link';
  if (result === 'no_profile') return 'No profile link came within 30 days, so nothing was done';
  if (result.startsWith('error')) {
    const why = result.replace(/^error:?\s*/, '');
    return why ? `Could not be handled: ${why}` : 'Could not be handled';
  }
  return result;
}

/** Requests in the last 7 days against the limit: "At limit" from 100%, "Near limit" from 90%. */
export function inviteLoad(sent: number, limit: number): 'at' | 'near' | null {
  if (limit <= 0) return null;
  if (sent >= limit) return 'at';
  if (sent >= limit * 0.9) return 'near';
  return null;
}

const setBadge = (set: boolean) => set ? <Badge tone="green">Set</Badge> : <Badge tone="amber">Not set</Badge>;

/**
 * Settings > LinkedIn (admins). What the Console has sent, the rules for the tasks Cadence opens from it,
 * each account's requests this week, and the events Cadence could not act on. Cadence never acts on LinkedIn.
 */
export async function LinkedInTab({ timezone }: { timezone: string }) {
  const e = env();
  const [settings, feed, last, waiting, accounts, needsALook] = await Promise.all([
    getSettings(),
    feedStatus(),
    prisma.linkedInEvent.aggregate({ _max: { receivedAt: true } }),
    prisma.linkedInEvent.count({ where: { processedAt: null } }),
    prisma.linkedInAccount.findMany({ orderBy: { name: 'asc' } }),
    prisma.linkedInEvent.findMany({
      where: { OR: [{ result: { in: NEEDS_A_LOOK } }, { result: { startsWith: 'error' } }] },
      orderBy: { at: 'desc' },
      take: NEEDS_A_LOOK_LIMIT,
      select: { id: true, at: true, type: true, name: true, profileKey: true, result: true },
    }),
  ]);
  const webhookUrl = `${e.APP_URL.replace(/\/+$/, '')}/api/webhooks/linkedin`;
  const lastEventAt = last._max.receivedAt;
  const now = Date.now();

  return (
    <div className="space-y-3">
      <Notice>Cadence never acts on LinkedIn. Teammates work in the LinkedIn Console; Cadence reads what the Console saw and closes and opens tasks from it.</Notice>

      <Card title="Connection">
        <div className="p-4">
          <KeyValue items={[
            { k: 'Console address', v: setBadge(Boolean(e.LINKEDIN_CONSOLE_URL?.trim())) },
            { k: 'Feed key', v: setBadge(Boolean(e.LINKEDIN_CONSOLE_API_KEY)) },
            { k: 'Webhook secret', v: setBadge(Boolean(e.LINKEDIN_CONSOLE_WEBHOOK_SECRET)) },
            { k: 'Webhook URL', v: <span className="flex flex-wrap items-center gap-2"><code className="text-[12px]">{webhookUrl}</code><span className="text-[12px] text-ink-500">Give this to the Console developer.</span></span> },
            {
              k: 'Feed',
              v: !feedConfigured()
                ? <span className="flex flex-wrap items-center gap-2"><Badge>Off</Badge><span className="text-[12.5px] text-ink-600">Needs the Console address and the feed key.</span></span>
                : feed.error
                  ? <span className="flex flex-wrap items-center gap-2"><Badge tone="red">Failing</Badge><span className="text-[12.5px] text-red-700">{feed.error}</span>{feed.at ? <span className="text-[12px] text-ink-500">tried {formatInstant(new Date(feed.at), timezone)}</span> : null}</span>
                  : feed.at
                    ? <span className="flex flex-wrap items-center gap-2"><Badge tone="green">Read</Badge><span className="text-[12px] text-ink-500">last read {formatInstant(new Date(feed.at), timezone)}</span></span>
                    : <Badge>Not read yet</Badge>,
            },
            { k: 'Last event', v: lastEventAt ? formatInstant(lastEventAt, timezone) : <span className="text-ink-500">None received yet</span> },
            { k: 'Waiting', v: waiting ? <span className="flex flex-wrap items-center gap-2"><Badge tone="amber"><Count value={waiting} /></Badge><span className="text-[12px] text-ink-500">{waiting === 1 ? 'event' : 'events'} not handled yet</span></span> : <Badge tone="green">None</Badge> },
          ]} />
        </div>
      </Card>

      <Card title="Rules"><LinkedInRulesForm s={settings.linkedin} /></Card>

      <Card title="Accounts" flush>
        {accounts.length ? (
          <table className="table table-tight">
            <thead>
              <tr>
                <th>Account</th>
                <th className="num">Requests in the last 7 days</th>
                <th></th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const limit = a.inviteWeeklyLimit ?? settings.linkedin.inviteWeeklyLimit;
                const load = inviteLoad(a.invitesLast7Days, limit);
                const stale = now - a.seenAt.getTime() > WEEK_MS;
                return (
                  <tr key={a.id} className={load === 'at' ? 'bg-red-50/50' : load === 'near' ? 'bg-amber-50/50' : undefined}>
                    <td className="text-[13px] text-ink-900">{a.name}</td>
                    <td className="num text-[13px]"><Count value={a.invitesLast7Days} /> of <Count value={limit} />{a.inviteWeeklyLimit ? <span className="ml-1 text-[11.5px] text-ink-500">(its own limit)</span> : null}</td>
                    <td>{load === 'at' ? <Badge tone="red">At limit</Badge> : load === 'near' ? <Badge tone="amber">Near limit</Badge> : null}</td>
                    <td className="whitespace-nowrap text-[12px]">{formatInstant(a.seenAt, timezone)}{stale ? <span className="ml-1 text-ink-500">(over a week ago)</span> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="p-4 text-[13px] text-ink-500">No LinkedIn accounts yet. They appear when the Console reports its first event.</p>}
      </Card>

      <Card title={<span className="flex items-center gap-2">Needs a look <Badge tone={needsALook.length ? 'amber' : 'gray'}>{needsALook.length === NEEDS_A_LOOK_LIMIT ? `${NEEDS_A_LOOK_LIMIT}+` : needsALook.length}</Badge></span>} flush>
        <p className="border-b border-line px-4 py-3 text-[13px] text-ink-600">Events Cadence could not act on. The latest {NEEDS_A_LOOK_LIMIT} are shown.</p>
        {needsALook.length ? (
          <div className="max-h-[26rem] overflow-auto scroll-thin">
            <table className="table table-tight">
              <thead>
                <tr>
                  <th>When</th>
                  <th>What happened</th>
                  <th>Name</th>
                  <th>Profile</th>
                  <th>Why nothing was done</th>
                </tr>
              </thead>
              <tbody>
                {needsALook.map((ev) => (
                  <tr key={ev.id}>
                    <td className="whitespace-nowrap text-[12px]">{formatInstant(ev.at, timezone)}</td>
                    <td className="text-[12px]">{TYPE_WORDS[ev.type] ?? ev.type}</td>
                    <td className="text-[12px]">{ev.name ?? <Empty />}</td>
                    <td className="text-[12px]">{ev.profileKey ? <a href={`https://www.linkedin.com/in/${encodeURIComponent(slugOf(ev.profileKey))}`} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">{slugOf(ev.profileKey)}</a> : <Empty />}</td>
                    <td className="max-w-md text-[12px]">{ev.result ? linkedInResultWords(ev.result) : <Empty />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="px-4 py-3 text-[13px] text-ink-500">Nothing to look at.</p>}
      </Card>
    </div>
  );
}
