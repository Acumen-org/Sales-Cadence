/**
 * The report's charts: inline SVG, no client code, so the same components render on the Reports
 * page and inside the exported HTML file. Built to the data-viz method: one measure, one hue;
 * categories in a fixed order from a validated palette; thin marks with rounded data-ends; a 2px
 * surface gap between fills; values in ink, never in the series colour; a native tooltip on every
 * mark; and a table beside every chart, so nothing is colour-alone.
 */
import type { ReactNode } from 'react';

/** Validated (dataviz validator, light surface): the three channels, in this order, always. */
/** Three steps of the one green ramp (GREEN_RAMP 4, 2, 1): identity comes from the legend and the label, not a second hue. */
export const CHANNEL_COLOURS: Record<'EMAIL' | 'CALL' | 'LINKEDIN', string> = { EMAIL: '#24735e', CALL: '#7fb894', LINKEDIN: '#b9d8c0' };
export const CHANNEL_LABELS: Record<'EMAIL' | 'CALL' | 'LINKEDIN', string> = { EMAIL: 'Email', CALL: 'Calls', LINKEDIN: 'LinkedIn' };
/** One hue, light to dark, for magnitude. */
export const GREEN_RAMP = ['#e3efe3', '#b9d8c0', '#7fb894', '#3f8f66', '#24735e', '#17493d'];
const INK = '#1f2a26';
const INK_MUTED = '#6b7a74';
const GRID = '#e3e8e2';

