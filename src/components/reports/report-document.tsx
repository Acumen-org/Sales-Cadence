import type { ReactNode } from 'react';
import type { Reports, GroupRow } from '@/lib/reports-query';
import { formatLocalDate } from '@/lib/dates';
import { optionLabel } from '@/lib/twenty/labels';
import { CHANNEL_COLOURS, ColumnChart, Delta, Donut, Figure, InlineBar, pct, productColour, ProgressBar, Sparkline } from './charts';

/**
 * The picture of a period: what was sent, what came back and which meetings came of it, beside
 * the period before; outreach over time and by channel; how each product did; the campaigns
 * running; then the breakdown by FO, campaign, pod and channel. Rendered on the Reports page (the
 * breakdown as tabs) and, unchanged, into the exported HTML file (every breakdown, one after
 * another). No client code, so it prints.
 */
/** A campaign under way, by how far through its window it is. `day` is 0 or less before it starts. */
export type RunningCampaign = { id: string; name: string; podName: string; products: string[]; paused: boolean; startDate: string; endDate: string | null; day: number; total: number | null; touchesDone: number; touchesPlanned: number };

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
  /** The workspace's clock, for when the export was made. */
  timezone?: string;
};

export const BREAKDOWNS = [
  { key: 'fos', label: 'By FO' },
  { key: 'campaigns', label: 'By campaign' },
  { key: 'pods', label: 'By pod' },
  { key: 'channels', label: 'By channel' },
] as const;
export type BreakdownKey = (typeof BREAKDOWNS)[number]['key'];

const fmt = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

function Tile({ label, value, shown, previous, series, sub, rate }: { label: string; value: number; shown?: string; previous: number | null; series: number[]; sub?: ReactNode; rate?: boolean }) {
  return (
    <div className="rp-card rp-tile">
      <div style={{ minWidth: 0 }}>
        <div className="rp-label">{label}</div>
        <div className={`rp-value${value === 0 ? ' rp-zero' : ''}`}>{shown ?? fmt(value)}</div>
        <div className="rp-sub">
          {previous !== null ? <Delta current={value} previous={previous} rate={rate} /> : null}
          {sub}
        </div>
      </div>
      <Sparkline values={series} label={`${label}, over the period`} />
    </div>
  );
}

