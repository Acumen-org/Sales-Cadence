'use client';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { loadNotificationsAction, markNotificationsReadAction } from '@/lib/actions/notifications';
import { acceptSuggestionAction, dismissSuggestionAction } from '@/lib/actions/call-forms';
import type { BellItem } from '@/lib/notifications';
import { IconAlert, IconBell, IconClock, IconClose, IconPeople, IconPhone } from './icons';
import { Modal } from './modal';
import { Avatar, EmptyState } from './ui';

/**
 * A chime when something new arrives while the app is open. Browsers only let a page make a sound
 * after the person has clicked or typed on it, and a player made at any other moment stays silent,
 * so one player is made on the first click or key and every chime uses it. Three soft bell notes,
 * generated rather than loaded: nothing to fetch, nothing to block.
 */
let player: AudioContext | null = null;
function unlockAudio() {
  try {
    player ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (player.state === 'suspended') void player.resume();
  } catch {
    player = null;
  }
}

export function chime() {
  const ctx = player;
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    const at = ctx.currentTime + 0.02;
    const out = ctx.createGain();
    out.gain.value = 0.32;
    out.connect(ctx.destination);
    // A rising major triad, each note a bell: the tone and a quieter octave above, a quick strike and a long fade.
    for (const [freq, start] of [[659.25, 0], [830.61, 0.11], [987.77, 0.22]] as const) {
      for (const [mult, level] of [[1, 1], [2, 0.28]] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq * mult;
        gain.gain.setValueAtTime(0.0001, at + start);
        gain.gain.exponentialRampToValueAtTime(level, at + start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + start + 0.9);
        osc.connect(gain).connect(out);
        osc.start(at + start);
        osc.stop(at + start + 0.95);
      }
    }
  } catch {
    // No audio on this machine: the badge still shows.
  }
}

/**
 * The unread count, kept current by the bell itself: from the page on every render, and from a
 * light check every 20 seconds while the tab is open, dialog or not. It chimes when the count rises.
 */
function useUnread(initial: number): [number, boolean, (on: boolean) => void] {
  const [unread, setUnread] = useState(initial);
  const [sound, setSoundState] = useState(true);
  const last = useRef(initial);
  const soundRef = useRef(true);
  useEffect(() => { setUnread(initial); }, [initial]);
  useEffect(() => {
    try { const on = window.localStorage.getItem('cadence.chime') !== 'off'; setSoundState(on); soundRef.current = on; } catch { /* storage unavailable */ }
    window.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);
    let stopped = false;
    const check = async (evenHidden = false) => {
      if (document.visibilityState !== 'visible' && !evenHidden) return;
      try {
        const res = await fetch('/api/notifications/unread', { cache: 'no-store' });
        if (!res.ok) return;
        const { unread: now } = (await res.json()) as { unread: number | null };
        if (!stopped && typeof now === 'number') setUnread(now);
      } catch { /* offline for a moment: the next check will do */ }
    };
    // Every 20 seconds, in view or not: a hidden tab's timers are slowed by the browser to about once
    // a minute, which is how often a reply that arrives while the FO is in their inbox still chimes.
    const timer = window.setInterval(() => void check(true), 20_000);
    const onVisible = () => void check();
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('pointerdown', unlockAudio); window.removeEventListener('keydown', unlockAudio); };
  }, []);
  useEffect(() => {
    if (unread > last.current && soundRef.current) chime();
    last.current = unread;
  }, [unread]);
  const setSound = (on: boolean) => {
    setSoundState(on);
    soundRef.current = on;
    try { window.localStorage.setItem('cadence.chime', on ? 'on' : 'off'); } catch { /* storage unavailable */ }
  };
  return [unread, sound, setSound];
}

/** A small speaker, with sound waves when the chime is on. */
function SpeakerIcon({ on }: { on: boolean }) {
  return <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mr-1.5">
    <path d="M11 5 6 9H3v6h3l5 4z" />
    {on ? <><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></> : <path d="m16 9 5 6m0-6-5 6" />}
  </svg>;
}

type Page = Awaited<ReturnType<typeof loadNotificationsAction>>;

/** Things that are not a person get a picture of what they are; people get their initials. */
const KIND_ICON: Partial<Record<BellItem['kind'], ReactNode>> = {
  move_finished: <IconPeople size={18} />,
  retention_warning: <IconClock size={18} />,
  call_flag: <IconPhone size={18} />,
  compliance_alert: <IconAlert size={18} />,
};

/**
 * Accept as next step, or Dismiss, on a colleague's suggestion (B027), right in the bell. Accepting
 * runs the same checks as setting a step by hand; a refusal says why, here.
 */
