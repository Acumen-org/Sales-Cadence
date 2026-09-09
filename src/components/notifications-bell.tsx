'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { loadNotificationsAction, markNotificationsReadAction } from '@/lib/actions/notifications';
import { WORKSPACE_TIMEZONE } from '@/lib/workspace';
import { IconBell, IconClose } from './icons';
import { Modal } from './modal';
import { Avatar, EmptyState } from './ui';

export function NotificationsBell({ unread }: { unread: number }) {
  const router = useRouter(); const [open,setOpen]=useState(false); const [data,setData]=useState<Awaited<ReturnType<typeof loadNotificationsAction>>|null>(null); const [pending,setPending]=useState(false); const [error,setError]=useState('');
  const load=async(after?:string)=>{setPending(true);setError('');try{const page=await loadNotificationsAction(after);setData(old=>after&&old?{...page,items:[...old.items,...page.items]}:page);}catch{setError('Notifications could not be loaded. Try again.');}finally{setPending(false);}};
  return <><button type="button" className="btn-icon-ghost relative" aria-label="Notifications" onClick={()=>{setOpen(true);void load();}}><IconBell size={18}/>{unread>0&&<span className="absolute -right-1 -top-1 rounded-full bg-brand-700 px-1.5 text-[10px] font-bold text-white">{unread>99?'99+':unread}</span>}</button>
    {open&&<Modal label="Notifications" onClose={()=>setOpen(false)}><div className="flex items-center gap-3 border-b border-line p-5"><h2 className="text-lg font-semibold">Inbox updates</h2><span className="ml-auto"/>{data&&data.items.some(i=>i.unread)&&<button className="btn-secondary btn-sm" type="button" disabled={pending} onClick={async()=>{try{await markNotificationsReadAction(data.through);setData(d=>d?{...d,items:d.items.map(i=>({...i,unread:false}))}:d);router.refresh();}catch{setError('Read status could not be saved.');}}} >Mark read</button>}<button type="button" aria-label="Close notifications" className="btn-icon-ghost" onClick={()=>setOpen(false)}><IconClose size={16}/></button></div>
    <div className="max-h-[65vh] overflow-y-auto">{error&&<div role="alert" className="p-4 text-sm text-red-700">{error}<button type="button" className="btn-secondary ml-3" onClick={()=>void load()}>Retry</button></div>}{pending&&!data&&<p role="status" className="p-5 text-sm">Loading inbox updates…</p>}{data&&!data.items.length&&<EmptyState title="No inbound emails yet"/>}{data?.items.map(item=><Link key={item.id} href={'/people/'+item.personId+'?tab=crm'} onClick={()=>setOpen(false)} className={'flex gap-3 border-b border-line p-5 hover:bg-canvas '+(item.unread?'bg-brand-50/50':'')}><Avatar name={item.name} shape="circle" size={36}/><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><strong className="text-sm">{item.name}</strong>{item.unread&&<span className="h-2 w-2 rounded-full bg-brand-600" aria-label="Unread"/>}</div><p className="mt-1 break-words text-sm font-semibold text-ink-800">{item.title}</p><time className="mt-2 block text-xs font-semibold text-ink-700">{new Intl.DateTimeFormat('en-US',{timeZone:WORKSPACE_TIMEZONE,dateStyle:'medium',timeStyle:'short'}).format(new Date(item.at))}</time></div></Link>)}{data?.next&&<button type="button" className="btn-secondary m-4" disabled={pending} onClick={()=>void load(data.next!)}>Older updates</button>}</div></Modal>}
  </>;
}
