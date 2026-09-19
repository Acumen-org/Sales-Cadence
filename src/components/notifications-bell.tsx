'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { loadNotificationsAction, markNotificationsReadAction } from '@/lib/actions/notifications';
import { IconBell, IconClose } from './icons';
import { Modal } from './modal';
import { Avatar, EmptyState } from './ui';

/**
 * Two short notes when something new arrives while the app is open. Browsers only let a page make
 * a sound after the person has clicked or typed once, so the chime arms itself on the first
 * interaction; it plays when the unread count rises, once per rise, and can be switched off in
 * the bell's own menu. Generated, not a file: nothing to load, nothing to block.
 */
function chime() {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const at = ctx.currentTime;
    for (const [freq, start] of [[880, 0], [1174.66, 0.14]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at + start);
      gain.gain.exponentialRampToValueAtTime(0.18, at + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + start + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at + start);
      osc.stop(at + start + 0.25);
    }
    setTimeout(() => void ctx.close(), 800);
  } catch {
    // No audio on this machine: the badge still shows.
  }
}

function useChime(unread: number): [boolean, (on: boolean) => void] {
  const [sound, setSoundState] = useState(true);
  const last = useRef(unread);
  const armed = useRef(false);
  useEffect(() => {
    try { setSoundState(window.localStorage.getItem('cadence.chime') !== 'off'); } catch { /* storage unavailable */ }
    const arm = () => { armed.current = true; };
    window.addEventListener('pointerdown', arm, { once: true });
    window.addEventListener('keydown', arm, { once: true });
    return () => { window.removeEventListener('pointerdown', arm); window.removeEventListener('keydown', arm); };
  }, []);
  useEffect(() => {
    if (unread > last.current && armed.current && sound) chime();
    last.current = unread;
  }, [unread, sound]);
  const setSound = (on: boolean) => {
    setSoundState(on);
    try { window.localStorage.setItem('cadence.chime', on ? 'on' : 'off'); } catch { /* storage unavailable */ }
  };
  return [sound, setSound];
}

export function NotificationsBell({ unread, timezone }: { unread: number; timezone: string }) {
  const router = useRouter();
  const [sound, setSound] = useChime(unread); const [open,setOpen]=useState(false); const [data,setData]=useState<Awaited<ReturnType<typeof loadNotificationsAction>>|null>(null); const [pending,setPending]=useState(false); const [error,setError]=useState('');
  const load=async(after?:string)=>{setPending(true);setError('');try{const page=await loadNotificationsAction(after);setData(old=>after&&old?{...page,items:[...old.items,...page.items]}:page);}catch{setError('Notifications could not be loaded. Try again.');}finally{setPending(false);}};
  return <><button type="button" className="btn-icon-ghost relative" aria-label="Notifications" onClick={()=>{setOpen(true);void load();}}><IconBell size={18}/>{unread>0&&<span className="absolute -right-1 -top-1 rounded-full bg-brand-700 px-1.5 text-[10px] font-semibold text-white">{unread>99?'99+':unread}</span>}</button>
    {open&&<Modal label="Notifications" onClose={()=>setOpen(false)}><div className="flex items-center gap-3 border-b border-line p-5"><h2 className="text-lg font-semibold">Inbox updates</h2><span className="ml-auto"/><button type="button" className="btn-ghost btn-sm" aria-pressed={sound} onClick={()=>setSound(!sound)} title={sound ? 'A chime plays when something new arrives' : 'No sound'}>{sound ? 'Sound on' : 'Sound off'}</button><button type="button" className="btn-ghost btn-sm" onClick={()=>chime()} title="Hear the chime">Play chime</button>{data&&data.items.some(i=>i.unread)&&<button className="btn-secondary btn-sm" type="button" disabled={pending} onClick={async()=>{try{await markNotificationsReadAction(data.through);setData(d=>d?{...d,items:d.items.map(i=>({...i,unread:false}))}:d);router.refresh();}catch{setError('Read status could not be saved.');}}} >Mark read</button>}<button type="button" aria-label="Close notifications" className="btn-icon-ghost" onClick={()=>setOpen(false)}><IconClose size={16}/></button></div>
    <div className="max-h-[65vh] overflow-y-auto">{error&&<div role="alert" className="p-4 text-sm text-red-700">{error}<button type="button" className="btn-secondary ml-3" onClick={()=>void load()}>Retry</button></div>}{pending&&!data&&<p role="status" className="p-5 text-sm">Loading inbox updates…</p>}{data&&!data.items.length&&<EmptyState title="No inbound emails yet"/>}{data?.items.map(item=><Link key={item.id} href={'/people/'+item.personId+'?tab=crm'} onClick={()=>setOpen(false)} className={'flex gap-3 border-b border-line p-5 hover:bg-canvas '+(item.unread?'bg-brand-50/50':'')}><Avatar name={item.name} shape="circle" size={36}/><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><strong className="text-sm">{item.name}</strong>{item.unread&&<span className="h-2 w-2 rounded-full bg-brand-600" aria-label="Unread"/>}</div><p className="mt-1 break-words text-sm font-medium text-ink-900">{item.title}</p><time className="mt-2 block text-xs text-ink-500">{new Intl.DateTimeFormat('en-US',{timeZone:timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(item.at))}</time></div></Link>)}{data?.next&&<button type="button" className="btn-secondary m-4" disabled={pending} onClick={()=>void load(data.next!)}>Older updates</button>}</div></Modal>}
  </>;
}
