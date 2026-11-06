import type { ReactNode } from 'react';
import { Surface, Tabs, ViewHeader } from '@/components/ui';
import { COLD_CAMPAIGNS_HREF, COLD_CONTACT_BASE, COLD_FROM_BELLWETHER_HREF, COLD_MOVES_HREF } from '@/lib/subject';
import { COLD_TASKS_HREF } from '@/lib/tasks-query';
import type { SessionUser } from '@/lib/auth/current-user';
import { isAdmin, isBizOps, isPodLeader } from '@/lib/auth/rbac';
import { repPath, type PathStepKey, type RepPath } from '@/lib/sandbox/path';
import { StepStrip } from './step-strip';

export type ColdOutreachTab = 'contacts' | 'work' | 'campaigns' | 'moves' | 'bellwether';

/** From Bellwether is for those who look after the pushes: leaders, Biz Ops and admins (PLAN 4.8). */
export const seesPushes = (user: SessionUser) => isAdmin(user) || isBizOps(user) || (isPodLeader(user) && user.role !== 'SENIOR_FO');

/**
 * Cold outreach's tab bar (PLAN 3): Contacts · Tasks · Campaigns · Moves to CRM · From Bellwether.
 * On the section's own pages, and on a cold campaign's pages, which live under /campaigns but
 * belong to the section (4.4).
 */
export function ColdOutreachTabs({ current, contactsHref = COLD_CONTACT_BASE, campaignsHref = COLD_CAMPAIGNS_HREF, pushes = false }: { current: ColdOutreachTab; contactsHref?: string; campaignsHref?: string; /** Show From Bellwether (leaders). */ pushes?: boolean }) {
  return <Tabs inset={false} current={current} tabs={[
    { key: 'contacts', label: 'Contacts', href: contactsHref },
    { key: 'work', label: 'Tasks', href: COLD_TASKS_HREF },
    { key: 'campaigns', label: 'Campaigns', href: campaignsHref },
    { key: 'moves', label: 'Moves to CRM', href: COLD_MOVES_HREF },
    ...(pushes ? [{ key: 'bellwether', label: 'From Bellwether', href: COLD_FROM_BELLWETHER_HREF }] : []),
  ]} />;
}

/**
 * The top of every Cold outreach page: an optional header line, the tab bar and the step strip (the
 * rep's path), so a rep always sees where they are and what waits for them.
 */
export async function ColdOutreachHeader({ user, current, title, meta, actions, contactsHref, path, step }: { user: SessionUser; current: ColdOutreachTab; title?: ReactNode; meta?: ReactNode; actions?: ReactNode; contactsHref?: string; /** Already read by the page. */ path?: RepPath; /** A contact's own step, on its page. */ step?: PathStepKey | null }) {
  const strip = path ?? (isBizOps(user) ? null : await repPath(user));
  return <Surface flush>
    {title || meta || actions ? <ViewHeader title={title ?? 'Cold outreach'} meta={meta} actions={actions} /> : null}
    <ColdOutreachTabs current={current} contactsHref={contactsHref} pushes={seesPushes(user)} />
    {strip ? <StepStrip path={strip} current={step} /> : null}
  </Surface>;
}
