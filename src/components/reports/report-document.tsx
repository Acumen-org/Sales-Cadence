import type { ReactNode } from 'react';
import type { Reports, GroupRow } from '@/lib/reports-query';
import { formatLocalDate } from '@/lib/dates';
import { Delta, Figure, Funnel, ProgressBar, Sparkline } from './charts';

/**
 * The picture of a period, for leadership: the headline numbers with what they were in the period
 * before, where the funnel narrows beside the campaigns running and how far along they are, then
 * the breakdown by FO, pod, campaign and channel. Rendered on the
 * Reports page (the breakdown as tabs) and, unchanged, into the exported HTML file (every
 * breakdown, one after another). No client code, so it prints.
 */
export type RunningCampaign = { id: string; name: string; podName: string; startDate: string; endDate: string | null; day: number; total: number | null; touchesDone: number; touchesPlanned: number; replied: number; meetings: number };

export type ReportDocumentProps = {
  reports: Reports;
  previous: Reports | null;
  range: { from: string; to: string };
  /** The period the changes are measured against, said once beside the range. */
  compared?: { from: string; to: string } | null;
  scope: string;
  campaigns: RunningCampaign[];
  /** The page passes its tabbed breakdown; the export leaves it out and gets every table. */
  breakdown?: ReactNode;
  generatedBy?: string | null;
  generatedAt?: Date | null;
};

export const BREAKDOWNS = [
  { key: 'fos', label: 'By FO' },
  { key: 'pods', label: 'By pod' },
  { key: 'campaigns', label: 'By campaign' },
  { key: 'channels', label: 'By channel' },
] as const;
export type BreakdownKey = (typeof BREAKDOWNS)[number]['key'];

/** What the rates are out of, since it is not the Started column. */
export const RATES_NOTE = 'Reply and meeting rates are out of the people who started in this period, not counting anyone taken out of outreach.';

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function Tile({ label, value, previous, series, invert }: { label: string; value: number; previous: number | null; series: number[]; invert?: boolean }) {
  return (
    <div className="surface flex items-start justify-between gap-4 px-5 py-5">
      <div className="min-w-0">
        <div className="text-[11px] font-medium text-ink-500">{label}</div>
        <div className={`mt-2 text-[30px] font-semibold leading-tight tracking-[-0.04em] tabular-nums ${value === 0 ? 'text-ink-400' : 'text-ink-900'}`}>{value.toLocaleString('en-US')}</div>
        {previous !== null ? <div className="mt-1 flex items-center gap-1.5"><Delta current={value} previous={previous} invert={invert} /><span className="text-[11.5px] text-ink-500">was {previous.toLocaleString('en-US')}</span></div> : null}
      </div>
      <Sparkline values={series} label={`${label}, day by day`} />
    </div>
  );
}

