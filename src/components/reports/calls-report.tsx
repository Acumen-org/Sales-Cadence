import Link from 'next/link';
import type { callReport, sandboxReport, CallTotals } from '@/lib/calls/analytics';
import { formatInstant } from '@/lib/dates';
import { Stat, Surface, ViewHeader, EmptyState } from '@/components/ui';
import { AssignCallRep, AttachCallContact } from '@/components/calls/unmatched-controls';

type CallData = Awaited<ReturnType<typeof callReport>>;
type SandboxData = Awaited<ReturnType<typeof sandboxReport>>;

const pct = (n: number) => `${Math.round(n * 100)}%`;
const mins = (sec: number) => (sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`);
const delta = (now: number, before: number) => (before === now ? 'same as before' : `${now > before ? '+' : ''}${now - before} on the period before`);

const METRICS: { key: keyof CallTotals; label: string; show: (v: number | null) => string }[] = [
  { key: 'dials', label: 'Dials', show: (v) => String(v ?? 0) },
  { key: 'connects', label: 'Connects', show: (v) => String(v ?? 0) },
  { key: 'connectRate', label: 'Connect rate', show: (v) => pct(v ?? 0) },
  { key: 'conversations', label: 'Conversations', show: (v) => String(v ?? 0) },
  { key: 'talkSec', label: 'Talk time', show: (v) => mins(v ?? 0) },
  { key: 'meetings', label: 'Meetings booked', show: (v) => String(v ?? 0) },
  { key: 'avgRating', label: 'Average rating', show: (v) => (v == null ? '-' : String(v)) },
  { key: 'formsOutstanding', label: 'Forms outstanding', show: (v) => String(v ?? 0) },
  { key: 'costUsd', label: 'Cost', show: (v) => `$${(v ?? 0).toFixed(2)}` },
];

/** Reports > Calls (plan section 11): every tile is the platform total; the table splits CRM and sandbox. */
export function CallsReport({ data, timezone, reps, mayAttach }: { data: CallData; timezone: string; /** Everyone, to name a call's rep; only sales reps can be given one (B127). */ reps: { id: string; name: string; sales?: boolean }[]; mayAttach: boolean }) {
  const t = data.totals;
  return <div className="space-y-5">
    <div className="grid grid-cols-5 gap-3">
      <Stat label="Dials" value={t.dials} hint={delta(t.dials, data.previous.dials)} />
      <Stat label="Connects" value={t.connects} hint={delta(t.connects, data.previous.connects)} />
      <Stat label="Connect rate" value={pct(t.connectRate)} hint={`${pct(data.previous.connectRate)} before`} />
      <Stat label="Talk time" value={mins(t.talkSec)} hint={t.connects ? `${mins(t.avgTalkPerConnect)} a connect` : undefined} />
      <Stat label="Forms outstanding" value={t.formsOutstanding} tone={t.formsOutstanding ? 'warn' : 'default'} hint={t.medianMinutesToForm == null ? undefined : `median ${t.medianMinutesToForm} min to a form`} />
    </div>
    <Surface flush>
      <ViewHeader title="CRM, sandbox and platform" />
      <table className="w-full text-[13px]"><thead><tr className="text-left text-ink-500"><th className="px-4 py-2 font-normal">Measure</th><th className="px-4 py-2 font-normal">CRM</th><th className="px-4 py-2 font-normal">Sandbox</th><th className="px-4 py-2 font-normal">Platform</th></tr></thead>
        <tbody className="divide-y divide-line">{METRICS.map((m) => <tr key={m.key}><td className="px-4 py-2 text-ink-700">{m.label}</td>{(['crm', 'sandbox', 'platform'] as const).map((a) => <td key={a} className="px-4 py-2 tabular-nums text-ink-900">{m.show(data.split[a][m.key] as number | null)}</td>)}</tr>)}</tbody></table>
    </Surface>
    {/* B185: By rep takes the full width below 1536px, so a rep's name never wraps at 1280. */}
    <div className="grid gap-5 2xl:grid-cols-2">
      <Surface flush><ViewHeader title="By rep" />{data.byRep.length ? <table className="w-full text-[13px]"><thead><tr className="text-left text-ink-500"><th className="px-4 py-2 font-normal">Rep</th><th className="px-4 py-2 font-normal">Dials</th><th className="px-4 py-2 font-normal">Connects</th><th className="px-4 py-2 font-normal">Rate</th><th className="px-4 py-2 font-normal">Meetings</th><th className="px-4 py-2 font-normal">Forms waiting now</th></tr></thead><tbody className="divide-y divide-line">{data.byRep.map((r) => <tr key={r.userId}><td className="whitespace-nowrap px-4 py-2">{r.name}</td><td className="px-4 py-2 tabular-nums">{r.dials}</td><td className="px-4 py-2 tabular-nums">{r.connects}</td><td className="px-4 py-2 tabular-nums">{pct(r.connectRate)}</td><td className="px-4 py-2 tabular-nums">{r.meetings}</td><td className={`px-4 py-2 tabular-nums ${r.formsOutstanding ? 'text-amber-800' : ''}`}>{r.formsOutstanding}{r.oldestFormDue ? <span className="text-[12px] text-ink-500"> · oldest {formatInstant(r.oldestFormDue, timezone)}</span> : null}</td></tr>)}</tbody></table> : <EmptyState title="No calls in this period" />}</Surface>
      <Surface flush><ViewHeader title="Outcomes and best hours" /><div className="grid grid-cols-2 gap-4 p-4 text-[13px]">
        <ul className="space-y-1">{data.byOutcome.map((o) => <li key={o.key} className="flex justify-between"><span className="text-ink-700">{o.label}</span><span className="tabular-nums">{o.count}</span></li>)}{!data.byOutcome.length ? <li className="text-ink-500">No forms yet</li> : null}</ul>
        <ul className="space-y-1">{data.bestHours.map((h) => <li key={h.slot} className="flex justify-between"><span className="text-ink-700">{h.slot}:00</span><span className="tabular-nums">{pct(h.rate)} of {h.dials}</span></li>)}{!data.bestHours.length ? <li className="text-ink-500">Not enough dials yet</li> : null}</ul>
      </div></Surface>
    </div>
    <Surface flush>
      <ViewHeader title="Calls" />
      {data.calls.length ? <table className="w-full text-[13px]"><thead><tr className="text-left text-ink-500"><th className="px-4 py-2 font-normal">When</th><th className="px-4 py-2 font-normal">Rep</th><th className="px-4 py-2 font-normal">Contact</th><th className="px-4 py-2 font-normal">Outcome</th><th className="px-4 py-2 font-normal">Rating</th><th className="px-4 py-2 font-normal">Talk</th><th className="px-4 py-2 font-normal">Recording</th></tr></thead>
        <tbody className="divide-y divide-line">{data.calls.map((c) => <tr key={c.id}><td className="px-4 py-2"><Link href={`/calls/${c.id}`} className="hover:text-brand-700">{formatInstant(c.startedAt ?? c.createdAt, timezone)}</Link></td><td className="px-4 py-2">{c.user?.name ?? '-'}</td><td className="px-4 py-2">{c.personId ? <Link href={`/people/${c.personId}`} className="hover:text-brand-700">CRM</Link> : c.sandboxContactId ? <Link href={`/sandbox/${c.sandboxContactId}`} className="hover:text-brand-700">Sandbox</Link> : (c.direction === 'OUTBOUND' ? c.toNumber : c.fromNumber) ?? '-'}</td><td className="px-4 py-2">{c.form ? data.outcomes.find((o) => o.key === c.form!.outcome)?.label ?? c.form.outcome : c.formDueAt ? 'Form due' : c.twilioStatus ?? '-'}</td><td className="px-4 py-2 tabular-nums">{c.form?.rating ?? '-'}</td><td className="px-4 py-2 tabular-nums">{c.talkSec ? mins(c.talkSec) : '-'}</td><td className="px-4 py-2">{c.recordingSid ? <Link href={`/calls/${c.id}`} className="text-brand-700 hover:underline">Play</Link> : '-'}</td></tr>)}</tbody></table> : <EmptyState title="No calls in this period" />}
    </Surface>
    <Surface flush>
      <ViewHeader title="Unmatched" meta={<span className="tabular-nums text-ink-500">{data.unmatched.length}</span>} />
      {data.unmatched.length ? <table className="w-full text-[13px]"><thead><tr className="text-left text-ink-500"><th className="px-4 py-2 font-normal">When</th><th className="px-4 py-2 font-normal">From</th><th className="px-4 py-2 font-normal">To</th><th className="px-4 py-2 font-normal">Rep</th><th className="px-4 py-2 font-normal">Contact</th></tr></thead>
        <tbody className="divide-y divide-line">{data.unmatched.map((c) => <tr key={c.id}><td className="px-4 py-2">{formatInstant(c.startedAt ?? c.createdAt, timezone)}</td><td className="px-4 py-2 tabular-nums">{c.fromNumber}</td><td className="px-4 py-2 tabular-nums">{c.toNumber}</td><td className="px-4 py-2">{c.userId ? reps.find((r) => r.id === c.userId)?.name : mayAttach ? <AssignCallRep callId={c.id} reps={reps.filter((r) => r.sales)} /> : 'Unknown'}</td><td className="px-4 py-2">{!c.personId && !c.sandboxContactId && mayAttach ? <AttachCallContact callId={c.id} candidates={(c.candidates as { kind: string; id: string; name: string }[] | null) ?? []} /> : c.personId || c.sandboxContactId ? 'Contact found, rep missing' : 'Not found'}</td></tr>)}</tbody></table> : <EmptyState title="Every call is matched" />}
    </Surface>
  </div>;
}

/** Reports' Sandbox section and the Platform totals (decision 2). */
export function SandboxAndPlatform({ data }: { data: SandboxData }) {
  const s = data.sandbox;
  return <div className="grid grid-cols-2 gap-5">
    <Surface flush>
      <ViewHeader title="Sandbox" />
      <div className="grid grid-cols-3 gap-3 p-4">
        <Stat label="Added" value={s.added} hint={`${s.pushed} from Bellwether`} />
        <Stat label="Claimed" value={s.claimed} />
        <Stat label="Called" value={s.called} hint={`${s.calls} calls`} />
        <Stat label="Connected" value={s.connected} />
        <Stat label="Meetings" value={s.meetings} />
        <Stat label="Moved to CRM" value={s.moved} />
        <Stat label="Opted out" value={s.optedOut} />
        <Stat label="Steps done" value={s.stepsDone} />
        <Stat label="Next actions done" value={s.nextActionsDone} />
      </div>
    </Surface>
    <Surface flush>
      <ViewHeader title="Platform" />
      <table className="w-full text-[13px]"><thead><tr className="text-left text-ink-500"><th className="px-4 py-2 font-normal">Measure</th><th className="px-4 py-2 font-normal">CRM</th><th className="px-4 py-2 font-normal">Sandbox</th><th className="px-4 py-2 font-normal">Platform</th></tr></thead>
        <tbody className="divide-y divide-line">{([['stepsDone', 'Steps done'], ['calls', 'Calls'], ['connects', 'Connects'], ['meetings', 'Meetings booked on calls'], ['nextActionsDone', 'Next actions done']] as const).map(([k, label]) => <tr key={k}><td className="px-4 py-2 text-ink-700">{label}</td><td className="px-4 py-2 tabular-nums">{data.platform[k].crm}</td><td className="px-4 py-2 tabular-nums">{data.platform[k].sandbox}</td><td className="px-4 py-2 tabular-nums">{data.platform[k].platform}</td></tr>)}</tbody></table>
    </Surface>
  </div>;
}
