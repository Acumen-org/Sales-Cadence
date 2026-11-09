'use client';

import { useRouter } from 'next/navigation';

/** The contacts list's less used views (All, Already in CRM, Closed, Moved, Do not contact and removed) as one menu. */
export function OtherViews({ options, current }: { options: { view: string; label: string; href: string }[]; current: string | null }) {
  const router = useRouter();
  const selected = options.find((o) => o.view === current);
  return <label className="flex items-center gap-2 text-[12.5px] text-ink-500 sm:ml-auto">
    <span className="whitespace-nowrap">Other views</span>
    <select
      aria-label="Other views"
      className="!w-auto !max-w-[240px] !py-1.5 !text-[12.5px]"
      value={selected?.href ?? ''}
      onChange={(e) => { if (e.target.value) router.push(e.target.value, { scroll: false }); }}
    >
      <option value="">Choose a view</option>
      {options.map((o) => <option key={o.view} value={o.href}>{o.label}</option>)}
    </select>
  </label>;
}
