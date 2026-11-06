import type { ReactNode } from 'react';
import type { Activity, People, Reports, GroupRow } from '@/lib/reports-query';
import { formatLocalDate } from '@/lib/dates';
import { optionLabel } from '@/lib/twenty/labels';
import { CHANNEL_COLOURS, ColumnChart, Delta, Donut, Figure, InlineBar, pct, productColour, ProgressBar, Sparkline } from './charts';

/**
 * The picture of a period for one audience (PLAN 6: All outreach, CRM or Cold outreach): what was
 * sent, what came back and which meetings came of it, beside the period before; outreach over time
 * and by channel; how each product did; Cold outreach's funnel; the campaigns running; then the
 * breakdown by FO, campaign, pod and channel. Rendered on the Reports page (the breakdown as tabs)
 * and, unchanged, into the exported HTML file (every breakdown, one after another). No client code,
 * so it prints.
 *
 * Two kinds of figure, each marked in its tooltip: activity figures add up (All outreach = CRM +
 * Cold, and on calls + Not matched yet), so All outreach says "10 · 7 CRM · 3 Cold"; people figures
 * count each person once, so a person moved to the CRM is "1 in both" and All is not CRM + Cold.
 */
/** A campaign under way, by how far through its window it is. `day` is 0 or less before it starts. */
export type RunningCampaign = { id: string; name: string; podName: string; products: string[]; paused: boolean; startDate: string; endDate: string | null; day: number; total: number | null; touchesDone: number; touchesPlanned: number; cold?: boolean };

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

export const ACTIVITY_TIP = 'Work done: All outreach is CRM plus Cold outreach';
export const PEOPLE_TIP = 'People: each person counted once, so someone reached in both counts once in All outreach';

/** All outreach's sub-line for an activity figure: "7 CRM · 3 Cold", and on calls "· 2 not matched yet". */
export function activityParts(parts: Reports['parts'], key: keyof Activity): string {
  const unmatched = parts.unmatched[key];
  return [`${fmt(parts.crm[key])} CRM`, `${fmt(parts.cold[key])} Cold`, ...(unmatched ? [`${fmt(unmatched)} not matched yet`] : [])].join(' · ');
}
/** All outreach's sub-line for a people figure: "7 CRM · 4 Cold · 1 in both". */
export function peopleParts(p: People): string {
  return [`${fmt(p.crm)} CRM`, `${fmt(p.cold)} Cold`, ...(p.both ? [`${fmt(p.both)} in both`] : [])].join(' · ');
}

function Tile({ label, value, shown, previous, series, sub, rate, parts, tip }: { label: string; value: number; shown?: string; previous: number | null; series: number[]; sub?: ReactNode; rate?: boolean; parts?: string | null; tip: string }) {
  return (
    <div className="rp-card rp-tile" title={tip}>
      <div style={{ minWidth: 0 }}>
        <div className="rp-label">{label}</div>
        <div className={`rp-value${value === 0 ? ' rp-zero' : ''}`}>{shown ?? fmt(value)}</div>
        <div className="rp-sub">
          {previous !== null ? <Delta current={value} previous={previous} rate={rate} /> : null}
          {sub}
        </div>
        {parts ? <div className="rp-parts">{parts}</div> : null}
      </div>
      <Sparkline values={series} label={`${label}, over the period`} />
    </div>
  );
}

/** A smaller figure with no chart: calls, connects, meetings booked and the people figures. */
export function Fact({ label, value, shown, previous, parts, tip, warn, note, rate }: { label: string; value: number; shown?: string; previous: number | null; parts?: string | null; tip: string; warn?: boolean; note?: ReactNode; rate?: boolean }) {
  return (
    <div className={`rp-card rp-fact${warn && value ? ' rp-warn' : ''}`} title={tip}>
      <div className="rp-label">{label}</div>
      <div className={`rp-fact-value${value === 0 ? ' rp-zero' : ''}`}>{shown ?? fmt(value)}</div>
      {previous !== null || note ? <div className="rp-sub">{previous !== null ? <Delta current={value} previous={previous} invert={warn} rate={rate} /> : null}{note}</div> : null}
      {parts ? <div className="rp-parts">{parts}</div> : null}
    </div>
  );
}

