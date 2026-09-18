import type { Reports, GroupRow } from '@/lib/reports-query';
import { formatLocalDate } from '@/lib/dates';
import { Bars, ChannelBars, Delta, Figure, Funnel, Heatmap, ProgressBar, Sparkline } from './charts';

/**
 * The picture of a period, for leadership: the headline numbers with how they moved against the
 * period before, what the team did day by day and by channel, where the funnel narrows, which
 * campaigns are running and how far along they are, and who did what. Rendered on the Reports page
 * and, unchanged, into the exported HTML file. No client code, so it prints.
 */
export type RunningCampaign = { id: string; name: string; podName: string; startDate: string; endDate: string | null; day: number; total: number | null; touchesDone: number; touchesPlanned: number; replied: number; meetings: number };

export type ReportDocumentProps = {
  reports: Reports;
  previous: Reports | null;
  range: { from: string; to: string };
  scope: string;
  campaigns: RunningCampaign[];
  generatedBy?: string | null;
  generatedAt?: Date | null;
};

function Tile({ label, value, previous, series, invert }: { label: string; value: number; previous: number | null; series: number[]; invert?: boolean }) {
  return (
    <div className="surface flex items-start justify-between gap-4 px-5 py-5">
      <div className="min-w-0">
        <div className="text-[11px] font-medium text-ink-500">{label}</div>
        <div className={`mt-2 text-[30px] font-semibold leading-tight tracking-[-0.04em] tabular-nums ${value === 0 ? 'text-ink-400' : 'text-ink-900'}`}>{value.toLocaleString('en-US')}</div>
        {previous !== null ? <div className="mt-1"><Delta current={value} previous={previous} invert={invert} /></div> : null}
      </div>
      <Sparkline values={series} label={`${label}, day by day`} />
    </div>
  );
}

