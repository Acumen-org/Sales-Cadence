import Link from 'next/link';
import type { StartingSoon } from '@/lib/campaign-membership';
import { formatLocalDate } from '@/lib/dates';
import { IconCampaigns } from '@/components/icons';
import { Count } from '@/components/ui';

/**
 * Campaigns that start within the week, shown where their work will appear before it exists:
 * Tasks, Home and the record pages. One line per campaign; nothing when there is none.
 */
export function StartingSoonStrip({ items, className }: { items: StartingSoon[]; className?: string }) {
  if (!items.length) return null;
  return (
    <div className={`surface divide-y divide-line ${className ?? ''}`} role="list" aria-label="Campaigns starting soon">
      {items.map((c) => (
        <Link key={c.id} href={`/campaigns/${c.id}`} role="listitem" className="flex flex-wrap items-center gap-3 px-5 py-3 text-[13px] transition hover:bg-brand-50/50">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-50 text-purple-700"><IconCampaigns size={15} /></span>
          <span className="font-medium text-ink-900">{c.name}</span>
          <span className="text-ink-500">
            {c.daysUntil === 0 ? 'Starts today' : c.daysUntil === 1 ? 'Starts tomorrow' : `Starts ${formatLocalDate(c.startDate, 'long')}`}
            {c.endDate ? <> · ends {formatLocalDate(c.endDate)}</> : null}
            {' · '}{c.podName}
          </span>
          <span className="ml-auto tabular-nums text-ink-700">
            <Count value={c.people} /> {c.people === 1 ? 'person' : 'people'}
            {c.mine ? <span className="text-ink-500"> · <Count value={c.mine} /> yours</span> : null}
          </span>
        </Link>
      ))}
    </div>
  );
}
