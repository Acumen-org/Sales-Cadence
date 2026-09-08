'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import type { SessionUser } from '@/lib/auth/current-user';
import { ROLE_LABELS } from '@/lib/auth/rbac';
import { logoutAction } from '@/lib/actions/auth';
import { IconActivity, IconCalendar, IconCampaigns, IconCompany, IconHome, IconLogout, IconPeople, IconReports, IconSequences, IconSettings, IconTasks } from './icons';
import { Avatar } from './ui';

const NAV = [
  { href: '/home', label: 'Home', icon: IconHome },
  { href: '/tasks', label: 'Tasks', icon: IconTasks },
  { href: '/accounts', label: 'Accounts', icon: IconCompany },
  { href: '/people', label: 'People', icon: IconPeople },
  { href: '/meetings', label: 'Meetings', icon: IconCalendar },
  { href: '/sequences', label: 'Sequences', icon: IconSequences },
  { href: '/campaigns', label: 'Campaigns', icon: IconCampaigns },
  { href: '/activity', label: 'Activity', icon: IconActivity },
  { href: '/reports', label: 'Reports', icon: IconReports },
];

export function Sidebar({ user, mode, dryRun }: { user: SessionUser; mode: 'mock' | 'graphql'; dryRun: boolean }) {
  const pathname = usePathname();
  const items = [...NAV, ...(user.role === 'ADMIN' ? [{ href: '/settings', label: 'Settings', icon: IconSettings }] : [])];

  return (
    <aside className="flex w-[228px] shrink-0 flex-col border-r border-line bg-[#fbfbfe]">
      <div className="flex items-center gap-2.5 px-5 py-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-[15px] font-bold text-white">C</span>
        <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink-900">Cadence</span>
      </div>

      <nav className="flex-1 space-y-0.5 px-2.5 py-1">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + '/');
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href} className={clsx('nav-item', active && 'nav-item-active')}>
              <Icon size={18} className={active ? 'text-brand-700' : 'text-ink-600'} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-2 px-3 pb-3">
        {mode === 'mock' ? <div className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-medium text-amber-800">Demo data (mock Twenty)</div> : null}
        {dryRun ? <div className="rounded-lg bg-sky-50 px-2.5 py-1.5 text-[11px] font-medium text-sky-800">Dry run: no writes to Twenty</div> : null}
        <div className="flex items-center gap-2.5 rounded-[10px] px-1.5 py-2">
          <Avatar name={user.name} shape="circle" size={30} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-ink-900">{user.name}</div>
            <div className="truncate text-[11.5px] text-ink-500">
              {ROLE_LABELS[user.role]}
              {user.pods.length ? ` · ${user.pods.map((p) => p.name).join(', ')}` : ''}
            </div>
          </div>
          <form action={logoutAction}>
            <button type="submit" title="Sign out" aria-label="Sign out" className="btn-icon-ghost h-8 w-8">
              <IconLogout size={15} />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
