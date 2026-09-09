'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { globalSearchAction, type SearchHit } from '@/lib/actions/search';
import { IconChevronRight, IconClose, IconHelp, IconSearch } from './icons';
import { Avatar } from './ui';
import type { Role } from '@prisma/client';
import { NotificationsBell } from './notifications-bell';
import { Modal } from './modal';

type Props = { role: Role; unread: number; needsReview: number };
const SECTIONS: Record<string, string> = {
  home: 'Home',
  tasks: 'Tasks',
  accounts: 'Accounts',
  people: 'People',
  meetings: 'Meetings',
  sequences: 'Sequences',
  campaigns: 'Campaigns',
  activity: 'Activity',
  reports: 'Reports',
  enrichment: 'Enrichment',
  settings: 'Settings',
};

export function TopBar({ role, unread, needsReview }: Props) {
  const pathname = usePathname();
  const key = pathname.split('/')[1];
  const title = SECTIONS[key] ?? 'Cadence';
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setHelpOpen(false); setSearchOpen((value) => !value); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return <>
    <header className="workspace-topbar">
      <div className="mr-auto flex min-w-0 items-center gap-2 pl-9 text-[12px] lg:pl-0"><span className="hidden text-ink-400 sm:inline">Workspace</span><IconChevronRight size={12} className="hidden text-ink-300 sm:block" /><span className="truncate font-medium text-ink-800">{title}</span></div>
      <button type="button" title="Search (Ctrl+K)" aria-label="Search" onClick={() => setSearchOpen(true)} className="flex h-9 items-center gap-2 rounded-lg border border-line bg-canvas/60 px-2.5 text-[11px] text-ink-500 transition hover:border-ink-300 sm:w-[245px]"><IconSearch size={15} /><span className="hidden sm:inline">Search your workspace</span><kbd className="ml-auto hidden !bg-white sm:inline">Ctrl K</kbd></button>
      <div className="mx-1 hidden h-5 w-px bg-line sm:block" />
      <NotificationsBell unread={unread} />
      <button type="button" className="btn-icon-ghost" title="Shortcuts and help" aria-label="Help" onClick={() => setHelpOpen(true)}><IconHelp size={18} /></button>
    </header>
    {key !== 'home' ? <div className="px-4 pb-5 pt-7 sm:px-8"><h1 className="text-[28px] font-semibold tracking-[-0.045em] text-ink-900">{title}</h1></div> : null}
    {searchOpen ? <SearchDialog onClose={() => setSearchOpen(false)} /> : null}
    {helpOpen ? <HelpDialog onClose={() => setHelpOpen(false)} needsReview={needsReview} isAdmin={role === 'ADMIN'} /> : null}
  </>;
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHits([]); setActive(0); setError(null);
    if (q.trim().length < 2) { setPending(false); return; }
    setPending(true);
    const timer = setTimeout(async () => {
      try { const result = await globalSearchAction(q); if (!cancelled) setHits(result); }
      catch { if (!cancelled) setError('Search is unavailable. Please try again.'); }
      finally { if (!cancelled) setPending(false); }
    }, 180);
    return () => { clearTimeout(timer); cancelled = true; };
  }, [q]);
  const go = useCallback((hit: SearchHit | undefined) => { if (hit) { onClose(); router.push(hit.href); } }, [onClose, router]);
  return <Modal label="Search workspace" onClose={onClose}>
    <div className="flex items-center gap-2.5 border-b border-line px-5">
      <IconSearch size={20} className="text-brand-600" />
      <input autoFocus value={q} maxLength={200} role="combobox" aria-autocomplete="list" aria-expanded={hits.length > 0} aria-controls="workspace-results" aria-activedescendant={hits[active] ? `search-hit-${active}` : undefined} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => hits.length ? (a + 1) % hits.length : 0); }
        if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => hits.length ? (a - 1 + hits.length) % hits.length : 0); }
        if (e.key === 'Enter') { e.preventDefault(); go(hits[active]); }
      }} placeholder="Search people, campaigns and sequences" aria-label="Search" className="!border-0 !bg-transparent !py-5 !text-[14px] !ring-0" />
      <button type="button" onClick={onClose} aria-label="Close search" className="btn-icon-ghost"><IconClose size={17} /></button>
    </div>
    <div className="max-h-[52vh] overflow-y-auto p-2 scroll-thin" aria-busy={pending}>
      <p role="status" className={clsx('px-4 py-8 text-center text-[13px] text-ink-500', hits.length > 0 && 'sr-only')}>{error ?? (q.trim().length < 2 ? 'Find a person, campaign, or sequence. Start with two characters.' : pending ? 'Searching your workspace…' : hits.length ? `${hits.length} results` : 'No matches. Try a different name or company.')}</p>
      <ul id="workspace-results" role="listbox" aria-label="Search results">{hits.map((h, i) => <li key={`${h.kind}-${h.id}`} id={`search-hit-${i}`} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => go(h)} className={clsx('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-3', i === active ? 'bg-brand-50' : 'hover:bg-canvas')}>
        <Avatar name={h.title} size={34} shape={h.kind === 'person' ? 'circle' : 'square'} /><span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-ink-900">{h.title}</span>{h.sub ? <span className="block truncate text-[11px] text-ink-500">{h.sub}</span> : null}</span><span className="rounded border border-line px-1.5 py-0.5 text-[9px] capitalize text-ink-500">{h.kind}</span>
      </li>)}</ul>
    </div>
    <div className="flex gap-4 border-t border-line px-5 py-3 text-[10px] text-ink-500"><span><kbd>↑ ↓</kbd> to navigate</span><span><kbd>Enter</kbd> to open</span><span className="ml-auto"><kbd>Esc</kbd> to close</span></div>
  </Modal>;
}

function HelpDialog({ onClose, needsReview, isAdmin }: { onClose: () => void; needsReview: number; isAdmin: boolean }) {
  return <Modal label="Shortcuts and help" onClose={onClose} className="!max-w-sm">
    <div className="p-6"><div className="mb-1 flex items-center justify-between"><h2 className="text-[17px] font-semibold tracking-tight">Task flow shortcuts</h2><button type="button" aria-label="Close help" onClick={onClose} className="btn-icon-ghost"><IconClose size={17} /></button></div><p className="mb-5 text-[12px] leading-relaxed text-ink-500">Keep your focus on the conversation. Shortcuts work when you’re outside a text field.</p>
      <ul className="space-y-3 text-[12px] text-ink-600">{[['D', 'Mark done'], ['S', 'Skip with a reason'], ['Z', 'Snooze'], ['N / P', 'Next / previous task'], ['O', 'Open in Twenty'], ['M', 'More actions'], ['1–9', 'Pick a call outcome'], ['Ctrl+K', 'Search']].map(([k, v]) => <li key={k} className="flex items-center justify-between gap-3"><span>{v}</span><kbd>{k}</kbd></li>)}</ul>
      {isAdmin && needsReview > 0 ? <Link href="/settings?tab=activity" onClick={onClose} className="mt-5 block rounded-lg bg-amber-50 px-3 py-3 text-[12px] font-medium text-amber-800">{needsReview} event{needsReview === 1 ? '' : 's'} need review <span aria-hidden>→</span></Link> : null}
    </div>
  </Modal>;
}