export function Sparkline({ values, colour = '#24735e', width = 140, height = 36, label }: { values: number[]; colour?: string; width?: number; height?: number; label: string }) {
  const max = Math.max(1, ...values);
  const n = Math.max(1, values.length - 1);
  const pts = values.map((v, i) => [2 + (i / n) * (width - 4), height - 3 - (v / max) * (height - 8)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height - 2} L${pts[0][0].toFixed(1)},${height - 2} Z`;
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="overflow-visible">
      <title>{label}</title>
      <path d={area} fill={colour} opacity={0.12} />
      <path d={line} fill="none" stroke={colour} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={4} fill={colour} stroke="#fff" strokeWidth={2} />
    </svg>
  );
}

export function Delta({ current, previous, invert = false }: { current: number; previous: number; invert?: boolean }) {
  if (!previous && !current) return <span className="text-[12px] text-ink-400">no change</span>;
  const diff = current - previous;
  const pct = previous ? Math.round((diff / previous) * 100) : null;
  const good = invert ? diff <= 0 : diff >= 0;
  return (
    <span className={`inline-flex items-center gap-1 text-[12px] tabular-nums ${diff === 0 ? 'text-ink-400' : good ? 'text-emerald-700' : 'text-amber-700'}`} title={`Previous period: ${previous.toLocaleString('en-US')}`}>
      <span aria-hidden>{diff > 0 ? '▲' : diff < 0 ? '▼' : '•'}</span>
      {diff === 0 ? 'same' : `${diff > 0 ? '+' : ''}${diff.toLocaleString('en-US')}${pct !== null ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''}`}
    </span>
  );
}

/** Horizontal bars for one measure, labelled at the data end; the longest bar spans the width. */
export function Bars({ rows, colour = '#24735e', max, format = (v: number) => v.toLocaleString('en-US') }: { rows: { label: string; value: number; hint?: string }[]; colour?: string; max?: number; format?: (v: number) => string }) {
  const top = Math.max(1, max ?? Math.max(...rows.map((r) => r.value), 0));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_3.5rem] items-center gap-3 text-[12.5px]" title={r.hint ?? `${r.label}: ${format(r.value)}`}>
          <span className="truncate text-ink-800">{r.label}</span>
          <svg height={10} className="w-full min-w-0" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label={`${r.label}: ${format(r.value)}`}>
            <rect x={0} y={0} width={100} height={10} fill={GRID} opacity={0.5} rx={2} />
            {r.value > 0 ? <rect x={0} y={0} width={Math.max(1, (r.value / top) * 100)} height={10} fill={colour} rx={2} /> : null}
          </svg>
          <span className="text-right tabular-nums text-ink-900">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** Stacked bars by channel, in the fixed channel order, with a 2px surface gap between segments and a legend. */
export function ChannelBars({ rows }: { rows: { label: string; EMAIL: number; CALL: number; LINKEDIN: number }[] }) {
  const channels = ['EMAIL', 'CALL', 'LINKEDIN'] as const;
  const top = Math.max(1, ...rows.map((r) => r.EMAIL + r.CALL + r.LINKEDIN));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-4 text-[12px] text-ink-600">{channels.map((c) => <span key={c} className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CHANNEL_COLOURS[c] }} />{CHANNEL_LABELS[c]}</span>)}</div>
      <div className="space-y-2">
        {rows.map((r) => {
          const total = r.EMAIL + r.CALL + r.LINKEDIN;
          let x = 0;
          return (
            <div key={r.label} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_3.5rem] items-center gap-3 text-[12.5px]">
              <span className="truncate text-ink-800">{r.label}</span>
              <svg height={10} className="w-full min-w-0" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label={`${r.label}: ${channels.map((c) => `${CHANNEL_LABELS[c]} ${r[c]}`).join(', ')}`}>
                <rect x={0} y={0} width={100} height={10} fill={GRID} opacity={0.5} rx={2} />
                {channels.map((c) => {
                  const w = (r[c] / top) * 100;
                  const seg = <rect key={c} x={x} y={0} width={Math.max(0, w - (x > 0 ? 0.6 : 0))} height={10} fill={CHANNEL_COLOURS[c]} rx={1.5}><title>{`${r.label} · ${CHANNEL_LABELS[c]}: ${r[c]}`}</title></rect>;
                  x += w;
                  return r[c] > 0 ? seg : null;
                })}
              </svg>
              <span className="text-right tabular-nums text-ink-900">{total.toLocaleString('en-US')}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The funnel as stepped bars of one hue: each stage against the first, with the conversion between them. */
export function Funnel({ stages }: { stages: { label: string; value: number }[] }) {
  const top = Math.max(1, stages[0]?.value ?? 0);
  return (
    <div className="space-y-2.5">
      {stages.map((s, i) => {
        const prev = i ? stages[i - 1].value : null;
        const rate = prev ? Math.round((s.value / prev) * 100) : null;
        return (
          <div key={s.label} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_6rem] items-center gap-3 text-[12.5px]">
            <span className="text-ink-800">{s.label}</span>
            <svg height={14} className="w-full min-w-0" viewBox="0 0 100 14" preserveAspectRatio="none" role="img" aria-label={`${s.label}: ${s.value.toLocaleString('en-US')}`}>
              <rect x={0} y={0} width={100} height={14} fill={GRID} opacity={0.4} rx={3} />
              {s.value > 0 ? <rect x={0} y={0} width={Math.max(1.5, (s.value / top) * 100)} height={14} fill={GREEN_RAMP[Math.min(GREEN_RAMP.length - 1, 2 + i)]} rx={3}><title>{`${s.label}: ${s.value.toLocaleString('en-US')}${rate !== null ? ` · ${rate}% of ${stages[i - 1].label.toLowerCase()}` : ''}`}</title></rect> : null}
            </svg>
            <span className="text-right tabular-nums text-ink-900">{s.value.toLocaleString('en-US')}{rate !== null ? <span className="ml-1 text-[11.5px] text-ink-500">{rate}%</span> : null}</span>
          </div>
        );
      })}
    </div>
  );
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Weekday x FO, one hue light to dark, a 2px gap between cells, the strongest cells labelled. */
export function Heatmap({ rows }: { rows: { name: string; cells: number[] }[] }) {
  const max = Math.max(1, ...rows.flatMap((r) => r.cells));
  // Light fills only, so every count prints in ink on top of them.
  const step = (v: number) => (v === 0 ? GRID : GREEN_RAMP[Math.min(3, 1 + Math.floor((v / max) * 2.999))]);
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <div className="overflow-x-auto">
      <table className="text-[12px]" role="table">
        <thead><tr><th className="pb-1 pr-3 text-left font-medium text-ink-500">FO</th>{order.map((d) => <th key={d} className="pb-1 text-center font-medium text-ink-500" style={{ width: 44 }}>{WEEKDAYS[d]}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="pr-3 text-ink-800 whitespace-nowrap">{r.name}</td>
              {order.map((d) => {
                const v = r.cells[d];
                return <td key={d} className="p-[1px]"><div className="flex h-8 w-10 items-center justify-center rounded-md text-[12px] tabular-nums" style={{ background: step(v), color: INK }} title={`${r.name} · ${WEEKDAYS[d]}: ${v} touches`}>{v > 0 ? v : ''}</div></td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A day-of-window bar for a running campaign. */
export function ProgressBar({ value, total, over = false }: { value: number; total: number; over?: boolean }) {
  const pct = total ? Math.min(100, Math.round((Math.min(value, total) / total) * 100)) : 0;
  return <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: GRID }}><div className="h-full rounded-full" style={{ width: `${pct}%`, background: over ? '#c98500' : '#24735e' }} /></div>;
}

export function Figure({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <figure className="surface min-w-0 p-5">
      <figcaption className="mb-4 flex items-baseline justify-between gap-3"><span className="text-[13px] font-medium text-ink-900">{title}</span>{aside ? <span className="text-[12px]" style={{ color: INK_MUTED }}>{aside}</span> : null}</figcaption>
      {children}
    </figure>
  );
}