export function ReportDocument({ reports, previous, range, compared, scope, campaigns, breakdown, generatedBy, generatedAt, timezone }: ReportDocumentProps) {
  const r = reports;
  const p = previous;
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1;
  const t = r.totals;
  const all = r.audience === 'all';
  const people = (x: People) => (r.audience === 'crm' ? x.crm : r.audience === 'cold' ? x.cold : x.all);
  const parts = (key: keyof Activity) => (all ? activityParts(r.parts, key) : null);
  // The year only where it is not the period's own.
  const day = (d: string) => formatLocalDate(d, d.slice(0, 4) === range.to.slice(0, 4) ? 'short' : 'year');

  return (
    <div className="rp">
      <div className="rp-meta">
        <span><span className="rp-strong">{formatLocalDate(range.from, 'long')}</span> → <span className="rp-strong">{formatLocalDate(range.to, 'long')}</span> · {plural(days, 'day')} · {scope}{compared ? <> · compared with {day(compared.from)} → {day(compared.to)}</> : null}</span>
        {generatedAt ? <span>Generated {generatedAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', ...(timezone ? { timeZone: timezone } : {}) })}{generatedBy ? ` by ${generatedBy}` : ''}</span> : null}
      </div>

      <div className="rp-tiles">
        <Tile label="Sent" tip={ACTIVITY_TIP} value={t.sent} previous={p?.totals.sent ?? null} series={r.series.map((b) => b.sent)} sub={t.reached ? <span>to {plural(t.reached, 'person', 'people')}</span> : null} parts={parts('sent')} />
        <Tile label="Replies" tip={ACTIVITY_TIP} value={t.replies} previous={p?.totals.replies ?? null} series={r.series.map((b) => b.replies)} sub={t.repliedPeople ? <span>from {plural(t.repliedPeople, 'person', 'people')}</span> : null} parts={parts('replies')} />
        <Tile label="Meetings held" tip={ACTIVITY_TIP} value={t.meetings} previous={p?.totals.meetings ?? null} series={r.series.map((b) => b.meetings)} parts={parts('meetings')} />
        <Tile label="Reply rate" tip="Replies out of what was sent" value={t.replyRate} shown={pct(t.replyRate)} previous={p ? p.totals.replyRate : null} series={r.series.map((b) => (b.sent ? b.replies / b.sent : 0))} rate sub={t.sent ? <span>meeting rate {pct(t.meetingRate)}</span> : null} />
      </div>

      <div className="rp-facts">
        <Fact label="Calls" tip={ACTIVITY_TIP} value={t.dials} previous={p?.totals.dials ?? null} parts={parts('dials')} />
        <Fact label="Connects" tip={`${ACTIVITY_TIP}. Calls out that the person answered.`} value={t.connects} previous={p?.totals.connects ?? null} parts={parts('connects')} />
        <Fact label="Meetings booked" tip={`${ACTIVITY_TIP}. Booked on the post-call form; never added to meetings held.`} value={t.booked} previous={p?.totals.booked ?? null} parts={parts('booked')} />
        <Fact label="People reached" tip={PEOPLE_TIP} value={people(r.people.reached)} previous={p ? people(p.people.reached) : null} parts={all ? peopleParts(r.people.reached) : null} />
        <Fact label="People who replied" tip={PEOPLE_TIP} value={people(r.people.replied)} previous={p ? people(p.people.replied) : null} parts={all ? peopleParts(r.people.replied) : null} />
        <Fact label="Emails to people who must not be contacted" tip="Emails seen in a sales mailbox to someone who opted out or was removed. Nothing about them was stored; the rep and pod leaders were told." value={t.doNotContactEmails} previous={null} warn />
      </div>

      {r.cold ? <ColdFunnelFigure cold={r.cold} /> : null}

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
        <Figure title="Meetings by product" aside="held">
          <Donut slices={r.meetingsByProduct} colour={productColour} centre={t.meetings === 1 ? 'meeting' : 'meetings'} />
        </Figure>
      </div>

      <Figure title="Campaigns running" aside={campaigns.length ? `${campaigns.length} under way` : undefined}>
        {campaigns.length ? (
          <div className="rp-campaigns">
            {campaigns.map((c) => (
              <div key={c.id} className="rp-campaign">
                <div style={{ minWidth: 0 }}><div className="rp-clamp" title={c.name}>{c.name}{c.cold ? <span className="rp-badge">Cold</span> : null}</div><div className="rp-small">{[c.podName, c.products.map(optionLabel).join(', ')].filter(Boolean).join(' · ')}</div></div>
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

/**
 * Cold outreach's funnel (PLAN 6): Added → Claimed → Worked → Connected → Meeting booked → Moved to
 * CRM, with Opted out and Removed beside it; each a number of contacts. Then the same by rep (4.8).
 */
function ColdFunnelFigure({ cold }: { cold: NonNullable<Reports['cold']> }) {
  const f = cold.funnel;
  const stages = [
    { label: 'Added', value: f.added, note: f.fromBellwether ? `${fmt(f.fromBellwether)} from Bellwether` : null },
    { label: 'Claimed', value: f.claimed, note: null },
    { label: 'Worked', value: f.worked, note: null },
    { label: 'Connected', value: f.connected, note: null },
    { label: 'Meeting booked', value: f.booked, note: null },
    { label: 'Moved to CRM', value: f.moved, note: null },
  ];
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className="rp-row">
      <Figure title="Cold outreach funnel" aside="contacts, each once per stage">
        <table className="rp-table">
          <tbody>
            {stages.map((s) => <tr key={s.label}><td className="rp-name">{s.label}{s.note ? <div className="rp-small">{s.note}</div> : null}</td><td><InlineBar value={s.value} max={max} colour="#24735e" label={s.label} /></td></tr>)}
            <tr><td className="rp-name">Opted out</td><td className="rp-r">{fmt(f.optedOut)}</td></tr>
            <tr><td className="rp-name">Removed</td><td className="rp-r">{fmt(f.removed)}</td></tr>
          </tbody>
        </table>
      </Figure>
      <Figure title="Cold outreach by rep">
        {cold.byRep.length ? (
          <div className="rp-scroll"><table className="rp-table">
            <thead><tr><th>Rep</th><th className="rp-r">Claimed</th><th className="rp-r">Worked</th><th className="rp-r">Connected</th><th className="rp-r">Meeting booked</th><th className="rp-r">Moved to CRM</th></tr></thead>
            <tbody>{cold.byRep.map((x) => <tr key={x.key}><td className="rp-name">{x.label}</td><td className="rp-r">{fmt(x.claimed)}</td><td className="rp-r">{fmt(x.worked)}</td><td className="rp-r">{fmt(x.connected)}</td><td className="rp-r">{fmt(x.booked)}</td><td className="rp-r">{fmt(x.moved)}</td></tr>)}</tbody>
          </table></div>
        ) : none}
      </Figure>
    </div>
  );
}

const none = <p className="rp-empty">No results in this period</p>;
const withDelta = (key: string, value: number, before: number | undefined) => (
  <td key={key} className="rp-r">{fmt(value)}{before !== undefined ? <> <Delta current={value} previous={before} /></> : null}</td>
);

/** Each product: what was sent, what came back and the meetings, each bar against the largest. */
function ProductTable({ rows, previous }: { rows: GroupRow[]; previous: GroupRow[] }) {
  const shown = rows.filter((x) => x.sent || x.replies || x.meetings || x.booked);
  if (!shown.length) return none;
  const before = new Map(previous.map((x) => [x.key, x]));
  const max = { sent: Math.max(...shown.map((x) => x.sent)), replies: Math.max(...shown.map((x) => x.replies)), meetings: Math.max(...shown.map((x) => x.meetings)) };
  return (
    <div className="rp-scroll"><table className="rp-table">
      <thead><tr><th>Product</th><th>Sent</th><th>Replies</th><th>Meetings held</th><th className="rp-r">Reply rate</th><th className="rp-r">Meeting rate</th></tr></thead>
      <tbody>
        {shown.map((x) => {
          const b = before.get(x.key);
          const colour = productColour(x.key);
          return (
            <tr key={x.key}>
              <td><span className="rp-key rp-name"><span className="rp-swatch" style={{ background: colour }} />{x.label}</span></td>
              <td><InlineBar value={x.sent} max={max.sent} colour={colour} label={`${x.label}, sent`} /></td>
              <td><InlineBar value={x.replies} max={max.replies} colour={colour} label={`${x.label}, replies`} /></td>
              <td><InlineBar value={x.meetings} max={max.meetings} colour={colour} label={`${x.label}, meetings held`} /></td>
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
  const shown = rows.filter((x) => x.sent || x.replies || x.meetings || x.booked);
  if (!shown.length) return none;
  const prev = new Map((previous ?? []).map((x) => [x.key, x]));
  const has = (k: string) => (previous ? prev.get(k) : undefined);
  return (
    <div className="rp-scroll"><table className="rp-table">
      <thead><tr><th>{first}</th>{channels ? <><th className="rp-r">Email</th><th className="rp-r">Calls</th><th className="rp-r">LinkedIn</th></> : null}<th className="rp-r">Sent</th><th className="rp-r">People</th><th className="rp-r">Replies</th><th className="rp-r">Meetings held</th><th className="rp-r">Booked</th><th className="rp-r">Reply rate</th><th className="rp-r">Meeting rate</th></tr></thead>
      <tbody>
        {shown.map((x) => {
          const b = has(x.key);
          const zero = previous ? 0 : undefined;
          return (
            <tr key={x.key}>
              <td className="rp-name">{x.label}{x.cold ? <span className="rp-badge">Cold</span> : null}</td>
              {channels ? <>
                <td className="rp-r">{fmt(x.emails)}</td>
                <td className="rp-r">{fmt(x.calls)}{x.calls ? <span className="rp-muted"> · {fmt(x.answered)} answered</span> : null}</td>
                <td className="rp-r">{fmt(x.linkedin)}</td>
              </> : null}
              {withDelta('s', x.sent, b?.sent ?? zero)}
              <td className="rp-r">{fmt(x.reached)}</td>
              {withDelta('r', x.replies, b?.replies ?? zero)}
              {withDelta('m', x.meetings, b?.meetings ?? zero)}
              <td className="rp-r">{fmt(x.booked)}</td>
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
      <thead><tr><th>Channel</th><th className="rp-r">Done</th><th className="rp-r">Closed itself</th><th className="rp-r">Marked done</th><th className="rp-r">Skipped</th><th className="rp-r">Still open</th><th className="rp-r">Overdue</th></tr></thead>
      <tbody>{rows.map((c) => {
        const b = previous?.channels.find((x) => x.action === c.action);
        return <tr key={c.action}><td className="rp-name">{c.label}</td>{withDelta('d', c.done, previous ? b?.done ?? 0 : undefined)}<td className="rp-r">{fmt(c.observed)}</td><td className="rp-r">{fmt(c.manual)}</td><td className="rp-r">{fmt(c.skipped)}</td><td className="rp-r">{fmt(c.open)}</td><td className="rp-r">{fmt(c.overdue)}</td></tr>;
      })}</tbody>
    </table></div>
  );
}