export function ReportDocument({ reports, previous, range, compared, scope, campaigns, breakdown, generatedBy, generatedAt }: ReportDocumentProps) {
  const r = reports;
  const p = previous;
  const funnel = [
    { label: 'Started', value: r.funnel.enrolled },
    { label: 'Contacted', value: r.funnel.touched },
    { label: 'Responded', value: r.funnel.replied, hint: 'Replied, or booked a meeting' },
    { label: 'Meeting booked', value: r.funnel.meeting },
  ];
  const days = r.daily.length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3 text-[12.5px] text-ink-600">
        <span><span className="font-medium text-ink-900">{formatLocalDate(range.from, 'long')}</span> → <span className="font-medium text-ink-900">{formatLocalDate(range.to, 'long')}</span> · {days} days · {scope}{compared ? <> · compared with {formatLocalDate(compared.from)} → {formatLocalDate(compared.to)}</> : null}</span>
        {generatedAt ? <span>Generated {generatedAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}{generatedBy ? ` by ${generatedBy}` : ''}</span> : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="People started" value={r.totals.enrollments} previous={p?.totals.enrollments ?? null} series={r.daily.map((d) => d.enrollments)} />
        <Tile label="Touches done" value={r.totals.tasksDone} previous={p?.totals.tasksDone ?? null} series={r.daily.map((d) => d.tasksDone)} />
        <Tile label="Replies" value={r.totals.replied} previous={p?.totals.replied ?? null} series={r.daily.map((d) => d.replies)} />
        <Tile label="Meetings" value={r.totals.meeting} previous={p?.totals.meeting ?? null} series={r.daily.map((d) => d.meetings)} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Figure title="From first touch to meeting" aside={r.funnel.enrolled ? `${Math.round((r.funnel.meeting / r.funnel.enrolled) * 100)}% booked a meeting` : undefined}>
          <Funnel stages={funnel} />
        </Figure>
      {campaigns.length ? (
        <Figure title="Campaigns running" aside={`${campaigns.length} active, to date`}>
          <div className="space-y-3">
            {campaigns.map((c) => (
              <div key={c.id} className="grid gap-2 text-[12.5px] md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_minmax(0,9rem)] md:items-center md:gap-4">
                <div className="min-w-0"><div className="line-clamp-2 break-words font-medium text-ink-900" title={c.name}>{c.name}</div><div className="truncate text-[12px] text-ink-500">{c.podName}</div></div>
                <div>
                  <div className="flex justify-between text-[12px] text-ink-600"><span>{c.total ? <>Day <span className="tabular-nums">{Math.min(c.day, c.total)}</span> of {c.total}</> : c.day === 1 ? 'Started today' : `Since ${formatLocalDate(c.startDate)}`}</span><span className="tabular-nums">{c.touchesDone.toLocaleString('en-US')} of {plural(c.touchesPlanned, 'touch', 'touches')}</span></div>
                  {c.total ? <div className="mt-1.5"><ProgressBar value={c.day} total={c.total} over={c.day > c.total} /></div> : null}
                </div>
                <div className="tabular-nums text-ink-700 md:text-right">{plural(c.replied, 'reply', 'replies')} · {plural(c.meetings, 'meeting')}</div>
              </div>
            ))}
          </div>
        </Figure>
      ) : <Figure title="Campaigns running"><p className="text-[12.5px] text-ink-400">No campaign is running</p></Figure>}
      </div>

      {breakdown ?? BREAKDOWNS.map((b) => (
        <Figure key={b.key} title={b.label} aside="this period against the one before">
          <BreakdownTable tab={b.key} reports={r} previous={p} />
        </Figure>
      ))}
      {breakdown ? null : <p className="text-[12px] text-ink-500">{RATES_NOTE}</p>}
    </div>
  );
}

/** One breakdown of the period, each figure beside the period before. */
export function BreakdownTable({ tab, reports, previous }: { tab: BreakdownKey; reports: Reports; previous: Reports | null }) {
  if (tab === 'fos') return <FoTable reports={reports} previous={previous} />;
  if (tab === 'channels') return <ChannelTable reports={reports} previous={previous} />;
  const rows = (tab === 'pods' ? reports.byPod : reports.byCampaign).filter((x) => x.enrolled || x.replied || x.meeting || x.tasksDone);
  return <GroupCompare rows={rows} previous={(tab === 'pods' ? previous?.byPod : previous?.byCampaign) ?? []} first={tab === 'pods' ? 'Pod' : 'Campaign'} />;
}

const none = <p className="text-[12.5px] text-ink-400">No results in this period</p>;
const rate = (value: number, before: number | undefined) => <td className="num tabular-nums">{Math.round(value * 100)}%{before !== undefined ? <span className="ml-2 text-[12px] text-ink-500">was {Math.round(before * 100)}%</span> : null}</td>;
const counted = (key: string, value: number, before: number | undefined) => (
  <td key={key} className="num"><span className="tabular-nums">{value.toLocaleString('en-US')}</span>{before !== undefined ? <span className="ml-2 inline-block"><Delta current={value} previous={before} /></span> : null}</td>
);

