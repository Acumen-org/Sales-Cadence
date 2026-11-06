import { Tabs } from '@/components/ui';
import { COLD_CAMPAIGNS_HREF, COLD_CONTACT_BASE } from '@/lib/subject';
import { COLD_TASKS_HREF } from '@/lib/tasks-query';

export type ColdOutreachTab = 'contacts' | 'work' | 'campaigns' | 'moves';

/**
 * Cold outreach's tab bar: on the section's own page, and on a cold campaign's pages, which live under
 * /campaigns but belong to the section (PLAN 3, 4.4). S10 restyles the section around it.
 */
export function ColdOutreachTabs({ current, contactsHref = COLD_CONTACT_BASE, campaignsHref = COLD_CAMPAIGNS_HREF }: { current: ColdOutreachTab; contactsHref?: string; campaignsHref?: string }) {
  return <Tabs inset={false} current={current} tabs={[
    { key: 'contacts', label: 'Contacts', href: contactsHref },
    { key: 'work', label: 'Tasks', href: COLD_TASKS_HREF },
    { key: 'campaigns', label: 'Campaigns', href: campaignsHref },
    { key: 'moves', label: 'Moves to CRM', href: `${COLD_CONTACT_BASE}?tab=moves` },
  ]} />;
}
