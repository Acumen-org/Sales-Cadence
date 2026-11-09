import type { ReactNode } from 'react';
import Link from 'next/link';
import { COLD_OUTREACH_SETTINGS_HREF } from '@/lib/settings-tabs';
import { Surface, Tabs, ViewHeader } from '@/components/ui';
import { COLD_CAMPAIGNS_HREF, COLD_CONTACT_BASE, COLD_FROM_BELLWETHER_HREF, COLD_MOVES_HREF } from '@/lib/subject';
import type { SessionUser } from '@/lib/auth/current-user';
import { isAdmin, isBizOps, isPodLeader } from '@/lib/auth/rbac';

export type ColdOutreachTab = 'contacts' | 'campaigns' | 'moves' | 'bellwether';

/** From Bellwether is for those who look after the pushes: leaders, Biz Ops and admins (PLAN 4.8). */
export const seesPushes = (user: SessionUser) => isAdmin(user) || isBizOps(user) || (isPodLeader(user) && user.role !== 'SENIOR_FO');

/**
 * Cold outreach's tab bar: Contacts · Campaigns · Moves to CRM · From Bellwether. Cold work is done
 * from Tasks with everything else (owner, 9 Nov 2026), so the section has no Tasks tab of its own.
 * On the section's own pages, and on a cold campaign's pages, which live under /campaigns but
 * belong to the section (4.4).
 */
export function ColdOutreachTabs({ current, contactsHref = COLD_CONTACT_BASE, campaignsHref = COLD_CAMPAIGNS_HREF, pushes = false }: { current: ColdOutreachTab; contactsHref?: string; campaignsHref?: string; /** Show From Bellwether (leaders). */ pushes?: boolean }) {
  return <Tabs inset={false} current={current} tabs={[
    { key: 'contacts', label: 'Contacts', href: contactsHref },
    { key: 'campaigns', label: 'Campaigns', href: campaignsHref },
    { key: 'moves', label: 'Moves to CRM', href: COLD_MOVES_HREF },
    ...(pushes ? [{ key: 'bellwether', label: 'From Bellwether', href: COLD_FROM_BELLWETHER_HREF }] : []),
  ]} />;
}

/**
 * The top of every Cold outreach page: an optional header line and the tab bar. The step strip that
 * sat under it is gone (owner, 9 Nov 2026); the contacts list's quick views carry its counts.
 */
export function ColdOutreachHeader({ user, current, title, meta, actions, contactsHref }: { user: SessionUser; current: ColdOutreachTab; title?: ReactNode; meta?: ReactNode; actions?: ReactNode; contactsHref?: string }) {
  return <Surface flush>
    {title || meta || actions ? <ViewHeader title={title ?? 'Cold outreach'} meta={meta} actions={actions} /> : null}
    <div className="flex items-stretch">
      <div className="min-w-0 flex-1"><ColdOutreachTabs current={current} contactsHref={contactsHref} pushes={seesPushes(user)} /></div>
      {/* B215: the section's settings, read only for everyone but admins, who may change them. */}
      <Link href={COLD_OUTREACH_SETTINGS_HREF} className="flex shrink-0 items-center border-b border-line px-3 text-[12.5px] text-ink-500 hover:text-ink-800 sm:px-5">Settings</Link>
    </div>
  </Surface>;
}
