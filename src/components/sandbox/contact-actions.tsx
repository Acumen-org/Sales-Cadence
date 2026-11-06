'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import clsx from 'clsx';
import { ConfirmDialog, useConfirm, type ConfirmOptions } from '@/components/confirm-dialog';
import { useFlash } from '@/components/flash';
import { IconDots } from '@/components/icons';
import { assignContactsAction, eraseContactAction, optOutContactAction, removeContactsAction } from '@/lib/actions/sandbox';
import type { ActionResult } from '@/lib/actions/users';
import { MoveDialog } from './move-dialog';

type Option = { id: string; name: string };
type Owner = Option & { podIds?: string[] };
type Props = {
  id: string;
  name?: string;
  /** D3: green "Ready to move" (complete details and a positive outcome): Move is the main button. */
  ready: boolean;
  /** Nobody owns it: a rep claims it first (B149). */
  unclaimed: boolean;
  mayWork: boolean;
  /** Opt out needs no claim: any sales user, any contact, a removed one too (PLAN 8.1, N027). */
  mayOptOut: boolean;
  mayMove: boolean;
  mayAssign: boolean;
  /** B200: a Junior FO may let go of their own contact (the server always allowed it), with no one to give it to. */
  mayRelease?: boolean;
  mayErase: boolean;
  /** Remove, when it differs from Move: defaults to `mayMove`. */
  mayRemove?: boolean;
  /** The reps this reader may give the contact to (B119, B208). */
  users: Owner[];
  /** The owner the page shows: an assign goes ahead only if it is still the owner (N076). */
  ownerId?: string | null;
  /** What moves with the contact, for the Assign confirm (B049): "1 next step and 1 campaign (2 steps)". */
  work?: string;
  /** Pods the reader may put the contact in, for the Move dialog's fixes (B050). */
  pods?: Option[];
  /** The confirms for Opt out, Remove and Erase, naming the person and every effect (confirm-words.ts). */
  confirms: { optOut: ConfirmOptions; remove: ConfirmOptions; erase: ConfirmOptions };
  /** Open the Move dialog at once: "Move to CRM" offered after a booked meeting (N061). */
  openMove?: boolean;
  /** Why Move to CRM is off, said under it (B110): "Claim first", "Being moved". */
  moveBlocked?: string | null;
  /** Why an item of More is off, by item, said in the menu (PLAN 4.0: a disabled control says why). */
  whyNot?: Partial<Record<MoreItem, string>>;
};

export type MoreItem = 'assign' | 'release' | 'opt_out' | 'remove' | 'erase';

/**
 * The contact page's Move to CRM and More (PLAN 4.2): Move is the main button only once the contact
 * is "Ready to move"; More holds Assign, Let go, Opt out, Remove and, for admins, Erase, each with
 * one line on what it does, so the three ways out read differently. Results travel in the page's
 * `?flash=`, so they survive the page re-reading itself (B148).
 */
export function ContactActions(props: Props) {
  const { id, ready, mayMove, users, pods = [], openMove = false, moveBlocked = null } = props;
  return <span className="inline-flex flex-wrap items-start gap-2">
    {mayMove || moveBlocked ? <MoveButton id={id} ready={ready} users={users} pods={pods} openMove={openMove && mayMove} blocked={moveBlocked} /> : null}
    <ContactMoreMenu {...props} />
  </span>;
}

/** A control and, under it, why it is off: the same shape as Call's (B089), for every button in the row. */
export function WithReason({ reason, children }: { reason?: string | null; children: React.ReactNode }) {
  return <span className="inline-flex max-w-[12rem] flex-col items-start gap-1">
    {children}
    {reason ? <span className="text-[12px] leading-4 text-ink-600">{reason}</span> : null}
  </span>;
}

/** Move to CRM: the dialog with its groups and fixes (4.5). */
export function MoveButton({ id, ready, users = [], pods = [], openMove = false, blocked = null, label = 'Move to CRM', className }: { id: string; ready: boolean; users?: Owner[]; pods?: Option[]; openMove?: boolean; blocked?: string | null; label?: string; className?: string }) {
  const [moving, setMoving] = useState(openMove && !blocked);
  const cls = className ?? (ready && !blocked ? 'btn-primary btn-sm' : 'btn-secondary btn-sm');
  return <WithReason reason={blocked}>
    <button type="button" className={cls} disabled={Boolean(blocked)} onClick={() => setMoving(true)}>{label}</button>
    {moving ? <MoveDialog ids={[id]} owners={users.map((u) => ({ ...u, podIds: u.podIds ?? [] }))} pods={pods} onClose={() => setMoving(false)} /> : null}
  </WithReason>;
}

