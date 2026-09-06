'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import type { SessionUser } from '@/lib/auth/current-user';
import { ROLE_LABELS } from '@/lib/auth/rbac';
import { logoutAction } from '@/lib/actions/auth';
import { IconCampaigns, IconLogout, IconPeople, IconReports, IconSequences, IconSettings, IconTasks } from './icons';

const NAV = [
  { href: '/tasks', label: 'Tasks', icon: IconTasks },
  { href: '/sequences', label: 'Sequences', icon: IconSequences },
  { href: '/people', label: 'People', icon: IconPeople },
  { href: '/campaigns', label: 'Campaigns', icon: IconCampaigns },
  { href: '/reports', label: 'Reports', icon: IconReports },
  { href: '/settings', label: 'Settings', icon: IconSettings },
];

export function Sidebar({ user, mode, dryRun }: { user: SessionUser; mode: 'mock' | 'graphql'; dryRun: boolean }) {
  const pathname = usePathname();
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-900 text-slate-200">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-500 text-sm font-bold text-white">C</div>
        <div>
          <div className="text-sm font-semibold text-white">Cadence</div>
          <div className="text-[10px] uppercase tracking-wider text-slate-400">beside Twenty</div>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 px-2">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + '/');
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800/60 hover:text-white',
              )}
            >
              <Icon size={18} className={active ? 'text-brand-300' : 'text-slate-400'} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="space-y-2 border-t border-slate-800 px-4 py-3 text-xs">
        {mode === 'mock' ? (
          <div className="rounded bg-amber-500/15 px-2 py-1 text-amber-300">Mock Twenty (fixtures)</div>
        ) : null}
        {dryRun ? <div className="rounded bg-sky-500/15 px-2 py-1 text-sky-300">Dry run: no writes to Twenty</div> : null}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-white">{user.name}</div>
            <div className="truncate text-slate-400">
              {ROLE_LABELS[user.role]}
              {user.pods.length ? ` · ${user.pods.map((p) => p.name).join(', ')}` : ''}
            </div>
          </div>
          <form action={logoutAction}>
            <button type="submit" title="Sign out" className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white">
              <IconLogout size={16} />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
