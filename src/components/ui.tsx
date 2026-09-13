import Link from 'next/link';
import { formatLocalDate, type LocalDate } from '@/lib/dates';
import clsx from 'clsx';
import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { optionLabel, optionLabels } from '@/lib/twenty/labels';

/* -------------------------------------------------------------------------- */
/* Page chrome                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Sub-page heading. The section name lives in the top bar, so this is the smaller
 * second-level title used by creation and detail screens.
 */
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-6 pb-1 pt-2">
      <div className="min-w-0">
        <h2 className="text-[22px] font-semibold tracking-[-0.03em] text-ink-900">{title}</h2>
        {subtitle ? <div className="mt-1 text-[14px] text-ink-600">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * The white rounded surface the page content sits on (the canvas shows through around it).
 * `flush` removes the inner padding for tables that draw their own rows.
 */
export function Surface({ children, className, flush }: { children: ReactNode; className?: string; flush?: boolean }) {
  return <section className={clsx('surface overflow-hidden', !flush && 'p-4', className)}>{children}</section>;
}

/** Header inside a surface: bold view name (optionally with a caret) and a right-hand meta slot. */
export function ViewHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; caret?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-5">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.015em] text-ink-900">
        {title}
      </h2>
      <div className="flex items-center gap-3">
        {meta ? <DataValue>{meta}</DataValue> : null}
        {actions}
      </div>
    </div>
  );
}

/** Filter/toolbar strip under a view header. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('flex flex-wrap items-center gap-2 px-4 pb-3', className)}>{children}</div>;
}

export function Card({ children, className, title, actions, flush }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; flush?: boolean }) {
  return (
    <section className={clsx('surface overflow-hidden', className)}>
      {title || actions ? (
        <header className="card-head">
          <h2 className="card-title">{title}</h2>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      {flush ? children : children}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Badges, dots, avatars                                                      */
/* -------------------------------------------------------------------------- */

const BADGE_TONES = {
  gray: 'border-ink-200/70 bg-[#f8faf9] text-ink-600',
  blue: 'border-brand-200/60 bg-brand-50 text-brand-800',
  green: 'border-emerald-200/60 bg-emerald-50 text-emerald-800',
  amber: 'border-amber-200/70 bg-amber-50 text-amber-800',
  red: 'border-red-200/70 bg-red-50 text-red-700',
  purple: 'border-violet-200/60 bg-violet-50 text-violet-700',
  sky: 'border-sky-200/60 bg-sky-50 text-sky-800',
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({ children, tone = 'gray', className, dot }: { children: ReactNode; tone?: BadgeTone; className?: string; dot?: boolean }) {
  return (
    <span title={typeof children === 'string' ? children : undefined} className={clsx('badge', BADGE_TONES[tone], className)}>
      {dot ? <span className={clsx('dot', DOT_TONES[tone])} /> : null}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

const DOT_TONES: Record<BadgeTone, string> = {
  gray: 'bg-ink-300',
  blue: 'bg-brand-500',
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  purple: 'bg-violet-500',
  sky: 'bg-sky-500',
};

/** Coloured dot + label, the way Outreach shows "17 Active". */
export function StatusDot({ tone = 'green', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-[13.5px] text-ink-700">
      <span className={clsx('dot', DOT_TONES[tone])} />
      {children}
    </span>
  );
}

const AVATAR_TONES = [
  'bg-brand-100 text-brand-800',
  'bg-emerald-100 text-emerald-800',
  'bg-amber-100 text-amber-800',
  'bg-sky-100 text-sky-800',
  'bg-violet-100 text-violet-800',
  'bg-rose-100 text-rose-800',
  'bg-teal-100 text-teal-800',
];

function toneFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 1000;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

export function initialsOf(name: string): string {
  // Only word characters count, so "Company B - discovery (scheduled)" reads CD, not "C(".
  const parts = name
    .trim()
    .split(/[\s.,/\\|_-]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Initials avatar: rounded square for companies (like a logo tile), circle for people. */
export function Avatar({ name, size = 32, shape = 'square', className }: { name: string; size?: number; shape?: 'square' | 'circle'; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx('inline-flex shrink-0 items-center justify-center font-medium', shape === 'circle' ? 'rounded-full' : 'rounded-[8px]', toneFor(name), className)}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.36)) }}
    >
      {initialsOf(name)}
    </span>
  );
}

