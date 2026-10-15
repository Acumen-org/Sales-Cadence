/**
 * The report's charts: inline SVG and plain elements, no client code, so the same components
 * render on the Reports page and inside the exported HTML file. Their classes (rp-*) are defined
 * once in report-export-styles.ts for both.
 *
 * Colour follows the entity, never its rank: each channel and each product keeps one hue
 * everywhere (validated as a set for colour-blind readers), every mark carries a native tooltip,
 * and each chart sits beside a legend with its numbers, so nothing is read from colour alone.
 */
import type { ReactNode } from 'react';
import { barColour } from '@/lib/bar-colour';
import { NO_PRODUCT, SEVERAL_PRODUCTS, type Channel } from '@/lib/report-keys';
import { IconArrowDown, IconArrowUp } from '@/components/icons';
import type { SeriesBucket, Slice } from '@/lib/reports-query';

const GRID = '#e3e8e2';
const AXIS_TEXT = '#6b7a74';

export const CHANNEL_COLOURS: Record<Channel, string> = { EMAIL: '#4a3aa7', CALL: '#008300', LINKEDIN: '#e87ba4' };
const PRODUCT_COLOURS: Record<string, string> = { PHH: '#2a78d6', ACUBOOTH: '#eb6834', GLYNAC: '#1baf7a', TOLLBOOTH: '#eda100', [SEVERAL_PRODUCTS]: '#6b7a74', [NO_PRODUCT]: '#c4cbc6' };
export const productColour = (key: string) => PRODUCT_COLOURS[key] ?? '#98a59f';

const fmt = (n: number) => n.toLocaleString('en-US');
/** A share: one decimal under 10%, whole numbers above. */
export const pct = (fraction: number) => { const v = fraction * 100; return `${v > 0 && v < 10 ? v.toFixed(1) : Math.round(v)}%`; };