/** Assign (or let go, for a Junior FO's own contact): a picker and an explicit button, never a select that acts on change (N078). */
export function AssignButton({ id, name = 'this contact', users, ownerId = null, work, release = false, label, className = 'btn-secondary btn-sm', open: startOpen = false, onClose }: { id: string; name?: string; users: Owner[]; ownerId?: string | null; work?: string; release?: boolean; label?: string; className?: string; /** Opened from a menu: the dialog only. */ open?: boolean; onClose?: () => void }) {
  const [assigning, setAssigning] = useState(startOpen);
  const [to, setTo] = useState(release ? 'release' : '');
  const [pending, start] = useTransition();
  const say = useFlash();
  const target = users.find((u) => u.id === to);
  const close = () => { setAssigning(false); onClose?.(); };
  const assign = () => {
    const fd = new FormData();
    fd.append('ids', id);
    fd.set('userId', to === 'release' ? '' : to);
    fd.set(`owner:${id}`, ownerId ?? '');
    start(async () => {
      const r = await assignContactsAction(fd);
      close();
      say(r.ok ? r.message ?? 'Done.' : r.error, r.ok ? 'ok' : 'error');
    });
  };
  return <>
    {startOpen ? null : <button type="button" className={className} disabled={pending} onClick={() => { setTo(release ? 'release' : ''); setAssigning(true); }}>{label ?? (release ? 'Let go' : 'Assign')}</button>}
    {assigning ? <ConfirmDialog
      title={release ? `Let go of ${name}` : `Assign ${name}`}
      effects={[to === 'release' ? (work ? `It has ${work}, so it cannot be let go: give it to someone instead.` : "It goes back to its pod's Unclaimed view.") : `${target?.name ?? 'The new owner'} owns it from now${work ? `, with its ${work}` : ''}.`]}
      confirmLabel={to === 'release' ? 'Let go' : 'Assign'}
      confirmDisabled={!to || (to === 'release' && Boolean(work))}
      pending={pending}
      onCancel={close}
      onConfirm={assign}
    >
      {release ? null : <label className="block text-xs text-ink-500">To<select data-autofocus className="mt-1 w-full" value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose a rep</option><option value="release">Nobody: let it go</option>{users.filter((u) => u.id !== ownerId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>}
    </ConfirmDialog> : null}
  </>;
}

/** Each item of More and the one line that says what it does (Erase: how it differs from Remove). */
export const MORE_WORDS: Record<MoreItem, { label: string; line: (name: string) => string }> = {
  assign: { label: 'Assign', line: (n) => `Give ${n} to another rep, with the next step and campaigns.` },
  release: { label: 'Let go', line: (n) => `Put ${n} back in the pod's Unclaimed view.` },
  opt_out: { label: 'Opt out', line: (n) => `${n} asked not to be contacted: everything stops, for good.` },
  remove: { label: 'Remove', line: (n) => `Not a fit: ${n}'s details are cleared. Bellwether may send them again.` },
  erase: { label: 'Erase', line: () => 'For an erasure request. Unlike Remove, every detail is deleted for good and Bellwether can never send them again.' },
};

/** More: the rarer acts, each said in one line, each with its confirm naming every effect (PLAN 4.0). */
export function ContactMoreMenu({ id, name = 'this contact', mayOptOut, mayAssign, mayRelease = false, mayErase, mayMove, mayRemove = mayMove, users, ownerId = null, work, confirms, whyNot = {} }: Props) {
  const [open, setOpen] = useState(false);
  // The menu opens towards the side with room: rightwards from More, or leftwards near the right edge.
  const [toLeft, setToLeft] = useState(false);
  const [assigning, setAssigning] = useState<'assign' | 'release' | null>(null);
  const [pending, start] = useTransition();
  const [ask, dialog] = useConfirm();
  const say = useFlash();
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const allowed: Record<MoreItem, boolean> = { assign: mayAssign, release: mayRelease && !mayAssign, opt_out: mayOptOut, remove: mayRemove, erase: mayErase };
  const items = (Object.keys(MORE_WORDS) as MoreItem[]).filter((k) => allowed[k] || whyNot[k]);
  if (!items.length) return null;
  const run = (item: 'opt_out' | 'remove' | 'erase') => {
    setOpen(false);
    void (async () => {
      const answer = await ask(item === 'opt_out' ? confirms.optOut : item === 'remove' ? confirms.remove : confirms.erase);
      if (!answer) return;
      const fd = new FormData();
      if (item === 'remove') fd.append('ids', id); else fd.set('id', id);
      if (answer.reason) fd.set('reason', answer.reason);
      start(async () => {
        let r: ActionResult;
        try { r = await (item === 'opt_out' ? optOutContactAction : item === 'remove' ? removeContactsAction : eraseContactAction)(fd); } catch { r = { ok: false, error: 'Cadence could not do that just now. Try again.' }; }
        // The page stays: a removed or erased contact's page says who, when and what was cleared (B150).
        say(r.ok ? (item === 'remove' ? 'Removed. Their details were cleared from Cadence.' : r.message ?? 'Done.') : r.error, r.ok ? 'ok' : 'error');
      });
    })();
  };
  const choose = (item: MoreItem) => {
    if (item === 'assign' || item === 'release') { setOpen(false); setAssigning(item); return; }
    run(item);
  };
  return <span ref={box} className="relative inline-flex">
    <button type="button" className="btn-secondary btn-sm" aria-haspopup="menu" aria-expanded={open} disabled={pending} onClick={() => { const r = box.current?.getBoundingClientRect(); setToLeft(Boolean(r && r.left + 320 > window.innerWidth)); setOpen((v) => !v); }}><IconDots size={14} />More</button>
    {open ? <div role="menu" aria-label={`More for ${name}`} className={clsx('absolute top-full z-30 mt-1 w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-white py-1 shadow-pop', toLeft ? 'right-0' : 'left-0')}>
      {items.map((k) => {
        const off = !allowed[k];
        const danger = k === 'opt_out' || k === 'remove' || k === 'erase';
        return <button key={k} type="button" role="menuitem" disabled={off} onClick={() => choose(k)} className={clsx('block w-full px-3.5 py-2 text-left transition', off ? 'cursor-not-allowed' : 'hover:bg-canvas')}>
          <span className={clsx('block text-[13px] font-medium', off ? 'text-ink-400' : danger ? 'text-red-700' : 'text-ink-900')}>{MORE_WORDS[k].label}</span>
          <span className="block text-[12px] leading-4 text-ink-500">{off ? whyNot[k] : MORE_WORDS[k].line(name)}</span>
        </button>;
      })}
    </div> : null}
    {assigning ? <AssignButton id={id} name={name} users={users} ownerId={ownerId} work={work} release={assigning === 'release'} open onClose={() => setAssigning(null)} /> : null}
    {dialog}
  </span>;
}