export function ReportDocument({ reports, previous, range, compared, scope, campaigns, breakdown, generatedBy, generatedAt, timezone }: ReportDocumentProps) {
  const r = reports;
  const p = previous;
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1;
  const t = r.totals;
  // The year only where it is not the period's own.
  const day = (d: string) => formatLocalDate(d, d.slice(0, 4) === range.to.slice(0, 4) ? 'short' : 'year');

  return (
    <div className="rp">
      <div className="rp-meta">
        <span><span className="rp-strong">{formatLocalDate(range.from, 'long')}</span> → <span className="rp-strong">{formatLocalDate(range.to, 'long')}</span> · {plural(days, 'day')} · {scope}{compared ? <> · compared with {day(compared.from)} → {day(compared.to)}</> : null}</span>
        {generatedAt ? <span>Generated {generatedAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', ...(timezone ? { timeZone: timezone } : {}) })}{generatedBy ? ` by ${generatedBy}` : ''}</span> : null}
      </div>

      <div className="rp-tiles">
        <Tile label="Sent" value={t.sent} previous={p?.totals.sent ?? null} series={r.series.map((b) => b.sent)} sub={t.reached ? <span>to {plural(t.reached, 'person', 'people')}</span> : null} />
        <Tile label="Replies" value={t.replies} previous={p?.totals.replies ?? null} series={r.series.map((b) => b.replies)} sub={t.repliedPeople ? <span>from {plural(t.repliedPeople, 'person', 'people')}</span> : null} />
        <Tile label="Meetings" value={t.meetings} previous={p?.totals.meetings ?? null} series={r.series.map((b) => b.meetings)} />
        <Tile label="Reply rate" value={t.replyRate} shown={pct(t.replyRate)} previous={p ? p.totals.replyRate : null} series={r.series.map((b) => (b.sent ? b.replies / b.sent : 0))} rate sub={t.sent ? <span>meeting rate {pct(t.meetingRate)}</span> : null} />
      </div>

      <div className="rp-row">
        <Figure title="Outreach sent" aside={r.unit === 'day' ? 'per day' : r.unit === 'week' ? 'per week' : 'per month'}>
          {t.sent ? <ColumnChart buckets={r.series} unit={r.unit} /> : <p className="rp-empty">Nothing sent in this period</p>}
        </Figure>
        <Figure title="By channel">
          <Donut slices={r.sentByChannel} colour={(k) => CHANNEL_COLOURS[k as keyof typeof CHANNEL_COLOURS]} centre="sent" />
        </Figure>
      </div>

      <div className="rp-row">
        <Figure title="Product performance">
          <ProductTable rows={r.byProduct} previous={p?.byProduct ?? []} />
        </Figure>
        <Figure title="Meetings by product">
          <Donut slices={r.meetingsByProduct} colour={productColour} centre={t.meetings === 1 ? 'meeting' : 'meetings'} />
        </Figure>
      </div>

      <Figure title="Campaigns running" aside={campaigns.length ? `${campaigns.length} under way` : undefined}>
        {campaigns.length ? (
          <div className="rp-campaigns">
            {campaigns.map((c) => (
              <div key={c.id} className="rp-campaign">
                <div style={{ minWidth: 0 }}><div className="rp-clamp" title={c.name}>{c.name}</div><div className="rp-small">{[c.podName, c.products.map(optionLabel).join(', ')].filter(Boolean).join(' · ')}</div></div>
                <div>
                  <div className="rp-split"><span>{c.day < 1 ? `Starts ${formatLocalDate(c.startDate)}` : c.total ? <>Day {Math.min(c.day, c.total)} of {c.total}</> : c.day === 1 ? 'Started today' : `Since ${formatLocalDate(c.startDate)}`}</span><span className="rp-num">{fmt(c.touchesDone)} of {plural(c.touchesPlanned, 'touch', 'touches')}</span></div>
                  {c.total ? <ProgressBar value={Math.max(0, c.day)} total={c.total} over={c.day > c.total} /> : null}
                </div>
                <div className="rp-end">{c.paused ? 'Paused' : c.endDate ? `Ends ${formatLocalDate(c.endDate)}` : null}</div>
              </div>
            ))}
          </div>
        ) : <p className="rp-empty">No campaign is running</p>}
      </Figure>

      {breakdown ?? BREAKDOWNS.map((b) => (
        <Figure key={b.key} title={b.label} aside={p ? 'against the period before' : undefined}>
          <BreakdownTable tab={b.key} reports={r} previous={p} />
        </Figure>
      ))}
    </div>
  );
}

const none = <p className="rp-empty">No results in this period</p>;
const withDelta = (key: string, value: number, before: number | undefined) => (
  <td key={key} className="rp-r">{fmt(value)}{before !== undefined ? <> <Delta current={value} previous={before} /></> : null}</td>
);

/** Each product: what was sent, what came back and the meetings, each bar against the largest. */
function ProductTable({ rows, previous }: { rows: GroupRow[]; previous: GroupRow[] }) {
  const shown = rows.filter((x) => x.sent || x.replies || x.meetings);
  if (!shown.length) return none;
  const before = new Map(previous.map((x) => [x.key, x]));
  const max = { sent: Math.max(...shown.map((x) => x.sent)), replies: Math.max(...shown.map((x) => x.replies)), meetings: Math.max(...shown.map((x) => x.meetings)) };
  return (
    <div className="rp-scroll"><table className="rp-table">
      <thead><tr><th>Product</th><th>Sent</th><th>Replies</th><th>Meetings</th><th className="rp-r">Reply rate</th><th className="rp-r">Meeting rate</th></tr></thead>
      <tbody>
        {shown.map((x) => {
          const b = before.get(x.key);
          const colour = productColour(x.key);
          return (
            <tr key={x.key}>
              <td><span className="rp-key rp-name"><span className="rp-swatch" style={{ background: colour }} />{x.label}</span></td>
              <td><InlineBar value={x.sent} max={max.sent} colour={colour} label={`${x.label}, sent`} /></td>
              <td><InlineBar value={x.replies} max={max.replies} colour={colour} label={`${x.label}, replies`} /></td>
              <td><InlineBar value={x.meetings} max={max.meetings} colour={colour} label={`${x.label}, meetings`} /></td>
              <td className="rp-r">{pct(x.replyRate)}{b ? <div className="rp-was">was {pct(b.replyRate)}</div> : null}</td>
              <td className="rp-r">{pct(x.meetingRate)}{b ? <div className="rp-was">was {pct(b.meetingRate)}</div> : null}</td>
            </tr>
          );
        })}
      </tbody>
    </table></div>
  );
}

/** One breakdown of the period, each figure beside the period before. */
export function BreakdownTable({ tab, reports, previous }: { tab: BreakdownKey; reports: Reports; previous: Reports | null }) {
  if (tab === 'channels') return <ChannelTable reports={reports} previous={previous} />;
  const rows = tab === 'fos' ? reports.byFo : tab === 'pods' ? reports.byPod : reports.byCampaign;
  const before = tab === 'fos' ? previous?.byFo : tab === 'pods' ? previous?.byPod : previous?.byCampaign;
  return <GroupTable rows={rows} previous={before ?? null} first={tab === 'fos' ? 'FO' : tab === 'pods' ? 'Pod' : 'Campaign'} channels={tab === 'fos'} />;
}

/** The roll-up: what went out (by channel, for FOs), to how many people, and what came back. */
export function GroupTable({ rows, previous, first, channels }: { rows: GroupRow[]; previous: GroupRow[] | null; first: string; channels?: boolean }) {
  const shown = rows.filter((x) => x.sent || x.replies || x.meetings);
  if (!shown.length) return none;
  const prev = new Map((previous ?? []).map((x) => [x.key, x]));
  const has = (k: string) => (previous ? prev.get(k) : undefined);
  return (
    <div className="rp-scroll"><table className="rp-table">
      <thead><tr><th>{first}</th>{channels ? <><th className="rp-r">Email</th><th className="rp-r">Calls</th><th className="rp-r">LinkedIn</th></> : null}<th className="rp-r">Sent</th><th className="rp-r">People</th><th className="rp-r">Replies</th><th className="rp-r">Meetings</th><th className="rp-r">Reply rate</th><th className="rp-r">Meeting rate</th></tr></thead>
      <tbody>
        {shown.map((x) => {
          const b = has(x.key);
          const zero = previous ? 0 : undefined;
          return (
            <tr key={x.key}>
              <td className="rp-name">{x.label}</td>
              {channels ? <>
                <td className="rp-r">{fmt(x.emails)}</td>
                <td className="rp-r">{fmt(x.calls)}{x.calls ? <span className="rp-muted"> · {fmt(x.answered)} answered</span> : null}</td>
                <td className="rp-r">{fmt(x.linkedin)}</td>
              </> : null}
              {withDelta('s', x.sent, b?.sent ?? zero)}
              <td className="rp-r">{fmt(x.reached)}</td>
              {withDelta('r', x.replies, b?.replies ?? zero)}
              {withDelta('m', x.meetings, b?.meetings ?? zero)}
              <td className="rp-r">{pct(x.replyRate)}</td>
              <td className="rp-r">{pct(x.meetingRate)}</td>
            </tr>
          );
        })}
      </tbody>
    </table></div>
  );
}

/** Each channel: what was done and how we know, what was skipped, and what is still open. */
function ChannelTable({ reports, previous }: { reports: Reports; previous: Reports | null }) {
  const rows = reports.channels.filter((c) => c.done || c.skipped || c.open);
  if (!rows.length) return none;
  return (
    <div className="rp-scroll"><table className="rp-table">
      <thead><tr><th>Channel</th><th className="rp-r">Done</th><th className="rp-r">Closed from Twenty</th><th className="rp-r">Marked done</th><th className="rp-r">Skipped</th><th className="rp-r">Still open</th><th className="rp-r">Overdue</th></tr></thead>
      <tbody>{rows.map((c) => {
        const b = previous?.channels.find((x) => x.action === c.action);
        return <tr key={c.action}><td className="rp-name">{c.label}</td>{withDelta('d', c.done, previous ? b?.done ?? 0 : undefined)}<td className="rp-r">{fmt(c.observed)}</td><td className="rp-r">{fmt(c.manual)}</td><td className="rp-r">{fmt(c.skipped)}</td><td className="rp-r">{fmt(c.open)}</td><td className="rp-r">{fmt(c.overdue)}</td></tr>;
      })}</tbody>
    </table></div>
  );
}
