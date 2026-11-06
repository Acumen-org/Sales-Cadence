import Link from 'next/link';
import clsx from 'clsx';
import { Badge } from '@/components/ui';
import type { Cue } from '@/lib/sandbox/cues';

/**
 * One status badge and its warning chips (PLAN 4.0), the same on every screen: the contacts list,
 * the contact header, Tasks rows, Ctrl K and the Move dialog. A cold contact's cues come from
 * `coldCues`.
 */
export function SubjectBadges({ badge, chips = [], className, links = true, limit }: { badge: Cue | null; chips?: Cue[]; className?: string; /** False inside another link (a list row that is itself a link). */ links?: boolean; /** Show this many chips and "+N" for the rest. */ limit?: number }) {
  const shown = limit !== undefined ? chips.slice(0, limit) : chips;
  const more = chips.length - shown.length;
  return <span className={clsx('flex min-w-0 flex-wrap items-center gap-1.5', className)}>
    {badge ? <CueBadge cue={badge} links={links} strong /> : null}
    {shown.map((c) => <CueBadge key={c.label} cue={c} links={links} />)}
    {more > 0 ? <span className="text-[11.5px] text-ink-500" title={chips.slice(shown.length).map((c) => c.label).join(', ')}>+{more}</span> : null}
  </span>;
}

function CueBadge({ cue, links, strong }: { cue: Cue; links: boolean; strong?: boolean }) {
  // Do not contact is red with an outline and an icon, so it reads the same without colour (PLAN 4.0).
  const node = <Badge tone={cue.tone} className={clsx(strong && cue.tone === 'red' && 'ring-1 ring-red-300')}>{strong && cue.tone === 'red' ? <span aria-hidden className="mr-1">⊘</span> : null}{cue.label}</Badge>;
  const titled = cue.title ? <span title={cue.title} className="inline-flex">{node}</span> : node;
  return links && cue.href ? <Link href={cue.href} className="inline-flex hover:opacity-80" title={cue.title}>{node}</Link> : titled;
}
