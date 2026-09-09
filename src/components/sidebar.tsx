'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import clsx from 'clsx';
import type { SessionUser } from '@/lib/auth/current-user';
import { canViewReports, ROLE_LABELS } from '@/lib/auth/rbac';
import { logoutAction } from '@/lib/actions/auth';
import { IconActivity, IconCalendar, IconCampaigns, IconClose, IconCompany, IconHome, IconLogout, IconMenu, IconPeople, IconReports, IconSequences, IconSettings, IconTasks } from './icons';
import { Avatar } from './ui';
import { BrandMark } from './brand';
import { Modal } from './modal';

const GROUPS = [
  { label: 'Workspace', items: [
    { href: '/home', label: 'Home', icon: IconHome },
    { href: '/tasks', label: 'Tasks', icon: IconTasks },
    { href: '/accounts', label: 'Accounts', icon: IconCompany },
    { href: '/people', label: 'People', icon: IconPeople },
    { href: '/enrichment', label: 'Enrichment', icon: IconPeople },
    { href: '/meetings', label: 'Meetings', icon: IconCalendar },
  ] },
  { label: 'Engagement', items: [
    { href: '/sequences', label: 'Sequences', icon: IconSequences },
    { href: '/campaigns', label: 'Campaigns', icon: IconCampaigns },
  ] },
  { label: 'Insights', items: [
    { href: '/activity', label: 'Activity', icon: IconActivity },
    { href: '/reports', label: 'Reports', icon: IconReports },
  ] },
];

type Props = { user: SessionUser; mode: 'mock' | 'graphql'; dryRun: boolean; todayCount: number };

export function Sidebar(props: Props) {
  const [open, setOpen] = useState(false);
  return <>
    <div className="sticky top-0 hidden h-dvh shrink-0 lg:block"><SidebarContent {...props} /></div>
    <button type="button" aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen(true)} className="absolute left-3 top-3 z-20 flex h-10 w-10 items-center justify-center rounded-lg text-ink-700 hover:bg-canvas lg:hidden"><IconMenu size={20} /></button>
    {open ? <Modal label="Navigation" className="nav-drawer" onClose={() => setOpen(false)}><SidebarContent {...props} close={() => setOpen(false)} /></Modal> : null}
  </>;
}

function SidebarContent({ user, mode, dryRun, todayCount, close }: Props & { close?: () => void }) {
  const pathname = usePathname();
  return (
    <aside className="sidebar-shell">
      <div className="flex h-[88px] shrink-0 items-center gap-3 px-6">
        <BrandMark />
        <Link href="/home" onClick={close} className="text-[22px] font-semibold tracking-[-0.06em] text-white">cadence<span className="text-[#d5e9ad]">.</span></Link>
        {close ? <button type="button" onClick={close} aria-label="Close navigation" className="ml-auto rounded p-1 text-white/70 hover:text-white"><IconClose size={18} /></button> : null}
      </div>
      <nav aria-label="Main navigation" className="flex-1 space-y-6 overflow-y-auto px-3 pb-5 scroll-thin">
        {GROUPS.map((group) => <div key={group.label}>
          <div className="mb-2 px-3 text-[9px] font-semibold uppercase tracking-[0.16em] text-[#91a79d]">{group.label}</div>
          <div className="space-y-1">{group.items.filter((item) => item.href !== '/reports' || canViewReports(user)).map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + '/');
            const Icon = item.icon;
            return <Link key={item.href} href={item.href} onClick={close} aria-current={active ? 'page' : undefined} className={clsx('nav-item', active && 'nav-item-active')}>
              <Icon size={18} /> <span>{item.label}</span>
              {item.href === '/tasks' && todayCount > 0 ? <span className="ml-auto rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] tabular-nums text-[#dfefc1]">{todayCount}</span> : null}
            </Link>;
          })}</div>
        </div>)}
      </nav>
      <div className="shrink-0 px-3 pb-3">
        {user.role === 'ADMIN' ? <Link href="/settings" onClick={close} aria-current={pathname.startsWith('/settings') ? 'page' : undefined} className={clsx('nav-item mb-3', pathname.startsWith('/settings') && 'nav-item-active')}><IconSettings size={18} /> Settings</Link> : null}
        <div className="mx-1 mb-3 rounded-lg border border-white/10 px-3 py-3">
          <div className="flex items-center gap-2 text-[11px] font-medium text-[#dbe5df]"><span className={clsx('h-1.5 w-1.5 rounded-full', mode === 'mock' ? 'bg-[#d5e9ad]' : 'bg-sky-300')} />{mode === 'mock' ? 'Demo workspace' : 'Twenty workspace'}</div>
          <p className="mt-1 text-[10px] leading-relaxed text-[#9eb4a9]">{dryRun ? 'Dry run · CRM writes paused' : mode === 'mock' ? 'Explore with sample data' : 'Connected to your CRM'}</p>
        </div>
        <div className="flex items-center gap-2.5 border-t border-white/10 px-2 pt-4">
          <Avatar name={user.name} shape="circle" size={33} />
          <div className="min-w-0 flex-1"><div className="truncate text-[12px] font-medium text-white">{user.name}</div><div className="mt-0.5 truncate text-[10px] text-[#9eb4a9]">{ROLE_LABELS[user.role]}{user.pods.length ? ` · ${user.pods.map((p) => p.name).join(', ')}` : ''}</div></div>
          <form action={logoutAction}><button type="submit" title="Sign out" aria-label="Sign out" className="rounded-lg p-2 text-[#9eb4a9] hover:bg-white/10 hover:text-white"><IconLogout size={16} /></button></form>
        </div>
      </div>
    </aside>
  );
}