export function ReportDocument({ reports, previous, range, scope, campaigns, generatedBy, generatedAt }: ReportDocumentProps) {
  const r = reports;
  const p = previous;
  const funnel = [
    { label: 'Enrolled', value: r.funnel.enrolled },
    { label: 'Touched', value: r.funnel.touched },
    { label: 'Replied', value: r.funnel.replied },
    { label: 'Meeting', value: r.funnel.meeting },
  ];
  const leaderboard = r.activity.slice(0, 12).map((row) => ({ label: row.name, value: row.period.total, hint: `${row.name}: ${row.period.total} touches · ${row.period.replies} replies · ${row.period.meetings} meetings` }));
  const channelRows = r.activity.slice(0, 12).map((row) => ({ label: row.name, EMAIL: row.period.emails, CALL: row.period.calls, LINKEDIN: row.period.linkedin }));
  const pods = r.byPod.filter((x) => x.enrolled || x.replied || x.meeting || x.tasksDone);
  const days = r.daily.length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3 text-[12.5px] text-ink-600">
        <span><span className="font-medium text-ink-900">{formatLocalDate(range.from, 'long')}</span> → <span className="font-medium text-ink-900">{formatLocalDate(range.to, 'long')}</span> · {days} days · {scope}</span>
        {generatedAt ? <span>Generated {generatedAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}{generatedBy ? ` by ${generatedBy}` : ''}</span> : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="New enrollments" value={r.totals.enrollments} previous={p?.totals.enrollments ?? null} series={r.daily.map((d) => d.enrollments)} />
        <Tile label="Touches completed" value={r.totals.tasksDone} previous={p?.totals.tasksDone ?? null} series={r.daily.map((d) => d.tasksDone)} />
        <Tile label="Replies" value={r.totals.replied} previous={p?.totals.replied ?? null} series={r.daily.map((d) => d.replies)} />
        <Tile label="Meetings" value={r.totals.meeting} previous={p?.totals.meeting ?? null} series={r.daily.map((d) => d.meetings)} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Figure title="From enrolled to meeting" aside={r.funnel.enrolled ? `${Math.round((r.funnel.meeting / r.funnel.enrolled) * 100)}% end in a meeting` : undefined}>
          <Funnel stages={funnel} />
        </Figure>
        <Figure title="Touches by channel">
          {channelRows.length ? <ChannelBars rows={channelRows} /> : <p className="text-[12.5px] text-ink-400">No touches in this period</p>}
        </Figure>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Figure title="Leaderboard" aside="touches completed">
          {leaderboard.length ? <Bars rows={leaderboard} /> : <p className="text-[12.5px] text-ink-400">Nobody completed a touch in this period</p>}
        </Figure>
        <Figure title="When the work happens" aside="touches by weekday">
          {r.heat.length ? <Heatmap rows={r.heat.filter((h) => h.cells.some((c) => c > 0)).slice(0, 12)} /> : <p className="text-[12.5px] text-ink-400">No touches in this period</p>}
        </Figure>
      </div>

      {campaigns.length ? (
        <Figure title="Campaigns running" aside={`${campaigns.length} active`}>
          <div className="space-y-3">
            {campaigns.map((c) => (
              <div key={c.id} className="grid gap-2 text-[12.5px] md:grid-cols-[minmax(0,14rem)_1fr_minmax(0,12rem)] md:items-center md:gap-4">
                <div className="min-w-0"><div className="truncate font-medium text-ink-900">{c.name}</div><div className="truncate text-[12px] text-ink-500">{c.podName}</div></div>
                <div>
                  <div className="flex justify-between text-[12px] text-ink-600"><span>{c.total ? <>Day <span className="tabular-nums">{Math.min(c.day, c.total)}</span> of {c.total}</> : `Since ${formatLocalDate(c.startDate)}`}</span><span className="tabular-nums">{c.touchesDone.toLocaleString('en-US')} of {c.touchesPlanned.toLocaleString('en-US')} touches</span></div>
                  {c.total ? <div className="mt-1.5"><ProgressBar value={c.day} total={c.total} over={c.day > c.total} /></div> : null}
                </div>
                <div className="tabular-nums text-ink-700 md:text-right"><span className="text-ink-900">{c.replied}</span> replied · <span className="text-ink-900">{c.meetings}</span> meetings</div>
              </div>
            ))}
          </div>
        </Figure>
      ) : null}

      <Figure title="By pod" aside="this period against the one before">
        <GroupCompare rows={pods} previous={p?.byPod ?? []} first="Pod" />
      </Figure>
    </div>
  );
}

/** The roll-up table with the previous period beside each figure. */
export function GroupCompare({ rows, previous, first }: { rows: GroupRow[]; previous: GroupRow[]; first: string }) {
  const prev = new Map(previous.map((r) => [r.key, r]));
  if (!rows.length) return <p className="text-[12.5px] text-ink-400">No results in this period</p>;
  const cell = (key: string, value: number, before: number | undefined) => (
    <td key={key} className="num"><span className="tabular-nums">{value.toLocaleString('en-US')}</span>{before !== undefined ? <span className="ml-2 inline-block"><Delta current={value} previous={before} /></span> : null}</td>
  );
  return (
    <div className="overflow-x-auto">
      <table className="table table-dense">
        <thead><tr><th>{first}</th><th className="num">Enrolled</th><th className="num">Touches</th><th className="num">Replies</th><th className="num">Meetings</th><th className="num">Reply rate</th><th className="num">Meeting rate</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const b = prev.get(r.key);
            return (
              <tr key={r.key}>
                <td className="text-[13px] text-ink-900">{r.label}</td>
                {cell('e', r.enrolled, b?.enrolled)}
                {cell('t', r.tasksDone, b?.tasksDone)}
                {cell('r', r.replied, b?.replied)}
                {cell('m', r.meeting, b?.meeting)}
                <td className="num tabular-nums">{Math.round(r.replyRate * 100)}%{b ? <span className="ml-2 text-[12px] text-ink-500">was {Math.round(b.replyRate * 100)}%</span> : null}</td>
                <td className="num tabular-nums">{Math.round(r.meetingRate * 100)}%{b ? <span className="ml-2 text-[12px] text-ink-500">was {Math.round(b.meetingRate * 100)}%</span> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
