'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import clsx from 'clsx';
import { globalSearchAction, type SearchHit } from '@/lib/actions/search';
import { IconBell, IconCalendar, IconHelp, IconMail, IconPhone, IconSearch } from './icons';
import { Avatar } from './ui';

type Props = {
  role: 'ADMIN' | 'SENIOR_FO' | 'JUNIOR_FO';
  overdue: number;
  needsReview: number;
  todayCount: number;
};

const SECTIONS: Array<{ match: RegExp; title: string }> = [
  { match: /^\/home/, title: 'Home' },
  { match: /^\/tasks/, title: 'Tasks' },
  { match: /^\/accounts/, title: 'Accounts' },
  { match: /^\/people/, title: 'People' },
  { match: /^\/meetings/, title: 'Meetings' },
  { match: /^\/sequences/, title: 'Sequences' },
  { match: /^\/campaigns/, title: 'Campaigns' },
  { match: /^\/activity/, title: 'Activity' },
  { match: /^\/reports/, title: 'Reports' },
  { match: /^\/settings/, title: 'Settings' },
];

/**
 * The application top bar: section title, and a help button. The wider utility cluster
 * (search, notifications, channel shortcuts) only appears on Tasks, where working through the
 * day actually needs it; everywhere else the bar stays quiet.
 */
export function TopBar({ role, overdue, needsReview, todayCount }: Props) {
  const pathname = usePathname();
  const section = SECTIONS.find((s) => s.match.test(pathname))?.title ?? 'Cadence';
  const showUtilities = /^\/tasks/.test(pathname);
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  void todayCount;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="flex items-center gap-3 px-6 pt-4">
      <h1 className="mr-auto truncate text-[26px] font-semibold tracking-[-0.01em] text-ink-900">{section}</h1>

      <div className="flex items-center gap-0.5">
        {showUtilities ? (
          <>
            <button type="button" className="btn-icon-ghost" title="Search (Ctrl+K)" aria-label="Search" onClick={() => setSearchOpen(true)}>
              <IconSearch size={18} />
            </button>
            <Link href="/tasks?tab=overdue" className="btn-icon-ghost relative" title={overdue ? `${overdue} overdue tasks` : 'Nothing overdue'} aria-label="Overdue tasks">
              <IconBell size={18} />
              {overdue > 0 ? <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-canvas" /> : null}
            </Link>
            <Link href="/tasks?type=CALL" className="btn-icon-ghost" title="Call tasks" aria-label="Call tasks">
              <IconPhone size={18} />
            </Link>
            <Link href="/tasks?type=EMAIL" className="btn-icon-ghost" title="Email tasks" aria-label="Email tasks">
              <IconMail size={18} />
            </Link>
            <Link href="/tasks?tab=upcoming" className="btn-icon-ghost" title="Upcoming" aria-label="Upcoming tasks">
              <IconCalendar size={18} />
            </Link>
          </>
        ) : null}
        <button type="button" className="btn-icon-ghost relative" title="Shortcuts and help" aria-label="Help" onClick={() => setHelpOpen((v) => !v)}>
          <IconHelp size={18} />
          {needsReview > 0 ? <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-canvas" /> : null}
        </button>
      </div>

      {searchOpen ? <SearchDialog onClose={() => setSearchOpen(false)} /> : null}
      {helpOpen ? <HelpPopover onClose={() => setHelpOpen(false)} needsReview={needsReview} isAdmin={role === 'ADMIN'} /> : null}
    </header>
  );
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      start(async () => {
        setHits(q.trim().length < 2 ? [] : await globalSearchAction(q));
        setActive(0);
      });
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  const go = useCallback(
    (hit: SearchHit | undefined) => {
      if (!hit) return;
      onClose();
      router.push(hit.href);
    },
    [onClose, router],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink-900/20 p-4 pt-[12vh]" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-white shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <IconSearch size={18} className="text-ink-400" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, hits.length - 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                go(hits[active]);
              }
            }}
            placeholder="Search people, campaigns and sequences"
            aria-label="Search"
            className="!border-0 !bg-transparent !py-3.5 !text-[15px] !ring-0"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="max-h-[52vh] overflow-y-auto scroll-thin">
          {hits.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-ink-400">{q.trim().length < 2 ? 'Type at least two characters.' : pending ? 'Searching...' : 'Nothing found.'}</p>
          ) : (
            <ul>
              {hits.map((h, i) => (
                <li key={`${h.kind}-${h.id}`}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(h)}
                    className={clsx('flex w-full items-center gap-3 px-4 py-2.5 text-left', i === active ? 'bg-brand-50' : 'hover:bg-canvas')}
                  >
                    <Avatar name={h.title} size={28} shape={h.kind === 'person' ? 'circle' : 'square'} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium text-ink-900">{h.title}</span>
                      {h.sub ? <span className="block truncate text-[12px] text-ink-500">{h.sub}</span> : null}
                    </span>
                    <span className="text-[11px] uppercase tracking-wide text-ink-300">{h.kind}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function HelpPopover({ onClose, needsReview, isAdmin }: { onClose: () => void; needsReview: number; isAdmin: boolean }) {
  // Escape closes it, like every other overlay in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div className="absolute right-6 top-16 w-80 rounded-2xl border border-line bg-white p-4 shadow-pop" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-2 text-[13px] font-semibold text-ink-900">Task flow shortcuts</h2>
        <ul className="space-y-1.5 text-[12.5px] text-ink-600">
          {[
            ['D', 'mark done'],
            ['S', 'skip with a reason'],
            ['Z', 'snooze'],
            ['N / P', 'next / previous task'],
            ['C', 'copy the template'],
            ['O', 'open in Twenty'],
            ['M', 'more actions'],
            ['1-9', 'pick a call outcome'],
            ['Ctrl+K', 'search'],
          ].map(([k, v]) => (
            <li key={k} className="flex items-center justify-between gap-3">
              <span className="text-ink-500">{v}</span>
              <kbd>{k}</kbd>
            </li>
          ))}
        </ul>
        {isAdmin && needsReview > 0 ? (
          <Link href="/settings?tab=activity" className="mt-3 block rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] font-medium text-amber-800">
            {needsReview} event{needsReview === 1 ? '' : 's'} need review
          </Link>
        ) : null}
      </div>
    </div>
  );
}