/** Two-line cell: avatar, primary name (optionally a link), and a muted second line. */
export function IdentityCell({ name, sub, href, shape = 'square', size = 32 }: { name: string; sub?: ReactNode; href?: string; shape?: 'square' | 'circle'; size?: number }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={name} shape={shape} size={size} />
      <div className="min-w-0">
        {href ? (
          <Link href={href} title={name} className="block max-w-[22rem] truncate text-[13px] font-semibold leading-5 text-ink-900 hover:text-brand-700">
            {name}
          </Link>
        ) : (
          <div title={name} className="max-w-[22rem] truncate text-[13px] font-semibold leading-5 text-ink-900">{name}</div>
        )}
        {sub ? <div title={typeof sub === 'string' ? sub : undefined} className="mt-0.5 max-w-[22rem] truncate text-[12px] leading-5 text-ink-500">{sub}</div> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Activity dot timeline                                                      */
/* -------------------------------------------------------------------------- */

export type TimelinePoint = { at: number; lane: 'out' | 'in' };

/**
 * The dot timeline Outreach shows in list views: a hairline with outbound touches above it and
 * inbound replies below, positioned by time across the window.
 */
/**
 * `now` comes from whoever renders the list, once, on the server: computed here on each side, the
 * client's later clock moved the window and a touch at its edge appeared on one side only, which
 * is a hydration mismatch. Positions are whole pixels for the same reason.
 */
export function DotTimeline({ points, now, width = 210, days = 30 }: { points: TimelinePoint[]; now: number; width?: number; days?: number }) {
  const span = days * 86_400_000;
  const from = now - span;
  const visible = points.filter((p) => p.at >= from);
  const x = (at: number) => Math.max(2, Math.min(width - 2, ((at - from) / span) * width));
  return (
    <div className="relative" style={{ width, height: 26 }} aria-hidden>
      <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-line" />
      {visible.map((p, i) => (
        <span
          key={i}
          className={clsx('absolute h-[7px] w-[7px] rounded-full', p.lane === 'out' ? 'bg-brand-500' : 'bg-emerald-500')}
          style={{ left: Math.round(x(p.at) - 3.5), top: p.lane === 'out' ? 4 : 15 }}
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Status tones shared across pages                                           */
/* -------------------------------------------------------------------------- */

export const ENROLLMENT_TONE: Record<string, BadgeTone> = {
  ACTIVE: 'blue',
  PAUSED: 'amber',
  REPLIED: 'green',
  MEETING: 'purple',
  COMPLETED: 'gray',
  EXITED: 'red',
};

export const TASK_TONE: Record<string, BadgeTone> = {
  PENDING: 'blue',
  DONE: 'green',
  SKIPPED: 'amber',
  CANCELLED: 'gray',
};

export const CAMPAIGN_TONE: Record<string, BadgeTone> = {
  DRAFT: 'gray',
  ACTIVE: 'blue',
  PAUSED: 'amber',
  STOPPED: 'red',
  COMPLETED: 'green',
};

/** Outreach-style wording for an enrollment's state. */
export function enrollmentStatusLabel(e: { status: string; exitReason?: string | null }): string {
  switch (e.status) {
    case 'ACTIVE':
      return 'Active';
    case 'PAUSED':
      return 'Paused';
    case 'REPLIED':
      return 'Finished (Replied)';
    case 'MEETING':
      return 'Meeting booked';
    case 'COMPLETED':
      return 'Finished (No reply)';
    case 'EXITED': {
      const r = e.exitReason ?? '';
      if (r === 'bounced') return 'Bounced';
      if (r === 'opted_out') return 'Opted out';
      if (r === 'dnd') return 'Do not contact';
      if (r === 'not_interested') return 'Not interested';
      if (r === 'bad_data') return 'Bad data';
      if (r === 'person_deleted') return 'Deleted in Twenty';
      if (r.startsWith('campaign_')) return 'Campaign stopped';
      return 'Removed';
    }
    default:
      return e.status.charAt(0) + e.status.slice(1).toLowerCase();
  }
}

/** How Twenty classifies the person: its own funnel stage, then contact type, then the list. */
const STAGE_TONE: Record<string, BadgeTone> = { PROSPECT: 'blue', QUALIFY: 'sky', RETAIN: 'green' };
const TYPE_TONE: Record<string, BadgeTone> = { PROSPECT: 'blue', CLIENTS: 'green', CLIENT_S_CLIENT: 'green', PARTNER: 'purple', ORGANIZATION: 'gray' };

/**
 * What the CRM says this person is. Every value here comes from Twenty, so the label an FO
 * reads in Cadence is the label they would read in the CRM. Cadence's own view of the person
 * (which step of which sequence) is a separate column, because it answers a different question.
 */
export function crmStanding(p: {
  dnd: boolean;
  optedOut: boolean;
  pipelineStage: string | null;
  contactType: string[];
  listCategory: string | null;
}): { label: string; tone: BadgeTone } {
  if (p.dnd || p.optedOut) return { label: 'Do not contact', tone: 'red' };
  if (p.pipelineStage) return { label: optionLabel(p.pipelineStage), tone: STAGE_TONE[p.pipelineStage] ?? 'blue' };
  if (p.contactType.length) return { label: optionLabels(p.contactType, ' / '), tone: TYPE_TONE[p.contactType[0]] ?? 'gray' };
  if (p.listCategory) return { label: optionLabel(p.listCategory), tone: 'gray' };
  return { label: 'Unclassified', tone: 'gray' };
}

/** LEVEL_1 is the best tier, so it gets the strongest colour. */
const TIER_TONE: Record<string, BadgeTone> = { LEVEL_1: 'purple', LEVEL_2: 'sky', LEVEL_3: 'gray', LEVEL_4: 'gray' };

export function TierBadge({ tier }: { tier: string | null }) {
  if (!tier) return <span className="text-[12px] text-ink-300">-</span>;
  return <Badge tone={TIER_TONE[tier] ?? 'gray'}>{optionLabel(tier)}</Badge>;
}

/**
 * Twenty's own note titles lead with a bracketed channel - `[Email] Outbound email: ...`,
 * `[CALL] Outbound Call by tw_alisa` - which is how the workspace's automations write them and
 * how Cadence recognises them. The channel is already carried by the icon beside the row, so the
 * bracket is dropped for display rather than eating the width of a truncated cell.
 */
export function touchTitle(summary: string): string {
  return summary.replace(/^\[[^\]]{1,24}\]\s*/, '').replace(/\s*\(marked done[^)]*\)\s*$/i, '');
}

/**
 * Data-quality problems worth flagging next to a person, from both sides: the tags Twenty
 * carries and Cadence's own flags from a bounce or a wrong-number call. Consent is deliberately
 * absent - `crmStanding` already leads with "Do not contact", and saying it twice reads as noise.
 */
export function contactWarnings(p: {
  badEmail: boolean;
  badPhone: boolean;
  emailMissing: boolean;
  phoneMissing: boolean;
  rotatedTo: string | null;
  email?: string | null;
  phone?: string | null;
}): { label: string; tone: BadgeTone }[] {
  const out: { label: string; tone: BadgeTone }[] = [];
  // A bounce and a blank are different problems: one needs a new address found, the other needs
  // the address we have replaced. Saying "missing" for both sends the FO looking for the wrong thing.
  // Twenty's "missing" flag can outlive the value being filled in; beside a visible address the
  // honest word is "needs verification", the same one Enrichment uses.
  if (p.badEmail) out.push({ label: 'Email bounced', tone: 'amber' });
  else if (p.emailMissing) out.push({ label: p.email ? 'Email needs verification' : 'Email missing', tone: 'amber' });
  if (p.badPhone) out.push({ label: 'Wrong number', tone: 'amber' });
  else if (p.phoneMissing) out.push({ label: p.phone ? 'Phone needs verification' : 'Phone missing', tone: 'amber' });
  if (p.rotatedTo) out.push({ label: optionLabel(p.rotatedTo), tone: 'gray' });
  return out;
}

/* -------------------------------------------------------------------------- */
/* States, tabs, stats, forms                                                 */
/* -------------------------------------------------------------------------- */

export function EmptyState({ title, hint, action, icon }: { title: string; hint?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      {icon ? <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-brand-500">{icon}</div> : null}
      <h3 className="text-[14px] font-semibold text-ink-900">{title}</h3>
      {hint ? <div className="max-w-md text-[13px] text-ink-500">{hint}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Underline tabs. `inset` adds the page gutter; inside a surface pass inset={false}. */
export function Tabs({ tabs, current, inset = true }: { tabs: { key: string; label: ReactNode; href: string; count?: number }[]; current: string; inset?: boolean }) {
  return (
    <div className={clsx('flex gap-3 overflow-x-auto border-b border-line scroll-thin sm:gap-5', inset ? 'px-4 sm:px-6' : 'px-3 sm:px-5')}>
      {tabs.map((t) => {
        const active = t.key === current;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={clsx(
              'flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 py-3 text-[13px] font-medium transition-colors',
              active ? 'border-brand-600 text-ink-900' : 'border-transparent text-ink-500 hover:text-ink-700',
            )}
          >
            {t.label}
            {typeof t.count === 'number' ? (
              <span className={clsx('rounded-full px-1.5 text-[12px] font-medium tabular-nums leading-5 sm:px-2', active ? 'bg-brand-100 text-brand-800' : 'bg-canvas text-ink-900')}>{t.count}</span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}

export function Stat({ label, value, hint, tone, icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'warn' | 'good'; icon?: ReactNode }) {
  return (
    <div className="surface flex items-start gap-3 px-5 py-5">
      {icon ? <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand-50 text-brand-600">{icon}</span> : null}
      <div className="min-w-0">
        <div className="text-[11px] font-medium text-ink-500">{label}</div>
        {/* A colour is a signal, so zero never gets one: a green 0 replies reads as a good result. */}
        <div className={clsx('mt-3 text-[30px] font-semibold leading-tight tracking-[-0.04em] tabular-nums', value === 0 || value === '0' || value === '0%' ? 'text-ink-400' : tone === 'warn' ? 'text-amber-700' : tone === 'good' ? 'text-brand-700' : 'text-ink-900')}>{value}</div>
        {hint ? <div className="text-[12px] text-ink-500">{hint}</div> : null}
      </div>
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: ReactNode }) {
  const cls = {
    info: 'bg-brand-50 text-brand-800 border-brand-100',
    warn: 'bg-amber-50 text-amber-800 border-amber-200',
    error: 'bg-red-50 text-red-800 border-red-200',
    success: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  }[tone];
  return <div className={clsx('rounded-xl border px-3.5 py-2.5 text-[13px]', cls)}>{children}</div>;
}

const FORM_CONTROLS = new Set(['input', 'select', 'textarea']);

/**
 * Label + control. A single input/select/textarea child gets an id (unless it has one) and the
 * label points at it with htmlFor, so click-to-focus, screen readers and accessible queries work.
 */
export function Field({ label, children, hint, info, className }: { label: ReactNode; children: ReactNode; hint?: ReactNode; info?: string; className?: string }) {
  const autoId = useId();
  const single = isValidElement(children) && typeof children.type === 'string' && FORM_CONTROLS.has(children.type);
  const existingId = single ? (children as ReactElement<{ id?: string }>).props.id : undefined;
  const controlId = single ? existingId ?? autoId : undefined;
  const hintId = `${autoId}-hint`;
  const control = single ? cloneElement(children as ReactElement<{ id?: string; 'aria-describedby'?: string }>, { id: controlId, 'aria-describedby': [(children as ReactElement<{ 'aria-describedby'?: string }>).props['aria-describedby'], hint ? hintId : undefined].filter(Boolean).join(' ') || undefined }) : children;
  return (
    <div className={clsx('space-y-1.5', className)}>
      <div className="flex items-center">
        <label htmlFor={controlId} className="block">
          {label}
        </label>
        {info ? <Info text={info} /> : null}
      </div>
      {control}
      {hint ? <p id={hintId} className="text-[11.5px] leading-relaxed text-ink-500">{hint}</p> : null}
    </div>
  );
}

/** An absent value. The same quiet dash wherever a field, cell or list has nothing to show. */
export function Empty({ children = '-' }: { children?: ReactNode }) {
  return <span className="text-ink-300">{children}</span>;
}

/** Counts remain legible and visibly dynamic, including zero. */
export function Count({ value, className }: { value: number; className?: string }) {
  return <span className={clsx('font-semibold tabular-nums text-ink-900', className)}>{value}</span>;
}

/** The explanation behind a field label, shown on hover instead of as a sentence under the control. */
export function Info({ text }: { text: string }) {
  return (
    <span title={text} aria-label={text} className="ml-1.5 inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-line align-[-2px] text-[10px] leading-none text-ink-400">
      ?
    </span>
  );
}

export function KeyValue({ items }: { items: { k: string; v: ReactNode }[] }) {
  return (
    <dl className="kv grid grid-cols-[minmax(0,8.5rem)_1fr] gap-x-4 gap-y-2">
      {items.map((it) => (
        <div key={it.k} className="contents">
          <dt className="pt-0.5">{it.k}</dt>
          <dd className="min-w-0 break-words">{it.v == null || it.v === '' ? <Empty /> : displayValue(it.v)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Record data is visually distinct from the muted, static labels around it. */
export function DataValue({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx('data-value', className)}>{children}</span>;
}

/** Compact labelled fields for live record metadata, without sentence-like subtitles. */
/**
 * One display format for dates, applied where records are rendered rather than at every call site.
 *
 * A `YYYY-MM-DD` string is Cadence's stored calendar date (`LocalDate`) and never anything else, so
 * a field whose value is exactly that shape is shown the way every other date in the app is shown.
 * The stored form still goes into date inputs and URLs, which is where it belongs.
 */
/**
 * The secondary values under a timeline event. An event carries several facts - a start date, who
 * assigned it, how many open touches it closed - and joining them into one grey line was the
 * run-on subtext the whole app has been getting rid of. Each is a label and a value.
 */
export function EventDetail({ fields, className }: { fields: { label: string; value: string }[]; className?: string }) {
  if (!fields.length) return null;
  return (
    <span className={clsx('flex flex-wrap items-center gap-x-4 gap-y-1', className)}>
      {fields.map((f) => (
        <span key={f.label} className="inline-flex items-baseline gap-1.5 rounded bg-canvas/70 px-1.5 py-0.5 text-[11.5px] text-ink-500">
          {f.label}
          <span className="font-medium text-ink-900">{f.value}</span>
        </span>
      ))}
    </span>
  );
}

export function displayValue(value: ReactNode): ReactNode {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatLocalDate(value as LocalDate, 'long') : value;
}

export function RecordFields({ items, className }: { items: { label: string; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={clsx('grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3', className)}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0 space-y-1.5">
          <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{item.label}</dt>
          <dd className="break-words text-[14px] font-medium text-ink-900">{item.value == null || item.value === '' ? <Empty /> : displayValue(item.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Pill({ children }: { children: ReactNode }) {
  return <span className="rounded bg-canvas px-2 py-1 text-[12px] font-medium text-ink-800">{children}</span>;
}

/**
 * Detail-page header: avatar, record name, badges and actions on a white band.
 * Used where the top bar shows the section and the record needs its own identity.
 */
export function RecordHeader({
  name,
  sub,
  badges,
  actions,
  shape = 'circle',
  icon,
}: {
  name: string;
  sub?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  shape?: 'square' | 'circle';
  /** For records that are not people: an icon rather than their initials. */
  icon?: ReactNode;
}) {
  return (
    <div className="surface flex flex-wrap items-start justify-between gap-4 px-5 py-4">
      <div className="flex min-w-0 items-start gap-3.5">
        {icon ? <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">{icon}</span> : <Avatar name={name} shape={shape} size={44} />}
        <div className="min-w-0">
          <h2 className="truncate text-[20px] font-semibold tracking-[-0.01em] text-ink-900">{name}</h2>
          {sub ? <div className="mt-1 text-[14px] text-ink-600">{sub}</div> : null}
          {badges ? <div className="mt-2 flex flex-wrap items-center gap-1.5">{badges}</div> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Page body wrapper with the standard gutter. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('px-6 pb-8 pt-4', className)}>{children}</div>;
}
