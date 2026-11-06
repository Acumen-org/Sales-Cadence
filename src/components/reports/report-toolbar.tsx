'use client';

import Link, { useLinkStatus } from 'next/link';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { reportsHref, type ReportParams } from '@/lib/report-keys';

/** The chip being opened pulses until the next period has been read. */
function Opening() {
  const { pending } = useLinkStatus();
  return pending ? <span aria-hidden className="pointer-events-none absolute inset-0 animate-pulse rounded-lg bg-brand-100/70" /> : null;
}

export type ReportPreset = { label: string; from: string; to: string; href: string };
export type ReportAudienceChoice = { key: ReportParams['audience']; label: string; href: string };

/** The breakdown tab open right now: it switches in place, so the address is the truth, not the render. */
const openTab = (fallback: string) => (typeof window === 'undefined' ? fallback : new URLSearchParams(window.location.search).get('tab') ?? fallback);

/** A row of chips, one of them current: the period presets, and the audience. */
function Chips({ label, items, current, onPick, stale }: { label: string; items: { key: string; label: string; href: string }[]; current: (key: string) => boolean; onPick: (key: string) => void; /** The server-built links are out of date (a breakdown tab switched in place): navigate from the address instead. */ stale: () => boolean }) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1 rounded-xl border border-line bg-canvas/60 p-1">
      {items.map((p) => {
        const active = current(p.key);
        return (
          <Link
            key={p.key}
            href={p.href}
            prefetch={false}
            aria-current={active ? 'true' : undefined}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || !stale()) return;
              e.preventDefault();
              onPick(p.key);
            }}
            className={clsx('relative rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition', active ? 'bg-white text-ink-900 shadow-sm ring-1 ring-line' : 'text-ink-500 hover:bg-white/70 hover:text-ink-900')}
          >
            {p.label}<Opening />
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The period, who it covers and which outreach (PLAN 6: All outreach · CRM · Cold outreach). A preset
 * or an audience is one click; dates apply together; a pod or FO applies the moment it is picked, and
 * a new pod starts again from all its FOs. Every change keeps the view and the audience (B042). The
 * fields are keyed on what the page shows, so after a preset they show that preset's dates.
 */
export function ReportToolbar({ presets, audiences, params, pods, users, exportHref }: {
  presets: ReportPreset[];
  audiences: ReportAudienceChoice[];
  params: ReportParams;
  pods: { id: string; name: string }[];
  users: { id: string; name: string }[];
  exportHref: string;
}) {
  const router = useRouter();
  const go = (patch: Partial<ReportParams>) => router.push(reportsHref({ ...params, tab: openTab(params.tab) }, patch));
  const { from, to, pod, fo } = params;
  const stale = () => openTab(params.tab) !== params.tab;
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <Chips label="Which outreach" items={audiences} current={(k) => k === params.audience} onPick={(k) => go({ audience: k as ReportParams['audience'] })} stale={stale} />
      <Chips label="Period" items={presets.map((p) => ({ key: p.label, label: p.label, href: p.href }))} current={(k) => { const p = presets.find((x) => x.label === k)!; return from === p.from && to === p.to; }} onPick={(k) => { const p = presets.find((x) => x.label === k)!; go({ from: p.from, to: p.to }); }} stale={stale} />
      <form
        key={`${from}|${to}|${pod}|${fo}`}
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          go({ from: String(data.get('from') ?? from), to: String(data.get('to') ?? to) });
        }}
      >
        <label className="grid gap-1 text-[11.5px] font-medium text-ink-500">From<input type="date" name="from" defaultValue={from} required className="min-w-[140px]" /></label>
        <label className="grid gap-1 text-[11.5px] font-medium text-ink-500">Through<input type="date" name="to" defaultValue={to} required className="min-w-[140px]" /></label>
        <label className="grid gap-1 text-[11.5px] font-medium text-ink-500">Pod<select name="pod" value={pod} onChange={(e) => go({ pod: e.target.value, fo: '' })} className="min-w-[150px]"><option value="">All pods</option>{pods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="grid gap-1 text-[11.5px] font-medium text-ink-500">FO<select name="fo" value={fo} onChange={(e) => go({ fo: e.target.value })} className="min-w-[150px]"><option value="">All FOs</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <button type="submit" className="btn-secondary">Apply</button>
      </form>
      <a href={exportHref} target="_blank" rel="noreferrer" className="btn-secondary ml-auto">Export report</a>
    </div>
  );
}
