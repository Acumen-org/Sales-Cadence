'use client';

import Link, { useLinkStatus } from 'next/link';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';

/** The chip being opened pulses until the next period has been read. */
function Opening() {
  const { pending } = useLinkStatus();
  return pending ? <span aria-hidden className="pointer-events-none absolute inset-0 animate-pulse rounded-lg bg-brand-100/70" /> : null;
}

export type ReportPreset = { label: string; from: string; to: string; href: string };

/** The breakdown tab open right now: it switches in place, so the address is the truth, not the render. */
const openTab = (fallback: string) => (typeof window === 'undefined' ? fallback : new URLSearchParams(window.location.search).get('tab') ?? fallback);

/**
 * The period and who it covers. A preset is one click; dates apply together; a pod or FO applies
 * the moment it is picked, and a new pod starts again from all its FOs. The fields are keyed on
 * what the page shows, so after a preset they show that preset's dates rather than the last ones.
 */
export function ReportToolbar({ presets, range, pod, fo, pods, users, tab, exportHref }: {
  presets: ReportPreset[];
  range: { from: string; to: string };
  pod: string;
  fo: string;
  pods: { id: string; name: string }[];
  users: { id: string; name: string }[];
  tab: string;
  exportHref: string;
}) {
  const router = useRouter();
  const go = (patch: Record<string, string>) => {
    const params = new URLSearchParams({ tab: openTab(tab), from: range.from, to: range.to, pod, fo, ...patch });
    router.push(`/reports?${params.toString()}`);
  };
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <nav aria-label="Period" className="flex flex-wrap gap-1 rounded-xl border border-line bg-canvas/60 p-1">
        {presets.map((p) => {
          const active = range.from === p.from && range.to === p.to;
          return (
            <Link
              key={p.label}
              href={p.href}
              prefetch={false}
              aria-current={active ? 'true' : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || openTab(tab) === tab) return;
                e.preventDefault();
                go({ from: p.from, to: p.to });
              }}
              className={clsx('relative rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition', active ? 'bg-white text-ink-900 shadow-sm ring-1 ring-line' : 'text-ink-500 hover:bg-white/70 hover:text-ink-900')}
            >
              {p.label}<Opening />
            </Link>
          );
        })}
      </nav>
      <form
        key={`${range.from}|${range.to}|${pod}|${fo}`}
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          go({ from: String(data.get('from') ?? range.from), to: String(data.get('to') ?? range.to) });
        }}
      >
        <label className="grid gap-1 text-[11.5px] font-medium text-ink-500">From<input type="date" name="from" defaultValue={range.from} required className="min-w-[140px]" /></label>
        <label className="grid gap-1 text-[11.5px] font-medium text-ink-500">Through<input type="date" name="to" defaultValue={range.to} required className="min-w-[140px]" /></label>
        <label className="grid gap-1 text-[11.5px] font-medium text-ink-500">Pod<select name="pod" defaultValue={pod} onChange={(e) => go({ pod: e.target.value, fo: '' })} className="min-w-[150px]"><option value="">All pods</option>{pods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="grid gap-1 text-[11.5px] font-medium text-ink-500">FO<select name="fo" defaultValue={fo} onChange={(e) => go({ fo: e.target.value })} className="min-w-[150px]"><option value="">All FOs</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <button type="submit" className="btn-secondary">Apply</button>
      </form>
      <a href={exportHref} target="_blank" rel="noreferrer" className="btn-secondary ml-auto">Export report</a>
    </div>
  );
}