function SuggestionButtons({ id, onDone }: { id: string; onDone: () => void }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (action: typeof acceptSuggestionAction) => start(async () => {
    const fd = new FormData();
    fd.set('id', id);
    try {
      const r = await action(fd);
      setResult(r.ok ? { ok: true, text: r.message ?? 'Done.' } : { ok: false, text: r.error });
      if (r.ok) onDone();
    } catch {
      setResult({ ok: false, text: 'That did not go through. Try again.' });
    }
  });
  return <span className="mt-2 flex flex-wrap items-center gap-2">
    <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(acceptSuggestionAction)}>Accept as next step</button>
    <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => run(dismissSuggestionAction)}>Dismiss</button>
    {result ? <span role="status" className={'text-xs ' + (result.ok ? 'text-brand-700' : 'text-red-700')}>{result.text}</span> : null}
  </span>;
}

/** One notification: who or what it is about, what happened, a link to it, and a suggestion's buttons. */
function BellRow({ item, timezone, onOpen, onAnswered }: { item: BellItem; timezone: string; onOpen: () => void; onAnswered: () => void }) {
  const text = <>
    <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-ink-900">{item.name}{item.company ? <span className="font-normal text-ink-500"> · {item.company}</span> : null}</span>{item.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-brand-600" aria-label="Unread" />}</div>
    <p className="mt-1 break-words text-sm font-medium text-ink-900">{item.title}</p>
    {item.detail ? <p className="mt-1 break-words text-[13px] text-ink-600">{item.detail}</p> : null}
  </>;
  return <li className={'flex gap-3 border-b border-line p-5 ' + (item.unread ? 'bg-brand-50/50' : '')}>
    {KIND_ICON[item.kind] ? <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-canvas text-ink-600" aria-hidden>{KIND_ICON[item.kind]}</span> : <Avatar name={item.name} shape="circle" size={36} />}
    <div className="min-w-0 flex-1">
      {item.href ? <Link href={item.href} onClick={onOpen} aria-label={`${item.name}: ${item.title}. ${item.linkLabel}`} className="block hover:text-brand-700">{text}</Link> : text}
      {item.suggestion?.mayAccept ? <SuggestionButtons id={item.suggestion.id} onDone={onAnswered} /> : null}
      <time className="mt-2 block text-xs text-ink-500">{new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.at))}</time>
    </div>
  </li>;
}

export function NotificationsBell({ unread: fromPage, timezone }: { unread: number; timezone: string }) {
  const router = useRouter();
  const [unread, sound, setSound] = useUnread(fromPage); const [open, setOpen] = useState(false); const [data, setData] = useState<Page | null>(null); const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const load = async (after?: string) => { setPending(true); setError(''); try { const page = await loadNotificationsAction(after); setData((old) => after && old ? { ...page, items: [...old.items, ...page.items] } : page); } catch { setError('Notifications could not be loaded. Try again.'); } finally { setPending(false); } };
  const close = () => setOpen(false);
  return <><button type="button" className="btn-icon-ghost relative" aria-label="Notifications" title={unread > 0 ? `${unread} unread` : undefined} onClick={() => { setOpen(true); void load(); }}><IconBell size={18} />{unread > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-brand-700 px-1.5 text-[10px] font-semibold text-white">{unread > 99 ? '99+' : unread}</span>}</button>
    {open && <Modal label="Notifications" onClose={close}><div className="flex items-center gap-3 border-b border-line p-5"><h2 className="text-lg font-semibold">Notifications</h2><span className="ml-auto" /><button type="button" className="btn-ghost btn-sm" aria-pressed={sound} aria-label={sound ? 'Chime on' : 'Chime off'} onClick={() => { const on = !sound; setSound(on); if (on) chime(); }}><SpeakerIcon on={sound} />{sound ? 'Chime on' : 'Chime off'}</button>{data && data.items.some((i) => i.unread) && <button className="btn-secondary btn-sm" type="button" disabled={pending} onClick={async () => { try { await markNotificationsReadAction(data.through); setData((d) => d ? { ...d, items: d.items.map((i) => ({ ...i, unread: false })) } : d); router.refresh(); } catch { setError('Read status could not be saved.'); } }}>Mark read</button>}<button type="button" aria-label="Close notifications" className="btn-icon-ghost" onClick={close}><IconClose size={16} /></button></div>
      <div className="max-h-[65vh] overflow-y-auto">{error && <div role="alert" className="p-4 text-sm text-red-700">{error}<button type="button" className="btn-secondary ml-3" onClick={() => void load()}>Retry</button></div>}{pending && !data && <p role="status" className="p-5 text-sm">Loading notifications…</p>}{data && !data.items.length && <EmptyState title="No notifications yet" hint="Replies, bounces, suggested next steps and finished moves show here." />}{data?.items.length ? <ul>{data.items.map((item) => <BellRow key={item.id} item={item} timezone={timezone} onOpen={close} onAnswered={() => { void load(); router.refresh(); }} />)}</ul> : null}{data?.next && <button type="button" className="btn-secondary m-4" disabled={pending} onClick={() => void load(data.next!)}>Older notifications</button>}</div></Modal>}
  </>;
}
