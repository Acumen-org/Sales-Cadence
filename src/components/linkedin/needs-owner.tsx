'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { useFlash } from '@/components/flash';
import { Avatar } from '@/components/ui';
import { IconChevronRight } from '@/components/icons';
import { assignFollowUpAction } from '@/lib/actions/linkedin';

export type NeedsOwnerRow = { id: string; name: string; href: string | null; why: string; account: string | null; company: string | null; podIds: string[]; /** The reply's subject, for an email. */ subject?: string | null };
type Owner = { id: string; name: string; podIds: string[] };

const SHOWN = 5;

function assign(id: string, foUserId: string | null) {
  const fd = new FormData();
  fd.set('id', id);
  if (foUserId) fd.set('foUserId', foUserId);
  return assignFollowUpAction(fd);
}

/** "Give to…": a menu of the reps who may have them, drawn over the page so no card cuts it off. */
function GiveMenu({ row, owners, onPick, disabled }: { row: NeedsOwnerRow; owners: Owner[]; onPick: (id: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { const t = e.target as Node; if (!button.current?.contains(t) && !menu.current?.contains(t)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const close = () => setOpen(false);
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc); window.addEventListener('scroll', close, true); window.addEventListener('resize', close);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);
  const toggle = () => {
    const r = button.current?.getBoundingClientRect();
    if (r) { const width = 220; const below = window.innerHeight - r.bottom - 12; const up = below < 200 && r.top > below; setPlace({ position: 'fixed', width, left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)), ...(up ? { bottom: window.innerHeight - r.top + 4, maxHeight: r.top - 12 } : { top: r.bottom + 4, maxHeight: below }) }); }
    setOpen((v) => !v);
  };
  return <>
    <button ref={button} type="button" className="btn-ghost btn-sm" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={toggle}>Give to…</button>
    {open && place ? createPortal(<div ref={menu} role="menu" aria-label={`Give ${row.name} to`} style={place} className="z-50 overflow-y-auto rounded-xl border border-line bg-white py-1 shadow-pop">
      {owners.map((o) => <button key={o.id} type="button" role="menuitem" className="block w-full truncate px-3.5 py-2 text-left text-[13px] text-ink-900 hover:bg-canvas" onClick={() => { setOpen(false); onPick(o.id); }}>{o.name}</button>)}
    </div>, document.body) : null}
  </>;
}

function Row({ row, owners, canTake, canGive }: { row: NeedsOwnerRow; owners: Owner[]; canTake: boolean; canGive: boolean }) {
  const [pending, start] = useTransition();
  const say = useFlash();
  const fit = owners.filter((o) => !row.podIds.length || o.podIds.some((p) => row.podIds.includes(p)));
  const go = (to: string | null) => start(async () => { const r = await assign(row.id, to); say(r.ok ? r.message ?? 'Done.' : r.error, r.ok ? 'ok' : 'error'); });
  return <li className={clsx('flex items-center gap-3 px-4 py-2.5', pending && 'opacity-60')}>
    <Avatar name={row.name} shape="circle" size={30} />
    <div className="min-w-0 flex-1">
      <div className="truncate text-[13.5px]">
        {row.href ? <Link href={row.href} className="font-medium text-ink-900 hover:text-brand-700">{row.name}</Link> : <span className="font-medium text-ink-900">{row.name}</span>}
        {row.company ? <span className="text-ink-500"> · {row.company}</span> : null}
      </div>
      <div className="truncate text-[12.5px] text-ink-600">{row.why}{row.subject ? <span className="text-ink-500"> · “{row.subject}”</span> : null}{row.account ? <> · {row.account}&apos;s LinkedIn</> : null}</div>
    </div>
    <div className="flex shrink-0 items-center gap-1">
      {canTake ? <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => go(null)}>Take</button> : null}
      {canGive && fit.length ? <GiveMenu row={row} owners={fit} disabled={pending} onPick={go} /> : null}
    </div>
  </li>;
}

/**
 * "They replied: needs an owner" (owner, 12 and 13 Nov 2026): someone with no owner answered us -
 * accepted our LinkedIn request, wrote back on LinkedIn, or replied to our email. Take them, or a pod
 * leader or an admin gives them to someone; their task is due 2 working days after the reply.
 */
export function LinkedInNeedsOwner({ rows, owners, canTake, canGive = true }: { rows: NeedsOwnerRow[]; owners: Owner[]; canTake: boolean; canGive?: boolean }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, SHOWN);
  return <section className="surface overflow-hidden" aria-labelledby="li-needs-owner">
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3">
      <span aria-hidden className="h-2 w-2 rounded-full bg-amber-500" />
      <h2 id="li-needs-owner" className="text-[14px] font-semibold text-ink-900">They replied: needs an owner</h2>
      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[12px] font-semibold tabular-nums text-amber-800 ring-1 ring-amber-200">{rows.length}</span>
      <span className="w-full text-[12.5px] text-ink-500 sm:ml-auto sm:w-auto">Whoever takes them gets a task to answer within 2 working days.</span>
    </header>
    <ul className="divide-y divide-line">{shown.map((r) => <Row key={r.id} row={r} owners={owners} canTake={canTake} canGive={canGive} />)}</ul>
    {rows.length > SHOWN ? <button type="button" onClick={() => setAll(!all)} className="flex w-full items-center justify-center gap-1 border-t border-line px-4 py-2 text-[12.5px] font-medium text-brand-700 hover:bg-canvas">
      {all ? 'Show fewer' : `Show all ${rows.length}`}<IconChevronRight size={13} className={all ? '-rotate-90' : 'rotate-90'} />
    </button> : null}
  </section>;
}
