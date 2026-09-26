/**
 * The report's charts: inline SVG, no client code, so the same components render on the Reports
 * page and inside the exported HTML file. Built to the data-viz method: one measure, one hue;
 * categories in a fixed order from a validated palette; thin marks with rounded data-ends; a 2px
 * surface gap between fills; values in ink, never in the series colour; a native tooltip on every
 * mark; and a table beside every chart, so nothing is colour-alone.
 */
import type { ReactNode } from 'react';
import { barColour } from '@/lib/bar-colour';

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
  if (!previous && !current) return <span className="whitespace-nowrap text-[12px] text-ink-400">no change</span>;
  const diff = current - previous;
  const pct = previous ? Math.round((diff / previous) * 100) : null;
  const good = invert ? diff <= 0 : diff >= 0;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap text-[12px] tabular-nums ${diff === 0 ? 'text-ink-400' : good ? 'text-emerald-700' : 'text-amber-700'}`} title={`Previous period: ${previous.toLocaleString('en-US')}`}>
      <span aria-hidden>{diff > 0 ? '▲' : diff < 0 ? '▼' : '•'}</span>
      {diff === 0 ? 'same' : `${diff > 0 ? '+' : ''}${diff.toLocaleString('en-US')}${pct !== null ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''}`}
    </span>
  );
}



/** The funnel as stepped bars of one hue: each stage against the first, with the conversion between them. */
export function Funnel({ stages }: { stages: { label: string; value: number; hint?: string }[] }) {
  const top = Math.max(1, stages[0]?.value ?? 0);
  return (
    <div className="space-y-2.5">
      {stages.map((s, i) => {
        const prev = i ? stages[i - 1].value : null;
        const rate = prev ? Math.round((s.value / prev) * 100) : null;
        return (
          <div key={s.label} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_7.5rem] items-center gap-3 text-[12.5px]">
            <span className="text-ink-800" title={s.hint}>{s.label}</span>
            <svg height={14} className="w-full min-w-0" viewBox="0 0 100 14" preserveAspectRatio="none" role="img" aria-label={`${s.label}: ${s.value.toLocaleString('en-US')}`}>
              <rect x={0} y={0} width={100} height={14} fill={GRID} opacity={0.4} rx={3} />
              {s.value > 0 ? <rect x={0} y={0} width={Math.max(1.5, (s.value / top) * 100)} height={14} fill={barColour(s.value / top)} rx={3}><title>{`${s.label}: ${s.value.toLocaleString('en-US')}${rate !== null ? ` · ${rate}% of ${stages[i - 1].label.toLowerCase()}` : ''}`}</title></rect> : null}
            </svg>
            <span className="text-right tabular-nums text-ink-900">{s.value.toLocaleString('en-US')}{prev !== null ? <span className="ml-1 text-[11.5px] text-ink-500">of {prev.toLocaleString('en-US')}</span> : null}</span>
          </div>
        );
      })}
    </div>
  );
}


/** A day-of-window bar for a running campaign. */
export function ProgressBar({ value, total, over = false }: { value: number; total: number; over?: boolean }) {
  const pct = total ? Math.min(100, Math.round((Math.min(value, total) / total) * 100)) : 0;
  return <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: GRID }}><div className="h-full rounded-full" style={{ width: `${pct}%`, background: over ? '#c98500' : barColour(pct / 100) }} /></div>;
}

export function Figure({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <figure className="surface min-w-0 p-5">
      <figcaption className="mb-4 flex items-baseline justify-between gap-3"><span className="text-[13px] font-medium text-ink-900">{title}</span>{aside ? <span className="text-[12px]" style={{ color: INK_MUTED }}>{aside}</span> : null}</figcaption>
      {children}
    </figure>
  );
}