/** Each FO: what they did, by channel, and what came of it - one row, one place. */
function FoTable({ reports, previous }: { reports: Reports; previous: Reports | null }) {
  const outcome = new Map(reports.byFo.map((r) => [r.key, r]));
  const before = new Map((previous?.byFo ?? []).map((r) => [r.key, r]));
  const beforeWork = new Map((previous?.activity ?? []).map((r) => [r.id, r.period]));
  const rows = reports.activity.filter((a) => a.period.total || outcome.get(a.id)?.enrolled || outcome.get(a.id)?.replied || outcome.get(a.id)?.meeting);
  if (!rows.length) return none;
  return (
    <div className="overflow-x-auto">
      <table className="table table-dense">
        <thead><tr><th>FO</th><th className="num">Started</th><th className="num">Email</th><th className="num">Calls</th><th className="num">LinkedIn</th><th className="num">Touches</th><th className="num">Replies</th><th className="num">Meetings</th><th className="num">Reply rate</th><th className="num">Meeting rate</th></tr></thead>
        <tbody>
          {rows.map((a) => {
            const o = outcome.get(a.id), b = before.get(a.id);
            return (
              <tr key={a.id}>
                <td className="whitespace-nowrap text-[13px] text-ink-900">{a.name}</td>
                {counted('s', o?.enrolled ?? 0, b?.enrolled)}
                <td className="num tabular-nums">{a.period.emails.toLocaleString('en-US')}</td>
                <td className="num tabular-nums">{a.period.calls.toLocaleString('en-US')}{a.period.calls ? <span className="ml-1.5 text-[12px] text-ink-500">({a.period.answered} answered)</span> : null}</td>
                <td className="num tabular-nums">{a.period.linkedin.toLocaleString('en-US')}</td>
                {counted('t', a.period.total, beforeWork.get(a.id)?.total)}
                {counted('r', o?.replied ?? 0, b?.replied)}
                {counted('m', o?.meeting ?? 0, b?.meeting)}
                {rate(o?.replyRate ?? 0, b?.replyRate)}
                {rate(o?.meetingRate ?? 0, b?.meetingRate)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Each channel: what is still to do, what was done and how we know, and what did not happen. */
function ChannelTable({ reports, previous }: { reports: Reports; previous: Reports | null }) {
  const rows = reports.channels.filter((c) => c.pending || c.done || c.skipped || c.cancelled);
  if (!rows.length) return none;
  return (
    <div className="overflow-x-auto">
      <table className="table table-dense">
        <thead><tr><th>Channel</th><th className="num">Still to do</th><th className="num">Done</th><th className="num">Logged in Twenty</th><th className="num">Marked done by FO</th><th className="num">Skipped</th><th className="num">Cancelled</th></tr></thead>
        <tbody>{rows.map((c) => {
          const b = previous?.channels.find((x) => x.action === c.action);
          return <tr key={c.action}><td className="text-[13px] text-ink-900">{c.label}</td><td className="num tabular-nums">{c.pending.toLocaleString('en-US')}</td>{counted('d', c.done, b?.done)}<td className="num tabular-nums">{c.observed.toLocaleString('en-US')}</td><td className="num tabular-nums">{c.manual.toLocaleString('en-US')}</td><td className="num tabular-nums">{c.skipped.toLocaleString('en-US')}</td><td className="num tabular-nums">{c.cancelled.toLocaleString('en-US')}</td></tr>;
        })}</tbody>
      </table>
    </div>
  );
}

/** The roll-up table with the previous period beside each figure. */
export function GroupCompare({ rows, previous, first }: { rows: GroupRow[]; previous: GroupRow[]; first: string }) {
  const prev = new Map(previous.map((r) => [r.key, r]));
  if (!rows.length) return none;
  return (
    <div className="overflow-x-auto">
      <table className="table table-dense">
        <thead><tr><th>{first}</th><th className="num">Started</th><th className="num">Touches</th><th className="num">Replies</th><th className="num">Meetings</th><th className="num">Reply rate</th><th className="num">Meeting rate</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const b = prev.get(r.key);
            return (
              <tr key={r.key}>
                <td className="text-[13px] text-ink-900">{r.label}</td>
                {counted('e', r.enrolled, b?.enrolled)}
                {counted('t', r.tasksDone, b?.tasksDone)}
                {counted('r', r.replied, b?.replied)}
                {counted('m', r.meeting, b?.meeting)}
                {rate(r.replyRate, b?.replyRate)}
                {rate(r.meetingRate, b?.meetingRate)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