export function Sparkline({ values, colour = '#24735e', width = 120, height = 36, label }: { values: number[]; colour?: string; width?: number; height?: number; label: string }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const n = values.length - 1;
  const pts = values.map((v, i) => [2 + (i / n) * (width - 4), height - 3 - (v / max) * (height - 8)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height - 2} L${pts[0][0].toFixed(1)},${height - 2} Z`;
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="rp-spark">
      <title>{label}</title>
      <path d={area} fill={colour} opacity={0.12} />
      <path d={line} fill="none" stroke={colour} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={4} fill={colour} stroke="#fff" strokeWidth={2} />
    </svg>
  );
}

/** The change from the period before: a count, or for a rate the change in points. */
export function Delta({ current, previous, invert = false, rate = false }: { current: number; previous: number; invert?: boolean; rate?: boolean }) {
  if (!previous && !current) return <span className="rp-delta rp-flat">no change</span>;
  const diff = current - previous;
  const good = invert ? diff <= 0 : diff >= 0;
  const tone = Math.abs(diff) < (rate ? 0.0005 : 1) ? 'rp-flat' : good ? 'rp-up' : 'rp-down';
  const text = rate
    ? `${diff > 0 ? '+' : ''}${(diff * 100).toFixed(1)} pts`
    : `${diff > 0 ? '+' : ''}${fmt(diff)}${previous ? ` (${diff > 0 ? '+' : ''}${Math.round((diff / previous) * 100)}%)` : ''}`;
  return (
    <span className={`rp-delta ${tone}`} title={`Period before: ${rate ? pct(previous) : fmt(previous)}`}>
      {tone === 'rp-flat' ? null : diff > 0 ? <IconArrowUp size={12} aria-hidden /> : <IconArrowDown size={12} aria-hidden />}
      {tone === 'rp-flat' ? 'same' : text}
    </span>
  );
}

/** A round axis maximum: 1, 2 or 5 times a power of ten, at or above the largest value. */
function niceMax(value: number): number {
  if (value <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(value));
  // Steps of a quarter: the maximum must divide by 4 into whole numbers.
  for (const m of [1, 2, 4, 8, 10]) if (m * p >= value && Number.isInteger((m * p) / 4)) return m * p;
  return Math.ceil(value / 4) * 4;
}

/** A bar with its top corners rounded and its base square on the axis. */
function topRounded(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

/**
 * Outreach over time, one column per day or week, stacked by channel. The top segment carries the
 * rounded end; segments are parted by a 2px surface gap; each column has one tooltip with its parts.
 */
export function ColumnChart({ buckets, unit }: { buckets: SeriesBucket[]; unit: 'day' | 'week' | 'month' }) {
  const W = 640, H = 220, left = 34, right = 6, top = 10, bottom = 26;
  const plotW = W - left - right, plotH = H - top - bottom;
  const max = niceMax(Math.max(0, ...buckets.map((b) => b.sent)));
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const slot = plotW / Math.max(1, buckets.length);
  const barW = Math.max(3, Math.min(34, slot * 0.62));
  const every = Math.max(1, Math.ceil(buckets.length / 8));
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const series: { key: Channel; label: string; value: (b: SeriesBucket) => number }[] = [
    { key: 'EMAIL', label: 'Email', value: (b) => b.emails },
    { key: 'CALL', label: 'Calls', value: (b) => b.calls },
    { key: 'LINKEDIN', label: 'LinkedIn', value: (b) => b.linkedin },
  ];
  const when = (b: SeriesBucket) => (unit === 'day' || b.from === b.to ? b.label : unit === 'week' ? `Week of ${b.label}` : b.label);
  return (
    <div>
      <div className="rp-legend">{series.map((s) => <span key={s.key} className="rp-key"><span className="rp-swatch" style={{ background: CHANNEL_COLOURS[s.key] }} />{s.label}</span>)}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="rp-svg" role="img" aria-label={`Outreach sent per ${unit}, by channel`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={W - right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={left - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill={AXIS_TEXT}>{fmt(Math.round(t))}</text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const cx = left + slot * i + slot / 2;
          const x = cx - barW / 2;
          const parts = series.map((s) => ({ ...s, v: s.value(b) })).filter((s) => s.v > 0);
          let base = top + plotH;
          return (
            <g key={b.from} className="rp-col">
              <title>{`${when(b)}: ${fmt(b.sent)} sent${parts.length ? ` (${parts.map((p) => `${p.label} ${fmt(p.v)}`).join(', ')})` : ''}`}</title>
              <rect x={left + slot * i} y={top} width={slot} height={plotH} fill="transparent" />
              {parts.map((p, k) => {
                const h = (p.v / max) * plotH;
                const gap = k < parts.length - 1 && h > 3 ? 2 : 0;
                const yTop = base - h;
                const shape = k === parts.length - 1
                  ? <path key={p.key} d={topRounded(x, yTop, barW, Math.max(1, h), 4)} fill={CHANNEL_COLOURS[p.key]} />
                  : <rect key={p.key} x={x} y={yTop + gap} width={barW} height={Math.max(0.5, h - gap)} fill={CHANNEL_COLOURS[p.key]} />;
                base = yTop;
                return shape;
              })}
              {i % every === 0 ? <text x={cx} y={H - 8} textAnchor="middle" fontSize={10} fill={AXIS_TEXT}>{b.label}</text> : null}
            </g>
          );
        })}
        <line x1={left} x2={W - right} y1={top + plotH} y2={top + plotH} stroke="#c9d1cb" strokeWidth={1} />
      </svg>
    </div>
  );
}

/** Part of a whole as a ring, with each part, its count and its share listed beside it. */
export function Donut({ slices, colour, total, centre }: { slices: Slice[]; colour: (key: string) => string; total?: number; centre: string }) {
  const sum = total ?? slices.reduce((n, s) => n + s.value, 0);
  const shown = slices.filter((s) => s.value > 0);
  if (!sum) return <p className="rp-empty">Nothing in this period</p>;
  const R = 62, r = 42, C = 74;
  let angle = -Math.PI / 2;
  const arc = (from: number, to: number) => {
    const large = to - from > Math.PI ? 1 : 0;
    const p = (a: number, rad: number) => `${(C + rad * Math.cos(a)).toFixed(2)},${(C + rad * Math.sin(a)).toFixed(2)}`;
    return `M${p(from, R)} A${R},${R} 0 ${large} 1 ${p(to, R)} L${p(to, r)} A${r},${r} 0 ${large} 0 ${p(from, r)} Z`;
  };
  return (
    <div className="rp-donut">
      <svg viewBox="0 0 148 148" width={148} height={148} role="img" aria-label={shown.map((s) => `${s.label} ${fmt(s.value)}`).join(', ')}>
        {shown.length === 1
          ? <g><title>{`${shown[0].label}: ${fmt(shown[0].value)} (100%)`}</title><circle cx={C} cy={C} r={(R + r) / 2} fill="none" stroke={colour(shown[0].key)} strokeWidth={R - r} /></g>
          : shown.map((s) => {
            const sweep = (s.value / sum) * Math.PI * 2;
            const from = angle, to = angle + sweep;
            angle = to;
            return <path key={s.key} d={arc(from, Math.max(from + 0.001, to))} fill={colour(s.key)} stroke="#fff" strokeWidth={2}><title>{`${s.label}: ${fmt(s.value)} (${pct(s.value / sum)})`}</title></path>;
          })}
        <text x={C} y={C + 2} textAnchor="middle" fontSize={22} fontWeight={600} fill="#1f2a26">{fmt(sum)}</text>
        <text x={C} y={C + 19} textAnchor="middle" fontSize={10.5} fill={AXIS_TEXT}>{centre}</text>
      </svg>
      <div className="rp-slices">
        {slices.map((s) => (
          <div key={s.key} className="rp-slice">
            <span className="rp-key"><span className="rp-swatch" style={{ background: colour(s.key) }} />{s.label}</span>
            <span className="rp-num">{fmt(s.value)}</span>
            <span className="rp-num rp-muted">{pct(sum ? s.value / sum : 0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A value with a bar scaled to the largest in its column, in the row's own colour. */
export function InlineBar({ value, max, colour, label }: { value: number; max: number; colour: string; label: string }) {
  const w = max ? Math.max(value ? 2 : 0, Math.round((value / max) * 100)) : 0;
  return (
    <span className="rp-bar" title={`${label}: ${fmt(value)}`}>
      <span className="rp-track"><span className="rp-fill" style={{ width: `${w}%`, background: colour }} /></span>
      <span className="rp-bar-value">{fmt(value)}</span>
    </span>
  );
}

/** A day-of-window bar for a running campaign. */
export function ProgressBar({ value, total, over = false }: { value: number; total: number; over?: boolean }) {
  const p = total ? Math.min(100, Math.round((Math.min(value, total) / total) * 100)) : 0;
  return <div className="rp-progress"><div className="rp-progress-fill" style={{ width: `${p}%`, background: over ? '#c98500' : barColour(p / 100) }} /></div>;
}

export function Figure({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <figure className="rp-card rp-figure">
      <figcaption className="rp-caption"><span className="rp-title">{title}</span>{aside ? <span className="rp-aside">{aside}</span> : null}</figcaption>
      {children}
    </figure>
  );
}
